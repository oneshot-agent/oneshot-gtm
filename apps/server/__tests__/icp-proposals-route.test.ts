import { beforeEach, expect, it, vi } from "vitest";
let demo = false;
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  demoMode: () => demo,
}));
const { getLedger, loadConfig, saveConfig, normalizeIcpText } = await import("@oneshot-gtm/core");
const { approveIcpProposalRoute, dismissIcpProposalRoute, listIcpProposalsRoute } =
  await import("../src/api/icp-proposals.ts");
const ledger = getLedger();
const req = new Request("http://localhost/api/icp-proposals", { method: "POST" });
const seed = (proposed = "new ICP") =>
  ledger.learning.insert({
    kind: "icp",
    current: "old ICP",
    proposed,
    evidence: { refs: [] },
    evidenceSummary: "fit",
    baselineKey: normalizeIcpText("old ICP"),
    dedupeKey: proposed,
  })!;
beforeEach(() => {
  demo = false;
  ledger.learning.db.exec("DELETE FROM learning_proposals; DELETE FROM learning_applications");
  saveConfig({ ...loadConfig(), icpOneLiner: "old ICP" });
});
it("lists pending proposals and includes decided history only on request", async () => {
  const p = seed();
  const second = seed("another ICP");
  dismissIcpProposalRoute(req, { id: p.id });
  expect(
    (await listIcpProposalsRoute(new Request(req.url)).json()).proposals.map(
      (p: { id: string }) => p.id,
    ),
  ).toEqual([second.id]);
  expect(
    (await listIcpProposalsRoute(new Request(req.url + "?status=all")).json()).proposals,
  ).toHaveLength(2);
});
it("approves through shared state and refuses a repeat", async () => {
  const p = seed();
  const sibling = seed("another ICP");
  expect(await approveIcpProposalRoute(req, { id: p.id }).json()).toEqual({
    ok: true,
    icpOneLiner: "new ICP",
  });
  expect(ledger.learning.get(sibling.id)?.status).toBe("stale");
  expect(approveIcpProposalRoute(req, { id: p.id }).status).toBe(409);
});
it("refuses stale baselines, unknown IDs and non-ICP proposals", () => {
  const p = seed();
  saveConfig({ ...loadConfig(), icpOneLiner: "manual" });
  expect(approveIcpProposalRoute(req, { id: p.id }).status).toBe(409);
  expect(approveIcpProposalRoute(req, { id: "missing" }).status).toBe(409);
  const other = ledger.learning.insert({
    kind: "preference",
    current: null,
    proposed: { instruction: "brief" },
    evidence: { refs: [] },
    evidenceSummary: "",
    baselineKey: "",
    dedupeKey: "brief",
  })!;
  expect(approveIcpProposalRoute(req, { id: other.id }).status).toBe(409);
});
it("dismissal leaves config unchanged", () => {
  const p = seed();
  expect(dismissIcpProposalRoute(req, { id: p.id }).status).toBe(200);
  expect(loadConfig().icpOneLiner).toBe("old ICP");
  expect(dismissIcpProposalRoute(req, { id: p.id }).status).toBe(409);
});
it("refuses both compatibility mutations in the demo", () => {
  const p = seed();
  demo = true;
  expect(approveIcpProposalRoute(req, { id: p.id }).status).toBe(403);
  expect(dismissIcpProposalRoute(req, { id: p.id }).status).toBe(403);
  expect(ledger.learning.get(p.id)?.status).toBe("pending");
});
