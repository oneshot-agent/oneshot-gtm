import { beforeEach, describe, expect, it, vi } from "vitest";

// A row moved in from another workspace has its edge and verdicts stripped
// (queue-portable.ts). queue-rederive fills them back in for THIS workspace:
// the edge from a matching trigger here, else one generated from this
// workspace's positioning; the ICP verdict from the carried research; and a
// fit line. It never throws and never changes status.

const generateAlternativeAngles = vi.fn();
const generateFitReason = vi.fn();
vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return { ...actual, generateAlternativeAngles, generateFitReason };
});
const rejudgePerson = vi.fn();
vi.mock("../src/_person-research.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/_person-research.ts")>(
    "../src/_person-research.ts",
  );
  return { ...actual, rejudgePerson };
});

const { destinationTriggerEdge, rederiveMovedRow, rederiveQueueRow, rederiveFailedNote } =
  await import("../src/queue-rederive.ts");

const trigger = (name: string, config: Record<string, unknown>, enabled = 1) => ({
  name,
  enabled,
  config_json: JSON.stringify(config),
});
const positioning = { product: "an action layer for agents", icp: "teams shipping agents" };
const research = {
  version: 1,
  status: "complete",
  organizations: [],
  bio: "CTO building agent tooling",
};
const movedPayload = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  company: "Analytical",
  personResearch: research,
  movedFrom: { workspace: "other", queueId: 3, at: "2026-10-05T00:00:00Z" },
};

beforeEach(() => {
  generateAlternativeAngles.mockReset();
  generateFitReason.mockReset();
  rejudgePerson.mockReset();
  rejudgePerson.mockResolvedValue({ verdict: "unclear", reason: null, patch: {} });
  generateFitReason.mockResolvedValue(null);
});

describe("destinationTriggerEdge", () => {
  it("prefers the trigger the source names", () => {
    const pick = destinationTriggerEdge("design-partner-loi", "find:list-page:runs-x", [
      trigger("job-change", { play: "design-partner-loi", yourEdge: "routed edge" }),
      trigger("list-page", { play: "design-partner-loi", yourEdge: "own edge" }),
    ]);
    expect(pick).toEqual({ trigger: "list-page", edge: "own edge" });
  });

  it("falls back to a trigger routed to the same play, enabled first", () => {
    const pick = destinationTriggerEdge("design-partner-loi", "find:list-page:runs-x", [
      trigger("list-page", { play: "design-partner-loi", yourEdge: "" }),
      trigger("podcast-guest", { play: "design-partner-loi", yourEdge: "disabled edge" }, 0),
      trigger("job-change", { play: "design-partner-loi", yourEdge: "enabled edge" }),
    ]);
    expect(pick).toEqual({ trigger: "job-change", edge: "enabled edge" });
  });

  it("skips the source's trigger when it routes to a different play", () => {
    const pick = destinationTriggerEdge("repo-interest", "find:list-page:runs-x", [
      trigger("list-page", { play: "design-partner-loi", yourEdge: "wrong play" }),
    ]);
    expect(pick).toBeNull();
  });

  it("reads yourClaim, and returns null when nothing here has an edge", () => {
    expect(
      destinationTriggerEdge("hiring-signal", "find:hiring-signal", [
        trigger("hiring-signal", { yourClaim: "a claim" }),
      ]),
    ).toEqual({ trigger: "hiring-signal", edge: "a claim" });
    expect(
      destinationTriggerEdge("x", "find:luma-events", [trigger("luma-events", {})]),
    ).toBeNull();
  });
});

