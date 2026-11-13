import { afterEach, beforeEach, expect, it, vi } from "vitest";
const complete = vi.fn();
vi.mock("@oneshot-gtm/intel", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel")),
  complete: (...args: unknown[]) => complete(...args),
}));
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  tryReserveDailySpend: () => ({ granted: true, release: () => {} }),
}));
const { getLedger, getReplyReviewStore, loadConfig, saveConfig } =
  await import("@oneshot-gtm/core");
const { expireLearningProposals } = await import("../src/learning-expiry.ts");
const { refreshReplyLearning } = await import("../src/reply-learning.ts");
const ledger = getLedger();
const ldb = (ledger as unknown as { db: { exec: (sql: string) => void } }).db;
const store = getReplyReviewStore();

// The scheduler's sweep retires learning proposals nobody will decide: past
// `learning.expireAfterDays` (7 by default), a prospect angle whose prospect
// has nothing left to draft, a LinkedIn preference no templated draft reads.

const NOW = Date.parse("2026-10-20T00:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const insert = (instruction: string, createdAt: string, stage: "reply" | "first_touch" = "reply") =>
  ledger.learning.insert({
    kind: "preference",
    scope: { channel: "email", stage },
    current: null,
    proposed: { instruction, source: "explicit" },
    evidence: { refs: [] },
    evidenceSummary: "",
    baselineKey: "",
    dedupeKey: `email:${stage}:${instruction.toLowerCase()}`,
    createdAt,
  })!;
const status = (id: string) => ledger.learning.get(id)?.status;

const original = loadConfig();
beforeEach(() => {
  for (const table of ["learning_proposals", "learning_jobs", "learning_guidance"])
    ldb.exec(`DELETE FROM ${table}`);
  store.db.exec("DELETE FROM reply_learning_observations; DELETE FROM reply_learning_state");
  saveConfig(original);
});
afterEach(() => {
  saveConfig(original);
  vi.restoreAllMocks();
});

it("retires what waited more than seven days, and nothing newer", () => {
  const old = insert("Keep replies concise", daysAgo(8));
  const recent = insert("Open with the question", daysAgo(6), "first_touch");
  expect(expireLearningProposals(NOW)).toBe(1);
  expect(ledger.learning.get(old.id)).toMatchObject({
    status: "stale",
    decided: { reason: "expired" },
  });
  expect(status(recent.id)).toBe("pending");
  expect(expireLearningProposals(NOW)).toBe(0);
});

it("reads learning.expireAfterDays, and falls back to seven on a bad value", () => {
  const row = insert("Keep replies concise", daysAgo(4));
  saveConfig({ ...original, learning: { expireAfterDays: 0 } });
  expect(expireLearningProposals(NOW)).toBe(0);
  saveConfig({ ...original, learning: { expireAfterDays: 3 } });
  expect(expireLearningProposals(NOW)).toBe(1);
  expect(status(row.id)).toBe("stale");
});

it("an expired proposal is not raised again", async () => {
  // Raised for first touches; still pending, it would not stop the same text for replies.
  insert("Keep replies concise.", daysAgo(8), "first_touch");
  expireLearningProposals(NOW);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  store.db.query("INSERT INTO reply_learning_observations(id,workspace,data) VALUES(?,?,?)").run(
    "send-1",
    "default",
    JSON.stringify({
      id: "send-1",
      channel: "email",
      workspace: "default",
      threadKey: "t1",
      name: "Ada",
      original: "long",
      body: "short",
      historical: false,
      feedback: ["In general, keep replies concise"],
      learningVersion: 0,
      move: "answer",
      at: new Date(NOW).toISOString(),
    }),
  );
  complete.mockResolvedValue({
    content: JSON.stringify({
      preferences: [
        {
          key: "concise",
          instruction: "Keep replies concise.",
          source: "explicit",
          evidenceIds: ["send-1"],
        },
      ],
    }),
  });
  await refreshReplyLearning();
  expect(complete).toHaveBeenCalledTimes(1);
  expect(ledger.learning.list({ kind: "preference", status: "pending" })).toEqual([]);
});

it("retires LinkedIn first-touch and follow-up preferences only while LinkedIn copy is templates", () => {
  const linkedin = (stage: "first_touch" | "follow_up") =>
    ledger.learning.insert({
      kind: "preference",
      scope: { channel: "linkedin", stage },
      current: null,
      proposed: { instruction: `a ${stage} habit`, source: "style" },
      evidence: { refs: [] },
      evidenceSummary: "",
      baselineKey: "",
      dedupeKey: `linkedin:${stage}`,
      createdAt: daysAgo(1),
    })!;
  const rows = [linkedin("first_touch"), linkedin("follow_up")];
  saveConfig({ ...original, linkedin: { writer: "model" } });
  expect(expireLearningProposals(NOW)).toBe(0);
  saveConfig({ ...original, linkedin: {} });
  expect(expireLearningProposals(NOW)).toBe(2);
  expect(rows.map((p) => ledger.learning.get(p.id)?.decided)).toEqual([
    { reason: "template" },
    { reason: "template" },
  ]);
});
