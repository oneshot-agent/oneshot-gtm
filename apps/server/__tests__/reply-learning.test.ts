import { beforeEach, afterEach, expect, it, vi } from "vitest";
const complete = vi.fn();
const reserve = vi.fn();
const release = vi.fn();
vi.mock("@oneshot-gtm/intel", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel")),
  complete: (...args: unknown[]) => complete(...args),
}));
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  tryReserveDailySpend: (...args: unknown[]) => reserve(...args),
}));
const { getLedger, getReplyReviewStore, getLinkedInInboxStore } = await import("@oneshot-gtm/core");
const { refreshReplyLearning, REPLY_LEARNING_PROMPT } = await import("../src/reply-learning.ts");
const store = getReplyReviewStore();
const ledger = getLedger();
const ldb = (ledger as unknown as { db: { exec: (sql: string) => void } }).db;
const now = 2_000_000_000_000;

// Writing-preference learning (#813): the job reads reply sends on both
// channels and reviewed first touches, and writes PENDING proposals. Nothing
// it produces reaches a draft until the founder approves it on /queue.

function seed(id = "send-1", workspace = "default", channel: "linkedin" | "email" = "linkedin") {
  store.db.query("INSERT INTO reply_learning_observations(id,workspace,data) VALUES(?,?,?)").run(
    id,
    workspace,
    JSON.stringify({
      id,
      channel,
      workspace,
      threadKey: id,
      name: "Ada",
      original: "long",
      body: "short",
      historical: false,
      feedback: ["In general, keep replies concise"],
      learningVersion: 0,
      move: "answer",
      at: new Date(now).toISOString(),
    }),
  );
}
/** `n` reviewed first touches, each sent after one regenerated draft. */
function seedDrafts(n: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = ledger.enqueueTarget({
      playName: "show-hn",
      payload: {
        title: `Signal ${i}`,
        email: `p${i}-${Math.random().toString(36).slice(2)}@x.dev`,
      },
      dedupeKey: `draft-${i}-${Math.random().toString(36).slice(2)}`,
      source: "find:show-hn",
    })!;
    const base = { subject: "Hi", flags: [], sent: false, receiptIds: [], dryRun: false };
    ledger.setQueueDraft({ id, draft: { ...base, body: "machine v1" } });
    ledger.setQueueDraft({
      id,
      draft: { ...base, body: "machine v2" },
      discardReason: "regenerate",
    });
    ledger.setQueueDraft({
      id,
      draft: { ...base, body: "machine v2", sent: true },
      sentBy: "human",
    });
    ids.push(ledger.draftVersionsFor({ queueId: id }).find((v) => v.outcome === "sent")!.id);
  }
  return ids;
}
const pending = () => ledger.learning.list({ kind: "preference", status: "pending" });
const modelSays = (preferences: unknown[]) =>
  complete.mockReset().mockResolvedValue({ content: JSON.stringify({ preferences }) });

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  for (const table of [
    "reply_learning_state",
    "reply_learning_preferences",
    "reply_learning_observations",
    "reply_learning_artifacts",
    "review_sends",
    "review_threads",
  ])
    store.db.exec(`DELETE FROM ${table}`);
  for (const table of [
    "learning_proposals",
    "learning_guidance",
    "learning_jobs",
    "learning_state",
    "draft_versions",
    "target_queue",
  ])
    ldb.exec(`DELETE FROM ${table}`);
  const inbox = getLinkedInInboxStore();
  inbox.db.exec("DELETE FROM accounts; DELETE FROM conversations; DELETE FROM assignments");
  modelSays([
    {
      key: "concise",
      instruction: "Keep replies concise.",
      source: "explicit",
      evidenceIds: ["send-1"],
    },
  ]);
  release.mockReset();
  reserve.mockReset().mockReturnValue({ granted: true, release });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("proposes a pending preference scoped to the cited channel and never applies it", async () => {
  seed();
  seed("other", "other");
  await refreshReplyLearning();
  const rows = pending();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    kind: "preference",
    scope: { channel: "linkedin", stage: "reply" },
    proposed: { instruction: "Keep replies concise.", source: "explicit" },
    evidence: {
      refs: [{ type: "reply_send", id: "send-1" }],
      counts: { threads: 1 },
      method: "explicit",
    },
    legacy: false,
  });
  expect(rows[0]!.evidence.samples?.[0]).toMatchObject({ sent: "short", original: "long" });
  expect(ledger.learning.guidance({ channel: "linkedin", stage: "reply" }).instructions).toEqual(
    [],
  );
  const data = JSON.parse(complete.mock.calls[0]![0].messages[1].content);
  expect(data.observations).toHaveLength(1);
  expect(data.observations[0]).toMatchObject({ channel: "linkedin", stage: "reply" });
  expect(data).toMatchObject({ approvedGuidance: [], excludedInstructions: [] });
  expect(REPLY_LEARNING_PROMPT).toContain("NEVER propose equivalent or paraphrased");
  expect(REPLY_LEARNING_PROMPT).toContain("stays local");
  expect(release).toHaveBeenCalledTimes(1);
  expect(store.learning.status("default").pending).toBe(false);
});

