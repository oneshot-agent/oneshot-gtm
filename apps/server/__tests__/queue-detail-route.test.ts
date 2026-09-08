import { describe, expect, it, vi } from "vitest";

// GET /api/queue/:id feeds the /prospects drawer. The contracts: a row with no
// prospect_id still finds its prospect by payload email, the response never
// carries a reply body, and approve refuses a sent row (drain would re-send).

const queueRows = new Map<number, Record<string, unknown>>();
const prospectsByEmail = new Map<string, { id: number }>();
const prospectsById = new Map<number, Record<string, unknown>>();
const statusCalls: Array<Record<string, unknown>> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({
      getQueueRow: (id: number) => queueRows.get(id) ?? null,
      findProspectByEmail: (email: string) => prospectsByEmail.get(email.toLowerCase()) ?? null,
      getProspectById: (id: number) => prospectsById.get(id) ?? null,
      listCadencesForProspect: () => [],
      // viewsForRows' bulk prior-step fetch, reached with an empty pair list.
      listSequenceEventsForCadences: () => new Map(),
      // The conversation view's filtered getter; the approve guard reads it.
      listSequenceEventsForProspect: () => [],
      // The history reads every status, including the bounced step.
      listAllSequenceEventsForProspect: (id: number) =>
        id === 44
          ? [
              {
                id: 2,
                prospect_id: 44,
                play_name: "show-hn",
                step_index: 1,
                channel: "email",
                status: "bounced",
                metadata_json: JSON.stringify({ subject: "following up" }),
                created_at: "2026-09-04 09:00:00",
              },
              {
                id: 1,
                prospect_id: 44,
                play_name: "show-hn",
                step_index: 0,
                channel: "email",
                status: "sent",
                metadata_json: JSON.stringify({ subject: "quick one", label: "intro" }),
                created_at: "2026-09-02 09:00:00",
              },
            ]
          : [],
      listInboxRepliesForProspect: (id: number) =>
        id === 44
          ? [
              {
                id: "m1",
                thread_key: "t",
                prospect_id: 44,
                play_name: "show-hn",
                from_email: "grace@x.example",
                subject: "Re: quick one",
                body: "SECRET BODY TEXT",
                received_at: "2026-09-03T12:00:00.000Z",
                source_identity_id: null,
                thread_id: null,
                message_id: null,
                kind: "human",
                intent: "interested",
                intent_reason: null,
                created_at: "2026-09-03T12:00:00.000Z",
              },
            ]
          : [],
      listChannelEventsForProspect: () => [],
      listDealOutcomesForProspect: () => [],
      suppressionFor: (email: string) => (email === "bounced@x.example" ? { kind: "hard" } : null),
      contactSuppressionFor: (email: string) =>
        email === "grace@x.example" ? { kind: "unsubscribe", received_at: "x" } : null,
      breakupReviveHoldFor: () => null,
      setQueueStatus: (input: Record<string, unknown>) => {
        statusCalls.push(input);
      },
    }),
  };
});

const { approveQueueRoute, queueRowDetailRoute } = await import("../src/api/queue.ts");

const row = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  id: 9,
  play_name: "show-hn",
  payload_json: JSON.stringify({ founderName: "grace_h", founderEmail: "Grace@X.example" }),
  dedupe_key: "k",
  source: "find:show-hn",
  status: "sent",
  found_at: "2026-09-01 10:00:00",
  reviewed_at: null,
  sent_at: "2026-09-02T09:00:00.000Z",
  notes: null,
  prospect_id: null,
  last_draft_json: null,
  last_drafted_at: null,
  drain_claimed_at: null,
  send_started_at: null,
  priority_json: null,
  decision: "approve",
  decided_at: "2026-09-01T11:00:00.000Z",
  decided_by: "human",
  ...overrides,
});

