import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/triggers/:name/suggest-angles (#813): an explicit founder action
// that turns angle usage counts and objection replies into a PENDING
// campaign_angle proposal. Nothing is applied here; the counts are
// observational and the proposal says so.

const complete = vi.fn();
const reserve = vi.fn();
const release = vi.fn();
let demo = false;
vi.mock("@oneshot-gtm/intel", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel")),
  complete: (...args: unknown[]) => complete(...args),
}));
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  tryReserveDailySpend: (...args: unknown[]) => reserve(...args),
  demoMode: () => demo,
  logEvent: () => {},
}));
const { getLedger, loadConfig, saveConfig } = await import("@oneshot-gtm/core");
const { suggestAnglesRoute } = await import("../src/api/triggers.ts");

const ledger = getLedger();
const db = (ledger as unknown as { db: { exec: (sql: string) => void } }).db;
const post = (name: string) =>
  suggestAnglesRoute(
    new Request(`http://x/api/triggers/${name}/suggest-angles`, { method: "POST" }),
    { name },
  );
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
const EDGE = "deflation beats discounts // long goals, not tasks // anything can be oneshotted";

function seedTrigger(edge = EDGE, assignment?: "arm") {
  ledger.upsertTrigger({
    name: "show-hn",
    configJson: JSON.stringify({
      yourEdge: edge,
      ...(assignment ? { angleAssignment: assignment } : {}),
    }),
    enabled: true,
  });
}

/** One reviewed draft on `angle` for a fresh prospect, optionally rotated away or sent. */
function seedUsage(angle: string, outcome: "rotate" | "sent") {
  const key = Math.random().toString(36).slice(2);
  const id = ledger.enqueueTarget({
    playName: "show-hn",
    payload: { title: key, email: `${key}@x.dev` },
    dedupeKey: key,
    source: "find:show-hn",
  })!;
  const base = { subject: "s", flags: [], sent: false, receiptIds: [], dryRun: false };
  ledger.setQueueDraft({
    id,
    draft: { ...base, body: "b1", angle: { text: angle, origin: "configured" } },
  });
  if (outcome === "rotate")
    ledger.setQueueDraft({
      id,
      draft: { ...base, body: "b2", angle: { text: EDGE.split(" // ")[0]!, origin: "configured" } },
      discardReason: "rotate",
    });
  else
    ledger.setQueueDraft({
      id,
      draft: { ...base, body: "b1", sent: true, angle: { text: angle, origin: "configured" } },
      sentBy: "human",
    });
}

function modelSays(out: unknown) {
  complete.mockReset().mockResolvedValue({ content: JSON.stringify(out) });
}

beforeEach(() => {
  demo = false;
  for (const table of [
    "learning_proposals",
    "learning_jobs",
    "triggers",
    "target_queue",
    "draft_versions",
    "inbox_replies",
  ])
    db.exec(`DELETE FROM ${table}`);
  saveConfig({
    ...loadConfig(),
    productOneLiner: "OneShot",
    productBrief: "Goals, not tasks.",
    icpOneLiner: "Founders",
  });
  release.mockReset();
  reserve.mockReset().mockReturnValue({ granted: true, release });
  modelSays({
    keep: ["deflation beats discounts", "anything can be oneshotted"],
    retire: ["long goals, not tasks"],
    add: ["a goal you can hand off whole"],
    rationale: "#2 was rotated away 5 of 5 times and never sent; hypothesis.",
  });
});
afterEach(() => vi.restoreAllMocks());

