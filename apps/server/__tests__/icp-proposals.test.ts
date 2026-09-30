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
function seedDecisions(n: number): void {
  for (let i = 0; i < n; i++) {
    const id = ledger.enqueueTarget({
      playName: "show-hn",
      payload: { title: `Signal ${i}` },
      dedupeKey: `icp-proposal-seed-${i}-${Math.random().toString(36).slice(2)}`,
      source: "find:show-hn",
    });
    if (id != null) ledger.setQueueStatus({ id, status: "approved", decidedBy: "human" });
  }
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  for (const table of ["icp_proposal_state", "icp_proposals", "target_queue"]) {
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