async function detail(id: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = queueRowDetailRoute(new Request(`http://x/api/queue/${id}`), { id });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("queueRowDetailRoute", () => {
  it("rejects a bad id and reports a missing row", async () => {
    expect((await detail("abc")).status).toBe(400);
    expect((await detail("404")).status).toBe(404);
  });

  it("resolves the prospect by payload email when prospect_id is null", async () => {
    queueRows.set(9, row({}));
    prospectsByEmail.set("grace@x.example", { id: 44 });
    prospectsById.set(44, {
      id: 44,
      name: "Grace H",
      email: "grace@x.example",
      company: "Navy",
      title: "CTO",
      linkedin_url: null,
      dossier_json: '{"person":{}}',
      icp_verdict: "reject",
      icp_verdict_reason: "not a builder",
      created_at: "2026-08-01 00:00:00",
    });
    const { status, body } = await detail("9");
    expect(status).toBe(200);
    expect(body["row"]).toMatchObject({
      id: 9,
      decision: "approve",
      decidedBy: "human",
      prospect: { id: 44, linkedBy: "email", hasDossier: true, icpVerdict: "reject" },
    });
    expect(body["prospect"]).toMatchObject({ id: 44, email: "grace@x.example", company: "Navy" });
    expect(body["flags"]).toEqual({
      replied: true,
      bounced: false,
      contactSuppressed: "unsubscribe",
      breakupHold: false,
      icpReject: true,
    });
    const timeline = body["timeline"] as Array<Record<string, unknown>>;
    expect(timeline.map((e) => e["kind"])).toEqual([
      "sequence", // 2026-09-04 — the bounced step, visible in history
      "reply", // 2026-09-03
      "sequence", // 2026-09-02 09:00 (SQLite format, normalised)
      "sent", // 2026-09-02 09:00 ISO — same instant, later insertion first
      "decided",
      "surfaced",
    ]);
    expect(timeline[0]).toMatchObject({ label: "email step 2 · bounced" });
    expect(timeline[1]).toMatchObject({ label: "reply · interested", detail: "Re: quick one" });
    expect((body["flags"] as Record<string, unknown>)["replied"]).toBe(true);
    expect(JSON.stringify(body)).not.toContain("SECRET BODY TEXT");
  });

  it("reads the ICP verdict off the payload when the row never became a prospect", async () => {
    queueRows.set(
      12,
      row({
        id: 12,
        status: "rejected",
        sent_at: null,
        payload_json: JSON.stringify({ name: "N", icpVerdict: "reject", icpVerdictReason: "host" }),
      }),
    );
    const { body } = await detail("12");
    expect(body["prospect"]).toBeNull();
    expect((body["flags"] as Record<string, unknown>)["icpReject"]).toBe(true);
  });

  it("returns a detached row (no prospect) with empty history and clean flags", async () => {
    queueRows.set(10, row({ id: 10, payload_json: JSON.stringify({ postUrl: "https://a.b/c" }) }));
    const { body } = await detail("10");
    expect(body["prospect"]).toBeNull();
    expect((body["row"] as Record<string, unknown>)["prospect"]).toBeNull();
    expect((body["timeline"] as unknown[]).map((e) => (e as { kind: string }).kind)).toEqual([
      "sent",
      "decided",
      "surfaced",
    ]);
    expect(body["flags"]).toEqual({
      replied: false,
      bounced: false,
      contactSuppressed: null,
      breakupHold: false,
      icpReject: false,
    });
  });
});

describe("approveQueueRoute on a sent row", () => {
  it("refuses with 409 so drain cannot re-send", async () => {
    queueRows.set(9, row({ status: "sent" }));
    const res = await approveQueueRoute(
      new Request("http://x/api/queue/9/approve", { method: "POST" }),
      {
        id: "9",
      },
    );
    expect(res.status).toBe(409);
    expect(statusCalls).toEqual([]);
  });

  it("refuses to re-approve a rejected or expired row whose prospect has replied", async () => {
    // Row 13 resolves to prospect 44 by email, and 44 has a human reply on file.
    queueRows.set(13, row({ id: 13, status: "expired", sent_at: null }));
    const res = await approveQueueRoute(
      new Request("http://x/api/queue/13/approve", { method: "POST" }),
      { id: "13" },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/replied/);
    expect(statusCalls).toEqual([]);
  });

  it("still approves a rejected row (the override path)", async () => {
    queueRows.set(
      11,
      row({
        id: 11,
        status: "rejected",
        sent_at: null,
        payload_json: JSON.stringify({ name: "Nobody Yet", email: "new@x.example" }),
      }),
    );
    const res = await approveQueueRoute(
      new Request("http://x/api/queue/11/approve", { method: "POST" }),
      {
        id: "11",
      },
    );
    expect(res.status).toBe(200);
    expect(statusCalls).toEqual([{ id: 11, status: "approved", decidedBy: "human" }]);
  });
});