it("leaves the scope open when the evidence spans email and LinkedIn", async () => {
  seed("send-1", "default", "linkedin");
  seed("send-2", "default", "email");
  modelSays([
    {
      key: "concise",
      instruction: "Keep replies concise.",
      source: "explicit",
      evidenceIds: ["send-1", "send-2"],
    },
  ]);
  await refreshReplyLearning();
  expect(pending()[0]!.scope).toEqual({ stage: "reply" });
});

it("imports v1 preferences as legacy proposals once: enabled rows pending, disabled rows dismissed", async () => {
  seed();
  store.db
    .query("INSERT INTO reply_learning_preferences VALUES(?,?,?,?,?,?)")
    .run("default", "plain", "Keep language plain.", "edits", 1, JSON.stringify(["send-1"]));
  store.db
    .query("INSERT INTO reply_learning_preferences VALUES(?,?,?,?,?,?)")
    .run("default", "no-emoji", "Avoid emoji.", "explicit", 0, "[]");
  store.db
    .query("INSERT INTO reply_learning_preferences VALUES(?,?,?,?,?,?)")
    .run("other", "private", "Private guidance", "explicit", 1, "[]");
  modelSays([]);
  await refreshReplyLearning();
  const all = ledger.learning.list({ kind: "preference", status: "all" });
  expect(
    all
      .filter((p) => p.legacy)
      .map((p) => [p.status, (p.proposed as { instruction: string }).instruction]),
  ).toEqual(
    expect.arrayContaining([
      ["pending", "Keep language plain."],
      ["dismissed", "Avoid emoji."],
    ]),
  );
  expect(all.filter((p) => p.legacy)).toHaveLength(2);
  expect(all.find((p) => p.legacy && p.status === "pending")?.evidence.refs).toEqual([
    { type: "reply_send", id: "send-1" },
  ]);
  // The model saw the dismissed text as an exclusion.
  const data = JSON.parse(complete.mock.calls[0]![0].messages[1].content);
  expect(data.excludedInstructions).toEqual(["avoid emoji"]);
  // Never applied, never repeated.
  expect(ledger.learning.listGuidance(true)).toEqual([]);
  vi.mocked(Date.now).mockReturnValue(now + 300_000);
  seed("send-2");
  await refreshReplyLearning();
  expect(
    ledger.learning.list({ kind: "preference", status: "all" }).filter((p) => p.legacy),
  ).toHaveLength(2);
});

