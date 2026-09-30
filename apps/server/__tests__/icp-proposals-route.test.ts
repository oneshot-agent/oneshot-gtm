import { beforeEach, describe, expect, it, vi } from "vitest";

// GET /api/icp-proposals lists proposals (defaulting to pending); the
// approve/dismiss routes atomically flip status and, on approval only,
// update the active ICP. A config-write failure on approval must revert the
// proposal to pending rather than leave a recorded approval that never
// actually took effect.

const proposals = new Map<string, Record<string, unknown>>();
const decideCalls: Array<{ id: string; status: string }> = [];
const revertCalls: string[] = [];
const dismissStaleCalls: string[] = [];
let saveConfigImpl: (cfg: Record<string, unknown>) => void = () => {};
let currentConfig: Record<string, unknown> = { icpOneLiner: "old ICP" };

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => currentConfig,
    saveConfig: (cfg: Record<string, unknown>) => saveConfigImpl(cfg),
    logEvent: () => {},
    getLedger: () => ({
      icpProposals: {
        list: (status?: string) => {
          const all = [...proposals.values()];
          return status ? all.filter((p) => p["status"] === status) : all;
        },
        get: (id: string) => proposals.get(id) ?? null,
        decide: (id: string, status: "approved" | "dismissed", now: string) => {
          decideCalls.push({ id, status });
          const row = proposals.get(id);
          if (!row) return { error: `proposal '${id}' not found` };
          if (row["status"] !== "pending") {
            return { error: `proposal '${id}' was already ${row["status"] as string}` };
          }
          row["status"] = status;
          row["decidedAt"] = now;
          return { view: { ...row } };
        },
        revertToPending: (id: string) => {
          revertCalls.push(id);
          const row = proposals.get(id);
          if (row) {
            row["status"] = "pending";
            row["decidedAt"] = null;
          }
        },
        dismissStalePending: (now: string) => {
          dismissStaleCalls.push(now);
          for (const row of proposals.values()) {
            if (row["status"] === "pending") {
              row["status"] = "dismissed";
              row["decidedAt"] = now;
            }
          }
        },
      },
    }),
  };
});

const { listIcpProposalsRoute, approveIcpProposalRoute, dismissIcpProposalRoute } =
  await import("../src/api/icp-proposals.ts");

function seed(id: string, status = "pending", proposedIcp = "Tighter ICP"): void {
  proposals.set(id, {
    id,
    currentIcp: "old ICP",
    proposedIcp,
    evidenceSummary: "evidence",
    createdAt: "2026-09-29T00:00:00Z",
    status,
    decidedAt: null,
  });
}

beforeEach(() => {
  proposals.clear();
  decideCalls.length = 0;
  revertCalls.length = 0;
  dismissStaleCalls.length = 0;
  currentConfig = { icpOneLiner: "old ICP" };
  saveConfigImpl = (cfg) => {
    currentConfig = cfg;
  };
});

describe("listIcpProposalsRoute", () => {
  it("defaults to pending only", async () => {
    seed("a", "pending");
    seed("b", "approved");
    const res = listIcpProposalsRoute(new Request("http://x/api/icp-proposals"));
    const body = (await res.json()) as { proposals: Array<{ id: string }> };
    expect(body.proposals.map((p) => p.id)).toEqual(["a"]);
  });

  it("?status=all returns the full history", async () => {
    seed("a", "pending");
    seed("b", "approved");
    seed("c", "dismissed");
    const res = listIcpProposalsRoute(new Request("http://x/api/icp-proposals?status=all"));
    const body = (await res.json()) as { proposals: Array<{ id: string }> };
    expect(body.proposals.map((p) => p.id).toSorted()).toEqual(["a", "b", "c"]);
  });

  it("?status=approved / dismissed narrow explicitly; anything else falls back to pending", async () => {
    seed("a", "pending");
    seed("b", "approved");
    const approved = await (
      await listIcpProposalsRoute(new Request("http://x/api/icp-proposals?status=approved"))
    ).json();
    expect((approved as { proposals: Array<{ id: string }> }).proposals.map((p) => p.id)).toEqual([
      "b",
    ]);
    const garbage = await (
      await listIcpProposalsRoute(new Request("http://x/api/icp-proposals?status=nonsense"))
    ).json();
    expect((garbage as { proposals: Array<{ id: string }> }).proposals.map((p) => p.id)).toEqual([
      "a",
    ]);
  });
});

describe("approveIcpProposalRoute", () => {
  const post = (id: string) =>
    approveIcpProposalRoute(
      new Request(`http://x/api/icp-proposals/${id}/approve`, { method: "POST" }),
      { id },
    );

  it("atomically flips status to approved and updates the active ICP", async () => {
    seed("a", "pending", "New tighter ICP");
    const res = await post("a");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, icpOneLiner: "New tighter ICP" });
    expect(proposals.get("a")!["status"]).toBe("approved");
    expect(currentConfig["icpOneLiner"]).toBe("New tighter ICP");
  });

  it("409s a proposal that's already been decided, without touching config", async () => {
    seed("a", "approved");
    const res = await post("a");
    expect(res.status).toBe(409);
    expect(currentConfig["icpOneLiner"]).toBe("old ICP");
  });

  it("404-shaped 409 for an unknown id", async () => {
    const res = await post("nope");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "proposal 'nope' not found" });
  });

  it("reverts the proposal to pending if the config write fails, and never partially applies", async () => {
    seed("a", "pending", "New tighter ICP");
    saveConfigImpl = () => {
      throw new Error("disk full");
    };
    const res = await post("a");
    expect(res.status).toBe(500);
    expect(revertCalls).toEqual(["a"]);
    expect(proposals.get("a")!["status"]).toBe("pending");
    // The active ICP in config is untouched by the failed write.
    expect(currentConfig["icpOneLiner"]).toBe("old ICP");
  });

  it("409s when the active ICP moved since this proposal's baseline was captured, without deciding it", async () => {
    seed("a", "pending", "New tighter ICP");
    currentConfig = { icpOneLiner: "a different ICP set via /setup since" };
    const res = await post("a");
    expect(res.status).toBe(409);
    expect(decideCalls).toEqual([]);
    expect(proposals.get("a")!["status"]).toBe("pending");
    expect(currentConfig["icpOneLiner"]).toBe("a different ICP set via /setup since");
  });

  it("dismisses every OTHER pending proposal on a successful approval, leaving the approved row alone", async () => {
    seed("a", "pending", "Winning rewrite");
    seed("b", "pending", "Some other rewrite");
    seed("c", "pending", "A third rewrite");
    const res = await post("a");
    expect(res.status).toBe(200);
    expect(proposals.get("a")!["status"]).toBe("approved");
    expect(proposals.get("b")!["status"]).toBe("dismissed");
    expect(proposals.get("c")!["status"]).toBe("dismissed");
    expect(dismissStaleCalls).toHaveLength(1);
  });
});

describe("dismissIcpProposalRoute", () => {
  const post = (id: string) =>
    dismissIcpProposalRoute(
      new Request(`http://x/api/icp-proposals/${id}/dismiss`, { method: "POST" }),
      { id },
    );

  it("flips status to dismissed and leaves the active ICP untouched", async () => {
    seed("a", "pending", "Rejected proposal text");
    const res = await post("a");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(proposals.get("a")!["status"]).toBe("dismissed");
    expect(currentConfig["icpOneLiner"]).toBe("old ICP");
  });

  it("409s a proposal that's already been decided", async () => {
    seed("a", "dismissed");
    const res = await post("a");
    expect(res.status).toBe(409);
  });
});