describe("rederiveMovedRow", () => {
  it("takes the edge from a matching trigger without generating one", async () => {
    const patch = await rederiveMovedRow({
      playName: "design-partner-loi",
      source: "find:list-page:runs-x",
      payload: movedPayload,
      triggers: [trigger("list-page", { play: "design-partner-loi", yourEdge: "here's edge" })],
      positioning,
    });
    expect(patch).toMatchObject({
      yourEdge: "here's edge",
      yourEdgeSource: "destination-trigger:list-page",
    });
    expect(generateAlternativeAngles).not.toHaveBeenCalled();
  });

  it("generates an edge from this workspace's positioning when no trigger has one", async () => {
    generateAlternativeAngles.mockResolvedValue([
      "For a team shipping agents — one call per action",
    ]);
    const patch = await rederiveMovedRow({
      playName: "design-partner-loi",
      source: "find:list-page:runs-x",
      payload: movedPayload,
      triggers: [],
      positioning,
    });
    expect(patch).toMatchObject({
      yourEdge: "For a team shipping agents — one call per action",
      yourEdgeSource: "generated-on-move",
    });
    const call = generateAlternativeAngles.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["count"]).toBe(1);
    expect(call["positioning"]).toMatchObject({ product: positioning.product, edge: "" });
  });

  it("writes the edge to yourClaim for hiring-signal rows", async () => {
    generateAlternativeAngles.mockResolvedValue(["a claim"]);
    const patch = await rederiveMovedRow({
      playName: "hiring-signal",
      source: "find:hiring-signal",
      payload: movedPayload,
      triggers: [],
      positioning,
    });
    expect(patch["yourClaim"]).toBe("a claim");
    expect(patch).not.toHaveProperty("yourEdge");
  });

  it("leaves the edge unset with no positioning, or when generation fails", async () => {
    const none = await rederiveMovedRow({
      playName: "design-partner-loi",
      source: null,
      payload: movedPayload,
      triggers: [],
      positioning: {},
    });
    expect(none.yourEdgeSource).toBe("none");
    expect(none).not.toHaveProperty("yourEdge");
    expect(generateAlternativeAngles).not.toHaveBeenCalled();

    generateAlternativeAngles.mockRejectedValue(new Error("model down"));
    const failed = await rederiveMovedRow({
      playName: "design-partner-loi",
      source: null,
      payload: movedPayload,
      triggers: [],
      positioning,
    });
    expect(failed.yourEdgeSource).toBe("none");
  });

  it("records a pass verdict and its fit line from the person gate", async () => {
    rejudgePerson.mockResolvedValue({
      verdict: "pass",
      reason: "CTO shipping agents",
      patch: {
        icpVerdict: "pass",
        icpVerdictReason: "CTO shipping agents",
        fitReason: "CTO shipping agents",
        fitReasonSource: "person-gate",
      },
    });
    const patch = await rederiveMovedRow({
      playName: "design-partner-loi",
      source: null,
      payload: movedPayload,
      triggers: [],
      positioning: {},
    });
    expect(patch).toMatchObject({
      icpVerdict: "pass",
      fitReason: "CTO shipping agents",
      fitReasonSource: "person-gate",
    });
    expect(generateFitReason).not.toHaveBeenCalled();
  });

  it("records a reject verdict without inventing a fit line", async () => {
    rejudgePerson.mockResolvedValue({
      verdict: "reject",
      reason: "student",
      patch: { icpVerdict: "reject", icpVerdictReason: "student" },
    });
    const patch = await rederiveMovedRow({
      playName: "design-partner-loi",
      source: null,
      payload: movedPayload,
      triggers: [],
      positioning: {},
    });
    expect(patch).toMatchObject({ icpVerdict: "reject", icpVerdictReason: "student" });
    expect(patch).not.toHaveProperty("fitReason");
    expect(generateFitReason).not.toHaveBeenCalled();
  });

  it("generates a fit line when the gate is unclear or there is no research", async () => {
    generateFitReason.mockResolvedValue("Runs the platform team that would adopt this.");
    const unclear = await rederiveMovedRow({
      playName: "design-partner-loi",
      source: null,
      payload: movedPayload,
      triggers: [],
      positioning,
    });
    expect(unclear).toMatchObject({
      fitReason: "Runs the platform team that would adopt this.",
      fitReasonSource: "generated",
    });

    rejudgePerson.mockClear();
    const { personResearch: _drop, ...bare } = movedPayload;
    await rederiveMovedRow({
      playName: "design-partner-loi",
      source: null,
      payload: bare,
      triggers: [],
      positioning,
    });
    expect(rejudgePerson).not.toHaveBeenCalled();
  });

  it("survives a person-gate failure", async () => {
    rejudgePerson.mockRejectedValue(new Error("gate down"));
    generateFitReason.mockResolvedValue("A fit line.");
    const patch = await rederiveMovedRow({
      playName: "design-partner-loi",
      source: null,
      payload: movedPayload,
      triggers: [],
      positioning,
    });
    expect(patch["fitReason"]).toBe("A fit line.");
  });
});