it("skips a text the founder dismissed, one already pending, and one already approved", async () => {
  seed();
  const dismissed = ledger.learning.insert({
    kind: "preference",
    scope: { stage: "reply" },
    current: null,
    proposed: { instruction: "Keep replies concise", source: "explicit" },
    evidence: { refs: [] },
    evidenceSummary: "x",
    baselineKey: "",
    dedupeKey: "keep replies concise",
  })!;
  ledger.learning.decide(dismissed.id, "dismissed", new Date(now).toISOString());
  await refreshReplyLearning();
  expect(pending()).toEqual([]);
  // Approved guidance with the same text is not re-proposed either.
  ledger.learning.addGuidance({ instruction: "Keep replies concise!", source: "explicit" });
  vi.mocked(Date.now).mockReturnValue(now + 300_000);
  seed("send-2");
  await refreshReplyLearning();
  expect(pending()).toEqual([]);
  const data = JSON.parse(complete.mock.calls[1]![0].messages[1].content);
  expect(data.approvedGuidance[0]).toMatchObject({
    instruction: "Keep replies concise!",
    enabled: true,
  });
});

it("proposes style guidance from reviewed first touches next to their regenerated drafts", async () => {
  const ids = seedDrafts(5);
  modelSays([
    {
      key: "no-greeting",
      instruction: "Open with the point, not a greeting.",
      source: "style",
      evidenceIds: ids.map((id) => `draft:${id}`),
    },
    // Draft evidence can never make an edits preference.
    {
      key: "bogus",
      instruction: "Bogus.",
      source: "edits",
      evidenceIds: ids.map((id) => `draft:${id}`),
    },
  ]);
  await refreshReplyLearning();
  const rows = pending();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    scope: { channel: "email", stage: "first_touch" },
    proposed: { instruction: "Open with the point, not a greeting.", source: "style" },
    evidence: { counts: { prospects: 5, rejectedDrafts: 5 }, method: "style" },
  });
  expect(rows[0]!.evidence.refs).toHaveLength(5);
  expect(rows[0]!.evidence.samples?.[0]).toMatchObject({
    original: "machine v1",
    sent: "machine v2",
  });
  const data = JSON.parse(complete.mock.calls[0]![0].messages[1].content);
  expect(data.observations[0]).toMatchObject({
    stage: "first_touch",
    rejectedDrafts: ["machine v1"],
    sent: "machine v2",
  });
  expect(ledger.learning.jobState("preference").watermark).toBe(Math.max(...ids));
  // Nothing new: the next eligible tick spends no model call.
  vi.mocked(Date.now).mockReturnValue(now + 300_000);
  await refreshReplyLearning();
  expect(complete).toHaveBeenCalledTimes(1);
});

it("a paused workspace never spends on draft evidence either", async () => {
  seedDrafts(5);
  store.learning.setEnabled("default", false);
  await refreshReplyLearning();
  expect(reserve).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  expect(ledger.learning.jobState("preference").watermark).toBe(0);
  store.learning.setEnabled("default", true);
  vi.mocked(Date.now).mockReturnValue(now + 300_000);
  modelSays([]);
  await refreshReplyLearning();
  expect(complete).toHaveBeenCalledTimes(1);
});

it("keeps older sends in the window so the five-prospect rule can be met across batches", async () => {
  const first = seedDrafts(4);
  modelSays([]);
  await refreshReplyLearning();
  expect(ledger.learning.jobState("preference").watermark).toBe(Math.max(...first));
  vi.mocked(Date.now).mockReturnValue(now + 300_000);
  const fifth = seedDrafts(1);
  const all = [...first, ...fifth];
  modelSays([
    {
      key: "no-greeting",
      instruction: "Open with the point, not a greeting.",
      source: "style",
      evidenceIds: all.map((id) => `draft:${id}`),
    },
  ]);
  await refreshReplyLearning();
  // modelSays reset the call list: this run's call is the first recorded.
  const sent = JSON.parse(complete.mock.calls[0]![0].messages[1].content);
  expect(sent.observations).toHaveLength(5);
  expect(pending()).toHaveLength(1);
  expect(ledger.learning.jobState("preference").watermark).toBe(Math.max(...fifth));
});

it("a pause that lands while the model call is in flight stops draft proposals and leaves the watermark", async () => {
  const ids = seedDrafts(5);
  complete.mockReset().mockImplementation(async () => {
    store.learning.setEnabled("default", false);
    return {
      content: JSON.stringify({
        preferences: [
          {
            key: "k",
            instruction: "Open with the point.",
            source: "style",
            evidenceIds: ids.map((id) => `draft:${id}`),
          },
        ],
      }),
    };
  });
  await refreshReplyLearning();
  expect(pending()).toEqual([]);
  expect(ledger.learning.jobState("preference")).toMatchObject({ watermark: 0, token: null });
});

