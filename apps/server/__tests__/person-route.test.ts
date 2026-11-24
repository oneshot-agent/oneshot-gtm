import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../../packages/core/src/ledger.ts";

// GET /api/person on a real in-memory ledger. Reads only: research comes
// from the paid cache or not at all.

let ledger: Ledger;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, getLedger: () => ledger, logEvent: () => {} };
});

const { personRoute } = await import("../src/api/person.ts");
const core = await import("@oneshot-gtm/core");

async function get(query: string): Promise<{ status: number; body: Record<string, any> }> {
  const res = personRoute(new Request(`http://localhost/api/person?${query}`));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

function enqueue(play: string, payload: Record<string, unknown>): number {
  const id = ledger.enqueueTarget({
    playName: play,
    payload,
    dedupeKey: `${play}:${JSON.stringify(payload)}`,
    source: "test",
  });
  if (id == null) throw new Error("not enqueued");
  return id;
}

beforeEach(() => {
  ledger = new Ledger(":memory:");
});
afterEach(() => ledger.close());

describe("GET /api/person", () => {
  it("answers 400 without exactly one positive id, 404 for an unknown one", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get("prospect=1&queue=1")).status).toBe(400);
    expect((await get("prospect=0")).status).toBe(400);
    expect((await get("prospect=-3")).status).toBe(400);
    expect((await get("queue=1.5")).status).toBe(400);
    expect((await get("queue=abc")).status).toBe(400);
    expect((await get("prospect=999")).status).toBe(404);
    expect((await get("queue=999")).status).toBe(404);
  });

  it("by prospect: every queue row, every touch with its body, calls without duplicates", async () => {
    const pid = ledger.upsertProspect({
      name: "Dana Reyes",
      email: "dana@acme.test",
      company: "Acme",
      linkedin_url: "https://www.linkedin.com/in/dana-r",
    });
    const older = enqueue("show-hn", { email: "dana@acme.test" });
    const newer = enqueue("luma-events", { email: "dana@acme.test" });
    ledger.setQueueProspectId(older, pid);
    ledger.setQueueProspectId(newer, pid);
    ledger.recordSequenceEvent({
      prospectId: pid,
      playName: "luma-events",
      stepIndex: 0,
      channel: "email",
      status: "sent",
      metadata: { subject: "hi Dana", body: "the letter" },
    });
    ledger.recordInboxReply({
      id: "r1",
      threadKey: "t1",
      prospectId: pid,
      playName: "luma-events",
      fromEmail: "dana@acme.test",
      subject: "Re: hi Dana",
      body: "sounds good",
      receivedAt: new Date().toISOString(),
      kind: "human",
    });
    const startedAt = new Date().toISOString();
    const callId = ledger.insertCall({
      prospectId: pid,
      playName: "luma-events",
      startedAt,
      outcome: "voicemail",
      note: "left one",
    });
    ledger.recordCallChannelEvent({
      callId,
      prospectId: pid,
      outcome: "voicemail",
      occurredAt: startedAt,
    });

    const { status, body } = await get(`prospect=${pid}`);
    expect(status).toBe(200);
    expect(body.prospect).toMatchObject({
      id: pid,
      name: "Dana Reyes",
      email: "dana@acme.test",
      company: "Acme",
      linkedinUrl: "https://www.linkedin.com/in/dana-r",
    });
    // The newest queue row, by the same order getQueueRowForProspect uses.
    expect(body.queueId).toBe(ledger.getQueueRowForProspect(pid)?.id);
    expect(body.dossier.status).toBe("none");
    expect(body.flags).toMatchObject({ replied: true, bounced: false, icpReject: false });
    expect(body.cadences).toEqual([]);

    const touches = body.touches as Array<Record<string, any>>;
    expect(
      touches
        .filter((t) => t.kind === "surfaced")
        .map((t) => t.playName)
        .toSorted(),
    ).toEqual(["luma-events", "show-hn"]);
    expect(touches.find((t) => t.kind === "sequence")).toMatchObject({
      body: "the letter",
      channel: "email",
    });
    expect(touches.find((t) => t.kind === "reply")).toMatchObject({
      body: "sounds good",
      channel: "email",
    });
    expect(touches.filter((t) => t.channel === "call")).toEqual([
      expect.objectContaining({
        kind: "call",
        label: "call · left voicemail",
        call: expect.objectContaining({ id: callId, outcome: "voicemail", note: "left one" }),
      }),
    ]);
  });

  it("by prospect with no queue row: research found by the prospect's LinkedIn URL", async () => {
    const url = "https://www.linkedin.com/in/solo-person";
    const pid = ledger.upsertProspect({ name: "Solo", email: "solo@x.test", linkedin_url: url });
    core.getSharedDb().setPaidCache({
      key: core.paidCacheKey("research.person", { socialMediaUrl: url }),
      callType: "research.person",
      status: "ok",
      resultJson: JSON.stringify({ result: { full_name: "Solo Person", title: "CTO" } }),
      costUsd: null,
    });
    const { status, body } = await get(`prospect=${pid}`);
    expect(status).toBe(200);
    expect(body.queueId).toBeNull();
    expect(body.dossier).toMatchObject({
      status: "complete",
      person: { fullName: "Solo Person", title: "CTO" },
    });
    expect(body.touches).toEqual([]);
  });

  it("by queue row: resolves its prospect by payload email", async () => {
    const pid = ledger.upsertProspect({ name: "Ira", email: "ira@x.test" });
    ledger.setProspectIcpVerdict(pid, "reject", "not a buyer");
    const qid = enqueue("show-hn", { email: "ira@x.test" });
    const { status, body } = await get(`queue=${qid}`);
    expect(status).toBe(200);
    expect(body.prospect).toMatchObject({ id: pid, icpVerdict: "reject" });
    expect(body.queueId).toBe(qid);
    expect(body.flags.icpReject).toBe(true);
    expect(body.touches.map((t: { kind: string }) => t.kind)).toEqual(["surfaced"]);
  });

  it("by queue row with no prospect: the row's milestones and payload flags only", async () => {
    const qid = enqueue("show-hn", { email: "nobody@x.test", icpVerdict: "reject" });
    const { status, body } = await get(`queue=${qid}`);
    expect(status).toBe(200);
    expect(body.prospect).toBeNull();
    expect(body.queueId).toBe(qid);
    expect(body.dossier.status).toBe("none");
    expect(body.cadences).toEqual([]);
    expect(body.flags).toEqual({
      replied: false,
      bounced: false,
      contactSuppressed: null,
      breakupHold: false,
      icpReject: true,
    });
    expect(body.touches).toEqual([
      expect.objectContaining({ kind: "surfaced", playName: "show-hn", channel: null }),
    ]);
  });

  it("falls back to the prospect's own researched record when nothing else has research", async () => {
    const pid = ledger.upsertProspect({
      name: "Rae",
      email: "rae@x.test",
      dossier_json: JSON.stringify({
        person: {
          summary: "Runs payments at a clinic group.",
          location: "Leeds",
          researchedAt: "2026-11-01T00:00:00.000Z",
          organizations: [{ name: "Clinicly", title: "Head of Payments", is_current: true }],
        },
      }),
    });
    const { status, body } = await get(`prospect=${pid}`);
    expect(status).toBe(200);
    expect(body.dossier).toMatchObject({
      status: "summary-only",
      researchedAt: "2026-11-01T00:00:00.000Z",
      person: { summary: "Runs payments at a clinic group.", location: "Leeds" },
      experience: [{ company: "Clinicly", title: "Head of Payments", current: true }],
    });
  });
});
