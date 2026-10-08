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
const { getLedger, loadConfig, saveConfig } = await import("@oneshot-gtm/core");
const { refreshIcpProposal } = await import("../src/icp-proposals.ts");

const ledger = getLedger();
const now = 2_000_000_000_000;

/** Seeds `n` human-decided rows on an ICP-eligible play so the evidence floor is met. */
function seedDecisions(n: number, decisionReason: "fit" | "bad_timing" | null = "fit"): void {
  for (let i = 0; i < n; i++) {
    const id = ledger.enqueueTarget({
      playName: "show-hn",
      payload: { title: `Signal ${i}` },
      dedupeKey: `icp-proposal-seed-${i}-${Math.random().toString(36).slice(2)}`,
      source: "find:show-hn",
    });
    if (id != null)
      ledger.setQueueStatus({ id, status: "approved", decidedBy: "human", decisionReason });
  }
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  for (const table of [
    "learning_jobs",
    "learning_proposals",
    "target_queue",
    "deal_outcomes",
    "prospects",
  ]) {
    (ledger as unknown as { db: { exec: (sql: string) => void } }).db.exec(`DELETE FROM ${table}`);
  }
  saveConfig({ ...loadConfig(), icpOneLiner: "B2B fintech founders", icpProposalMinDecisions: 3 });
  complete.mockReset().mockResolvedValue({
    content: JSON.stringify({
      proposedIcp: "B2B fintech CTOs at Series A startups",
      evidenceSummary: "Recent approvals skew toward technical buyers.",
    }),
  });
  release.mockReset();
  reserve.mockReset().mockReturnValue({ granted: true, release });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("does not call the model and produces no proposal when evidence is insufficient", async () => {
  seedDecisions(2); // below the configured floor of 3
  await refreshIcpProposal();
  expect(complete).not.toHaveBeenCalled();
  expect(ledger.icpProposals.list()).toEqual([]);
});

it("generates and persists a pending proposal once the evidence floor is met", async () => {
  seedDecisions(3);
  await refreshIcpProposal();
  expect(complete).toHaveBeenCalledTimes(1);
  const pending = ledger.icpProposals.list("pending");
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({
    currentIcp: "B2B fintech founders",
    proposedIcp: "B2B fintech CTOs at Series A startups",
    evidenceSummary: "Recent approvals skew toward technical buyers.",
  });
  expect(release).toHaveBeenCalledTimes(1);
});

it("is rate-limited: a second call inside the cooldown neither spends nor calls the model again", async () => {
  seedDecisions(3);
  await refreshIcpProposal();
  expect(complete).toHaveBeenCalledTimes(1);
  await refreshIcpProposal();
  expect(complete).toHaveBeenCalledTimes(1);
  expect(ledger.icpProposals.list()).toHaveLength(1);
});

it("never touches config on a model failure, and releases the lease for a later retry", async () => {
  seedDecisions(3);
  complete.mockRejectedValue(new Error("provider failed private text"));
  const before = loadConfig().icpOneLiner;
  await refreshIcpProposal();
  expect(loadConfig().icpOneLiner).toBe(before);
  expect(ledger.icpProposals.list()).toEqual([]);
  expect(release).toHaveBeenCalledTimes(1);
  // Cooldown still applies immediately after a failure...
  vi.mocked(Date.now).mockReturnValue(now + 1_000);
  await refreshIcpProposal();
  expect(complete).toHaveBeenCalledTimes(1);
  // ...but clears after the 24h cooldown window.
  vi.mocked(Date.now).mockReturnValue(now + 24 * 60 * 60_000);
  await refreshIcpProposal();
  expect(complete).toHaveBeenCalledTimes(2);
});

it("does not spend or call the model when the daily cap is exhausted", async () => {
  seedDecisions(3);
  reserve.mockReturnValue({ granted: false, reason: "cap" });
  await refreshIcpProposal();
  expect(complete).not.toHaveBeenCalled();
  expect(ledger.icpProposals.list()).toEqual([]);
});

it("skips a duplicate of an already-pending proposal", async () => {
  seedDecisions(3);
  await refreshIcpProposal();
  expect(ledger.icpProposals.list("pending")).toHaveLength(1);
  vi.mocked(Date.now).mockReturnValue(now + 24 * 60 * 60_000);
  await refreshIcpProposal();
  // The model proposed the identical text again; must not insert a duplicate pending row.
  expect(ledger.icpProposals.list("pending")).toHaveLength(1);
});

it("does not re-propose the same text immediately after the founder dismissed it", async () => {
  seedDecisions(3);
  await refreshIcpProposal();
  const pending = ledger.icpProposals.list("pending");
  ledger.icpProposals.decide(pending[0]!.id, "dismissed", new Date(now).toISOString());
  vi.mocked(Date.now).mockReturnValue(now + 24 * 60 * 60_000);
  await refreshIcpProposal();
  expect(ledger.icpProposals.list("pending")).toEqual([]);
});

it("does nothing when there is no active ICP configured yet", async () => {
  saveConfig({ ...loadConfig(), icpOneLiner: "" });
  seedDecisions(3);
  await refreshIcpProposal();
  expect(complete).not.toHaveBeenCalled();
  expect(ledger.icpProposals.list()).toEqual([]);
});

it("does not count decisions made without a fit reason, however many there are (#813)", async () => {
  seedDecisions(3, null);
  seedDecisions(3, "bad_timing");
  await refreshIcpProposal();
  expect(complete).not.toHaveBeenCalled();
  seedDecisions(3, "fit");
  await refreshIcpProposal();
  expect(complete).toHaveBeenCalledTimes(1);
  const data = JSON.parse(complete.mock.calls[0]![0].messages[1].content);
  expect(data.decisions).toHaveLength(3);
  expect(data.decisions.every((d: { decisionReason: string }) => d.decisionReason === "fit")).toBe(
    true,
  );
  const proposal = ledger.learning.list({ kind: "icp", status: "pending" })[0]!;
  expect(proposal.evidence.counts).toEqual({
    fit_decisions: 3,
    qualified_outcomes: 0,
    unreasoned_decisions_excluded: 6,
  });
});

it("passes qualified outcomes under their own key, separate from approvals", async () => {
  seedDecisions(3);
  const pid = ledger.upsertProspect({ email: "won@example.com", name: "Won", company: "Won Co" });
  const q = ledger.enqueueTarget({
    playName: "show-hn",
    payload: { title: "Won ships", email: "won@example.com" },
    dedupeKey: `won-${Math.random().toString(36).slice(2)}`,
    source: "find:show-hn",
  })!;
  (ledger as unknown as { db: { exec: (sql: string) => void } }).db.exec(
    `UPDATE target_queue SET prospect_id = ${pid} WHERE id = ${q}`,
  );
  ledger.recordOutcome({ prospectId: pid, outcome: "deal_won" });
  ledger.recordOutcome({ prospectId: pid, outcome: "ghosted" });
  await refreshIcpProposal();
  const data = JSON.parse(complete.mock.calls[0]![0].messages[1].content);
  expect(data.outcomes).toEqual([{ candidate: { title: "Won ships" }, outcome: "deal_won" }]);
  expect(data.decisions).toHaveLength(3);
  expect(
    ledger.learning.list({ kind: "icp", status: "pending" })[0]!.evidence.counts,
  ).toMatchObject({
    qualified_outcomes: 1,
  });
});