it("needs five distinct prospects for a style preference from drafts", async () => {
  const ids = seedDrafts(4);
  modelSays([
    {
      key: "thin",
      instruction: "Thin evidence.",
      source: "style",
      evidenceIds: ids.map((id) => `draft:${id}`),
    },
  ]);
  await refreshReplyLearning();
  expect(pending()).toEqual([]);
});

it("keeps evidence pending on malformed output and retries after the persistent cooldown", async () => {
  seed();
  complete.mockResolvedValueOnce({ content: "bad output with private text" });
  await refreshReplyLearning();
  expect(store.learning.status("default")).toMatchObject({
    pending: true,
    error: "Could not refresh writing preferences; will retry.",
  });
  await refreshReplyLearning();
  expect(complete).toHaveBeenCalledTimes(1);
  vi.mocked(Date.now).mockReturnValue(now + 300_000);
  await refreshReplyLearning();
  expect(store.learning.status("default")).toMatchObject({ pending: false, error: null });
  expect(pending()).toHaveLength(1);
});

it("does not spend while paused or capped and keeps existing proposals on failure", async () => {
  seed();
  store.learning.setEnabled("default", false);
  await refreshReplyLearning();
  expect(reserve).not.toHaveBeenCalled();
  store.learning.setEnabled("default", true);
  reserve.mockReturnValue({ granted: false, reason: "cap" });
  await refreshReplyLearning();
  expect(complete).not.toHaveBeenCalled();
  expect(store.learning.status("default").pending).toBe(true);
  vi.mocked(Date.now).mockReturnValue(now + 300_000);
  reserve.mockReturnValue({ granted: true, release });
  await refreshReplyLearning();
  expect(pending()).toHaveLength(1);
  seed("new");
  vi.mocked(Date.now).mockReturnValue(now + 600_000);
  complete.mockRejectedValue(new Error("provider failed private text"));
  await refreshReplyLearning();
  expect(pending()).toHaveLength(1);
  expect(store.learning.status("default").pending).toBe(true);
});

it("does not consume evidence arriving during synthesis", async () => {
  seed();
  complete.mockImplementation(async () => {
    seed("new");
    return { content: '{"preferences":[]}' };
  });
  await refreshReplyLearning();
  expect(store.learning.status("default").pending).toBe(true);
});

it("renews the persisted lease through slow provider retries and prevents a second reservation", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  seed();
  let resolve!: (value: { content: string }) => void;
  complete.mockImplementation(
    () =>
      new Promise<{ content: string }>((r) => {
        resolve = r;
      }),
  );
  const running = refreshReplyLearning();
  try {
    for (let elapsed = 60_000; elapsed <= 360_000; elapsed += 60_000) {
      vi.mocked(Date.now).mockReturnValue(now + elapsed);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    await refreshReplyLearning();
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    resolve({ content: '{"preferences":[]}' });
    await running;
    expect(store.learning.status("default").pending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    resolve({ content: '{"preferences":[]}' });
    await running;
  }
});

it("separates mixed-stage evidence and never grants reply guidance from outbound drafts", async () => {
  const first = seedDrafts(5);
  const follow = seedDrafts(5);
  for (const id of follow)
    ledger.learning.db.query("UPDATE draft_versions SET step_index=1 WHERE id=?").run(id);
  modelSays([
    {
      key: "brief",
      instruction: "Keep it brief",
      source: "style",
      evidenceIds: [...first, ...follow].map((id) => `draft:${id}`),
    },
  ]);
  await refreshReplyLearning();
  expect(
    pending()
      .map((p) => p.scope.stage)
      .toSorted(),
  ).toEqual(["first_touch", "follow_up"]);
  expect(pending().every((p) => p.scope.channel === "email")).toBe(true);
  expect(ledger.learning.guidance({ channel: "email", stage: "reply" }).instructions).toEqual([]);
});