describe("suggestAnglesRoute", () => {
  it("records a pending campaign_angle proposal with counts, method, objections and a hypothesis label", async () => {
    seedTrigger(EDGE, "arm");
    for (let i = 0; i < 5; i++) seedUsage("long goals, not tasks", "rotate");
    seedUsage("deflation beats discounts", "sent");
    const pid = ledger.upsertProspect({ email: "obj@x.dev", name: "Obi", company: "Obi Co" });
    ledger.recordInboxReply({
      id: "r1",
      threadKey: "t1",
      prospectId: pid,
      playName: "show-hn",
      fromEmail: "obj@x.dev",
      subject: "re",
      body: "We tried agents, they never finish the job.",
      receivedAt: new Date().toISOString(),
      kind: "human",
    });
    ledger.setInboxReplyIntent("r1", "objection", "pushback on reliability");
    const res = await post("show-hn");
    expect(res.status).toBe(200);
    const body = await json(res);
    const proposal = body["proposal"] as Record<string, unknown>;
    expect(proposal).toMatchObject({
      kind: "campaign_angle",
      status: "pending",
      scope: { playName: "show-hn" },
      current: { field: "yourEdge", edge: EDGE },
      proposed: {
        field: "yourEdge",
        edge: "deflation beats discounts // anything can be oneshotted // a goal you can hand off whole",
        retire: ["long goals, not tasks"],
        add: ["a goal you can hand off whole"],
      },
    });
    const evidence = proposal["evidence"] as {
      counts: Record<string, number>;
      method: string;
      samples: unknown[];
      refs: unknown[];
    };
    expect(evidence.method).toBe("arm");
    expect(evidence.counts).toMatchObject({
      angles: 3,
      retire: 1,
      add: 1,
      objections: 1,
      angle2_offered: 5,
      angle1_sent: 1,
    });
    expect(evidence.refs).toEqual([{ type: "inbox_reply", id: "r1" }]);
    expect(evidence.samples[0]).toMatchObject({ label: "Reply · objection" });
    expect(proposal["evidenceSummary"]).toContain("Hypothesis from observational counts");
    expect(proposal["evidenceSummary"]).toContain("even split");
    const sent = JSON.parse(complete.mock.calls[0]![0].messages[1].content);
    expect(sent.method).toBe("arm");
    expect(sent.angles[1]).toMatchObject({
      text: "long goals, not tasks",
      offered: 5,
      rotatedAway: 5,
      sent: 0,
    });
    expect(sent.objections).toEqual([
      { intent: "objection", body: "We tried agents, they never finish the job." },
    ]);
    expect(release).toHaveBeenCalledTimes(1);
    // Nothing applied: the trigger's edge is untouched until approval.
    expect(JSON.parse(ledger.getTrigger("show-hn")!.config_json!).yourEdge).toBe(EDGE);
  });

  it("makes no proposal when the model keeps the set, and never drops an angle the model forgot", async () => {
    seedTrigger();
    seedUsage("deflation beats discounts", "sent");
    modelSays({ keep: EDGE.split(" // "), retire: [], add: [], rationale: "" });
    expect(await json(await post("show-hn"))).toMatchObject({ ok: true, proposal: null });
    modelSays({ keep: ["deflation beats discounts"], retire: [], add: [], rationale: "x" });
    // Two angles unclassified: they stay, so the set is unchanged.
    expect((await json(await post("show-hn")))["proposal"]).toBeNull();
    expect(ledger.learning.list({ kind: "campaign_angle", status: "all" })).toEqual([]);
  });

  it("skips a duplicate of a pending proposal and a change just dismissed", async () => {
    seedTrigger();
    seedUsage("deflation beats discounts", "sent");
    const first = await json(await post("show-hn"));
    expect(first["proposal"]).toBeTruthy();
    const second = await json(await post("show-hn"));
    expect(second["proposal"]).toBeNull();
    expect(ledger.learning.list({ kind: "campaign_angle", status: "pending" })).toHaveLength(1);
    ledger.learning.decide(
      (first["proposal"] as { id: string }).id,
      "dismissed",
      new Date().toISOString(),
    );
    expect((await json(await post("show-hn")))["proposal"]).toBeNull();
  });

  it("400s without an edge field, 404s an unknown trigger, 403s in demo, 429s when spend is capped", async () => {
    ledger.upsertTrigger({
      name: "show-hn",
      configJson: JSON.stringify({ sinceDays: 2 }),
      enabled: true,
    });
    expect((await post("show-hn")).status).toBe(400);
    expect((await post("no-such-play")).status).toBe(404);
    seedTrigger();
    reserve.mockReturnValue({ granted: false, reason: "cap" });
    expect((await post("show-hn")).status).toBe(429);
    expect(complete).not.toHaveBeenCalled();
    demo = true;
    expect((await post("show-hn")).status).toBe(403);
  });

  it("the proposal applies through the learning routes with a baseline check on the edge", async () => {
    const { approveLearningProposalRoute } = await import("../src/api/learning.ts");
    seedTrigger();
    seedUsage("deflation beats discounts", "sent");
    const proposal = (await json(await post("show-hn")))["proposal"] as { id: string };
    // The founder edits the edge by hand first: the baseline moved.
    ledger.setTriggerConfig("show-hn", JSON.stringify({ yourEdge: "something else" }));
    const stale = await approveLearningProposalRoute(
      new Request(`http://x/api/learning/proposals/${proposal.id}/approve`, { method: "POST" }),
      { id: proposal.id },
    );
    expect(stale.status).toBe(409);
    ledger.setTriggerConfig("show-hn", JSON.stringify({ yourEdge: EDGE }));
    const ok = await approveLearningProposalRoute(
      new Request(`http://x/api/learning/proposals/${proposal.id}/approve`, { method: "POST" }),
      { id: proposal.id },
    );
    expect(ok.status).toBe(200);
    expect(JSON.parse(ledger.getTrigger("show-hn")!.config_json!).yourEdge).toBe(
      "deflation beats discounts // anything can be oneshotted // a goal you can hand off whole",
    );
  });
});
