import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unified learning review (#813): list/approve/dismiss/rollback for every
// proposal kind against the real (isolated-home) ledger and config. The
// apply step is the only thing that may change an active value, and it
// runs only after a baseline check and a recorded decision.

let demo = false;
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  demoMode: () => demo,
  logEvent: () => {},
}));
const { getLedger, learningKeyOf, loadConfig, normalizeIcpText, saveConfig } =
  await import("@oneshot-gtm/core");
const {
  approveLearningProposalRoute,
  dismissLearningProposalRoute,
  listLearningGuidanceRoute,
  listLearningProposalsRoute,
  rollbackLearningGuidanceRoute,
  rollbackLearningProposalRoute,
  setLearningGuidanceRoute,
} = await import("../src/api/learning.ts");

const ledger = getLedger();
const db = (ledger as unknown as { db: { exec: (sql: string) => void } }).db;

const post = (path: string, body?: unknown) =>
  new Request(`http://x/api/learning/${path}`, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

function insertIcp(proposed = "B2B fintech CTOs at Series A startups") {
  return ledger.learning.insert({
    kind: "icp",
    current: "B2B fintech founders",
    proposed,
    evidence: { refs: [] },
    evidenceSummary: "skews technical",
    baselineKey: normalizeIcpText("B2B fintech founders"),
    dedupeKey: normalizeIcpText(proposed),
  })!;
}

function insertPreference(instruction = "Open with the question, not a greeting") {
  return ledger.learning.insert({
    kind: "preference",
    scope: { channel: "email", stage: "reply" },
    current: null,
    proposed: { instruction, source: "edits" },
    evidence: { refs: [{ type: "reply_send", id: "s1" }] },
    evidenceSummary: "three edits",
    baselineKey: "",
    dedupeKey: instruction.toLowerCase(),
  })!;
}

function seedProspect(): number {
  const id = ledger.upsertProspect({
    email: `ada-${Math.random().toString(36).slice(2)}@example.com`,
    name: "Ada",
    company: "Ada Co",
  });
  ledger.setProspectAngle(id, JSON.stringify({ hook: "old hook", nextStep: "reply" }));
  return id;
}

function insertAngle(prospectId: number) {
  const prospect = ledger.getProspectById(prospectId)!;
  return ledger.learning.insert({
    kind: "prospect_angle",
    scope: { prospectId },
    current: { angleJson: prospect.angle_json, approvedAt: null },
    proposed: { hook: "new hook", nextStep: "offer a call", doNotSay: ["pricing"] },
    evidence: { refs: [{ type: "inbox_reply", id: "r1" }], method: "reply" },
    evidenceSummary: "they asked about pricing",
    baselineKey: learningKeyOf(prospect.angle_json ?? ""),
    dedupeKey: `${prospectId}:new`,
  })!;
}

function seedTrigger(edge = "fast // cheap") {
  ledger.upsertTrigger({
    name: "show-hn",
    configJson: JSON.stringify({ yourEdge: edge }),
    enabled: true,
  });
}

function insertCampaign() {
  return ledger.learning.insert({
    kind: "campaign_angle",
    scope: { playName: "show-hn" },
    current: { field: "yourEdge", edge: "fast // cheap" },
    proposed: { field: "yourEdge", edge: "fast // guaranteed" },
    evidence: { refs: [], counts: { offered: 12, sent: 3 }, method: "fit" },
    evidenceSummary: "cheap never sent; hypothesis",
    baselineKey: learningKeyOf("fast // cheap"),
    dedupeKey: learningKeyOf("fast // guaranteed"),
  })!;
}

beforeEach(() => {
  demo = false;
  for (const table of ["learning_proposals", "learning_guidance", "learning_state", "triggers"])
    db.exec(`DELETE FROM ${table}`);
  saveConfig({ ...loadConfig(), icpOneLiner: "B2B fintech founders" });
});
afterEach(() => vi.restoreAllMocks());

describe("listLearningProposalsRoute", () => {
  it("defaults to pending, narrows by kind and prospect, and returns history on status=all", async () => {
    const icp = insertIcp();
    const pid = seedProspect();
    insertAngle(pid);
    ledger.learning.decide(icp.id, "dismissed", "2026-10-08T00:00:00Z");
    const pending = await json(
      listLearningProposalsRoute(new Request("http://x/api/learning/proposals")),
    );
    expect((pending["proposals"] as Array<{ kind: string }>).map((p) => p.kind)).toEqual([
      "prospect_angle",
    ]);
    const all = await json(
      listLearningProposalsRoute(new Request("http://x/api/learning/proposals?status=all")),
    );
    expect(all["proposals"]).toHaveLength(2);
    const byProspect = await json(
      listLearningProposalsRoute(
        new Request(`http://x/api/learning/proposals?kind=prospect_angle&prospectId=${pid}`),
      ),
    );
    expect(byProspect["proposals"]).toHaveLength(1);
    // The scope is shown as the founder knows it: the prospect's name, not its id.
    expect((byProspect["proposals"] as Array<{ scopeLabel: string | null }>)[0]!.scopeLabel).toBe(
      "Ada · Ada Co",
    );
    expect(
      (all["proposals"] as Array<{ kind: string; scopeLabel: string | null }>).find(
        (p) => p.kind === "icp",
      )!.scopeLabel,
    ).toBeNull();
    const other = await json(
      listLearningProposalsRoute(
        new Request(`http://x/api/learning/proposals?prospectId=${pid + 1}`),
      ),
    );
    expect(other["proposals"]).toEqual([]);
  });
});

describe("approve", () => {
  it("icp: applies to config, stamps applied_at, and marks sibling ICP proposals stale", async () => {
    const a = insertIcp("Winning rewrite");
    const b = insertIcp("Other rewrite");
    const res = await approveLearningProposalRoute(post(`proposals/${a.id}/approve`), { id: a.id });
    expect(res.status).toBe(200);
    expect(loadConfig().icpOneLiner).toBe("Winning rewrite");
    expect(ledger.learning.get(a.id)).toMatchObject({
      status: "approved",
      appliedAt: expect.any(String),
    });
    expect(ledger.learning.get(b.id)?.status).toBe("stale");
    // The #750 surface sees the same rows.
    expect(ledger.icpProposals.list("dismissed").map((p) => p.id)).toEqual([b.id]);
  });

  it("icp: 409s when the active ICP moved since the baseline, leaving the proposal pending", async () => {
    const a = insertIcp();
    saveConfig({ ...loadConfig(), icpOneLiner: "edited via /setup since" });
    const res = await approveLearningProposalRoute(post(`proposals/${a.id}/approve`), { id: a.id });
    expect(res.status).toBe(409);
    expect(ledger.learning.get(a.id)?.status).toBe("pending");
    expect(loadConfig().icpOneLiner).toBe("edited via /setup since");
  });

  it("edit-and-approve applies the founder's value and records it on the proposal", async () => {
    const a = insertIcp();
    const res = await approveLearningProposalRoute(
      post(`proposals/${a.id}/approve`, { value: "  Series A fintech CTOs  " }),
      { id: a.id },
    );
    expect(res.status).toBe(200);
    expect(loadConfig().icpOneLiner).toBe("Series A fintech CTOs");
    expect(ledger.learning.get(a.id)?.decided).toBe("Series A fintech CTOs");
    const bad = await approveLearningProposalRoute(
      post(`proposals/${a.id}/approve`, { value: "" }),
      { id: a.id },
    );
    expect(bad.status).toBe(409); // already approved
  });

  it("rejects an invalid edit with 400 before deciding anything", async () => {
    const p = insertPreference();
    const res = await approveLearningProposalRoute(
      post(`proposals/${p.id}/approve`, { value: { instruction: "" } }),
      {
        id: p.id,
      },
    );
    expect(res.status).toBe(400);
    expect(ledger.learning.get(p.id)?.status).toBe("pending");
  });

  it("preference: becomes enabled guidance scoped like the proposal; siblings stay pending", async () => {
    const p = insertPreference();
    const q = insertPreference("Keep replies under eighty words");
    const res = await approveLearningProposalRoute(post(`proposals/${p.id}/approve`), { id: p.id });
    expect(res.status).toBe(200);
    const guidance = ledger.learning.listGuidance();
    expect(guidance).toHaveLength(1);
    expect(guidance[0]).toMatchObject({
      instruction: "Open with the question, not a greeting",
      source: "edits",
      channel: "email",
      stage: "reply",
      proposalId: p.id,
      status: "enabled",
    });
    expect(
      ledger.learning.guidance({ channel: "email", stage: "reply" }).instructions,
    ).toHaveLength(1);
    expect(
      ledger.learning.guidance({ channel: "linkedin", stage: "reply" }).instructions,
    ).toHaveLength(0);
    expect(ledger.learning.get(q.id)?.status).toBe("pending");
  });

  it("prospect_angle: writes angle_json with approval time, 409s on a moved baseline", async () => {
    const pid = seedProspect();
    const a = insertAngle(pid);
    const res = await approveLearningProposalRoute(
      post(`proposals/${a.id}/approve`, { value: { hook: "edited hook" } }),
      { id: a.id },
    );
    expect(res.status).toBe(200);
    const prospect = ledger.getProspectById(pid)!;
    expect(JSON.parse(prospect.angle_json!)).toMatchObject({
      hook: "edited hook",
      nextStep: "offer a call",
    });
    const approvedAt = (
      ledger as unknown as {
        db: { query: (s: string) => { get: (id: number) => { a: string | null } } };
      }
    ).db
      .query("SELECT angle_approved_at AS a FROM prospects WHERE id=?")
      .get(pid).a;
    expect(approvedAt).toEqual(expect.any(String));

    // A second proposal computed against the old angle is now stale at approve time.
    const stale = ledger.learning.insert({
      kind: "prospect_angle",
      scope: { prospectId: pid },
      current: { angleJson: null, approvedAt: null },
      proposed: { hook: "another" },
      evidence: { refs: [] },
      evidenceSummary: "x",
      baselineKey: learningKeyOf(""),
      dedupeKey: `${pid}:another`,
    })!;
    const res2 = await approveLearningProposalRoute(post(`proposals/${stale.id}/approve`), {
      id: stale.id,
    });
    expect(res2.status).toBe(409);
  });

  it("campaign_angle: rewrites the trigger's edge field only, 409s when the edge moved", async () => {
    seedTrigger();
    const c = insertCampaign();
    const res = await approveLearningProposalRoute(post(`proposals/${c.id}/approve`), { id: c.id });
    expect(res.status).toBe(200);
    expect(JSON.parse(ledger.getTrigger("show-hn")!.config_json!)).toEqual({
      yourEdge: "fast // guaranteed",
    });
    const again = insertCampaign();
    const res2 = await approveLearningProposalRoute(post(`proposals/${again.id}/approve`), {
      id: again.id,
    });
    expect(res2.status).toBe(409);
  });

  it("reverts the decision when applying fails, so no approval is recorded without effect", async () => {
    const c = insertCampaign(); // trigger row never seeded → apply throws
    const res = await approveLearningProposalRoute(post(`proposals/${c.id}/approve`), { id: c.id });
    expect(res.status).toBe(409); // baseline cannot be read: refused before deciding
    expect(ledger.learning.get(c.id)?.status).toBe("pending");
    seedTrigger();
    const spy = vi.spyOn(ledger, "setTriggerConfig").mockImplementation(() => {
      throw new Error("disk full");
    });
    const res2 = await approveLearningProposalRoute(post(`proposals/${c.id}/approve`), {
      id: c.id,
    });
    expect(res2.status).toBe(500);
    expect(ledger.learning.get(c.id)).toMatchObject({ status: "pending", decidedAt: null });
    spy.mockRestore();
  });

  it("campaign_angle: refuses to apply an empty edge and reverts the decision", async () => {
    seedTrigger();
    const c = insertCampaign();
    const res = await approveLearningProposalRoute(
      post(`proposals/${c.id}/approve`, { value: { edge: "   " } }),
      { id: c.id },
    );
    expect(res.status).toBe(400);
    expect(ledger.learning.get(c.id)?.status).toBe("pending");
    expect(JSON.parse(ledger.getTrigger("show-hn")!.config_json!)).toEqual({
      yourEdge: "fast // cheap",
    });
  });

  it("a failed revert leaves the proposal approved and still rollback-able", async () => {
    seedTrigger();
    const c = insertCampaign();
    await approveLearningProposalRoute(post(`proposals/${c.id}/approve`), { id: c.id });
    const spy = vi.spyOn(ledger, "setTriggerConfig").mockImplementation(() => {
      throw new Error("disk full");
    });
    const res = rollbackLearningProposalRoute(post(`proposals/${c.id}/rollback`), { id: c.id });
    expect(res.status).toBe(500);
    expect(ledger.learning.get(c.id)?.status).toBe("approved");
    spy.mockRestore();
    expect(
      rollbackLearningProposalRoute(post(`proposals/${c.id}/rollback`), { id: c.id }).status,
    ).toBe(200);
    expect(JSON.parse(ledger.getTrigger("show-hn")!.config_json!)).toEqual({
      yourEdge: "fast // cheap",
    });
  });

  it("refuses in demo mode", async () => {
    demo = true;
    const a = insertIcp();
    expect(
      (await approveLearningProposalRoute(post(`proposals/${a.id}/approve`), { id: a.id })).status,
    ).toBe(403);
    expect(
      dismissLearningProposalRoute(post(`proposals/${a.id}/dismiss`), { id: a.id }).status,
    ).toBe(403);
    expect(ledger.learning.get(a.id)?.status).toBe("pending");
  });
});

describe("dismiss and rollback", () => {
  it("dismiss leaves the active value alone and blocks a second decision", async () => {
    const a = insertIcp();
    expect(
      dismissLearningProposalRoute(post(`proposals/${a.id}/dismiss`), { id: a.id }).status,
    ).toBe(200);
    expect(loadConfig().icpOneLiner).toBe("B2B fintech founders");
    expect(
      dismissLearningProposalRoute(post(`proposals/${a.id}/dismiss`), { id: a.id }).status,
    ).toBe(409);
  });

  it("rollback restores the previous value for each kind and only from approved", async () => {
    const icp = insertIcp();
    expect(
      rollbackLearningProposalRoute(post(`proposals/${icp.id}/rollback`), { id: icp.id }).status,
    ).toBe(409);
    await approveLearningProposalRoute(post(`proposals/${icp.id}/approve`), { id: icp.id });
    expect(
      rollbackLearningProposalRoute(post(`proposals/${icp.id}/rollback`), { id: icp.id }).status,
    ).toBe(200);
    expect(loadConfig().icpOneLiner).toBe("B2B fintech founders");
    expect(ledger.learning.get(icp.id)?.status).toBe("rolled_back");

    const pid = seedProspect();
    const angle = insertAngle(pid);
    await approveLearningProposalRoute(post(`proposals/${angle.id}/approve`), { id: angle.id });
    rollbackLearningProposalRoute(post(`proposals/${angle.id}/rollback`), { id: angle.id });
    expect(JSON.parse(ledger.getProspectById(pid)!.angle_json!)).toEqual({
      hook: "old hook",
      nextStep: "reply",
    });

    seedTrigger();
    const c = insertCampaign();
    await approveLearningProposalRoute(post(`proposals/${c.id}/approve`), { id: c.id });
    rollbackLearningProposalRoute(post(`proposals/${c.id}/rollback`), { id: c.id });
    expect(JSON.parse(ledger.getTrigger("show-hn")!.config_json!)).toEqual({
      yourEdge: "fast // cheap",
    });

    const pref = insertPreference();
    await approveLearningProposalRoute(post(`proposals/${pref.id}/approve`), { id: pref.id });
    expect(
      ledger.learning.guidance({ channel: "email", stage: "reply" }).instructions,
    ).toHaveLength(1);
    rollbackLearningProposalRoute(post(`proposals/${pref.id}/rollback`), { id: pref.id });
    expect(
      ledger.learning.guidance({ channel: "email", stage: "reply" }).instructions,
    ).toHaveLength(0);
    expect(ledger.learning.listGuidance(true)[0]?.status).toBe("rolled_back");
  });
});

describe("guidance routes", () => {
  it("lists every row with the version, toggles enabled, and rolls back through the proposal", async () => {
    const pref = insertPreference();
    await approveLearningProposalRoute(post(`proposals/${pref.id}/approve`), { id: pref.id });
    const listed = await json(
      listLearningGuidanceRoute(new Request("http://x/api/learning/guidance")),
    );
    expect(listed["version"]).toBe(1);
    const g = (listed["guidance"] as Array<{ id: string; status: string }>)[0]!;
    expect(g.status).toBe("enabled");
    expect(
      (await setLearningGuidanceRoute(post(`guidance/${g.id}`, { enabled: false }), { id: g.id }))
        .status,
    ).toBe(200);
    expect(ledger.learning.getGuidance(g.id)?.status).toBe("disabled");
    expect(
      (await setLearningGuidanceRoute(post(`guidance/${g.id}`, { enabled: "yes" }), { id: g.id }))
        .status,
    ).toBe(400);
    expect(
      rollbackLearningGuidanceRoute(post(`guidance/${g.id}/rollback`), { id: g.id }).status,
    ).toBe(200);
    expect(ledger.learning.get(pref.id)?.status).toBe("rolled_back");
    expect(
      rollbackLearningGuidanceRoute(post(`guidance/${g.id}/rollback`), { id: g.id }).status,
    ).toBe(409);
    expect(
      rollbackLearningGuidanceRoute(post(`guidance/nope/rollback`), { id: "nope" }).status,
    ).toBe(409);
  });
});