type Row = {
  id: number;
  play_name: string;
  source: string | null;
  status: string;
  payload_json: string;
  notes: string | null;
  last_draft_json: string | null;
};
const makeLedger = (row: Row | null) => {
  const state = {
    row,
    payloads: [] as unknown[],
    cleared: [] as number[],
    notes: [] as string[],
  };
  const ledger = {
    getQueueRow: () => state.row,
    updateQueuePayload: ({ payload }: { id: number; payload: unknown }) => {
      state.payloads.push(payload);
      if (state.row) state.row = { ...state.row, payload_json: JSON.stringify(payload) };
    },
    clearQueueDraft: (id: number) => {
      state.cleared.push(id);
    },
    setQueueNotes: ({ notes }: { id: number; notes: string }) => {
      state.notes.push(notes);
      if (state.row) state.row = { ...state.row, notes };
    },
  };
  return { ledger, state };
};
const never = () => new Promise<never>(() => {});

describe("rederiveQueueRow", () => {
  const baseRow: Row = {
    id: 10,
    play_name: "design-partner-loi",
    source: "find:list-page:runs-x",
    status: "pending",
    payload_json: JSON.stringify(movedPayload),
    notes: "moved from other",
    last_draft_json: '{"subject":"old"}',
  };
  const patch = {
    yourEdge: "edge",
    yourEdgeSource: "generated-on-move" as const,
    fitReason: "fit",
  };

  it("merges onto the current payload and clears a draft written before the edge", async () => {
    const { ledger, state } = makeLedger({ ...baseRow });
    const out = await rederiveQueueRow(ledger, 10, { derive: async () => patch });
    expect(out).toEqual({ ok: true, patch });
    expect(state.payloads[0]).toMatchObject({ ...movedPayload, ...patch });
    expect(state.cleared).toEqual([10]);
    expect(state.row?.status).toBe("pending");
  });

  it("keeps an edit made while the model calls ran", async () => {
    const { ledger, state } = makeLedger({ ...baseRow });
    const derive = async () => {
      state.row = {
        ...state.row!,
        payload_json: JSON.stringify({ ...movedPayload, email: "new@example.com" }),
      };
      return patch;
    };
    await rederiveQueueRow(ledger, 10, { derive });
    expect(state.payloads[0]).toMatchObject({ email: "new@example.com", yourEdge: "edge" });
  });

  it("writes nothing on a dry run", async () => {
    const { ledger, state } = makeLedger({ ...baseRow });
    const out = await rederiveQueueRow(ledger, 10, { derive: async () => patch, dryRun: true });
    expect(out.ok).toBe(true);
    expect(state.payloads).toEqual([]);
    expect(state.cleared).toEqual([]);
  });

  it("leaves closed and missing rows alone", async () => {
    for (const status of ["sent", "rejected"]) {
      const { ledger, state } = makeLedger({ ...baseRow, status });
      expect(await rederiveQueueRow(ledger, 10, { derive: async () => patch })).toEqual({
        ok: false,
        reason: "not-open",
      });
      expect(state.payloads).toEqual([]);
    }
    expect(await rederiveQueueRow(makeLedger(null).ledger, 10)).toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("notes the manual command on a timeout, and drops the note once a later run succeeds", async () => {
    const { ledger, state } = makeLedger({ ...baseRow });
    expect(await rederiveQueueRow(ledger, 10, { derive: never, deadlineMs: 5 })).toEqual({
      ok: false,
      reason: "timeout",
    });
    expect(state.row?.notes).toBe(`moved from other · ${rederiveFailedNote(10)}`);
    expect(state.payloads).toEqual([]);

    await rederiveQueueRow(ledger, 10, { derive: async () => patch });
    expect(state.row?.notes).toBe("moved from other");
  });
});
