import { beforeEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { getLedger } from "@oneshot-gtm/core";
import { measureLinkedIn } from "../src/api/measure.ts";

// GET /api/measure/linkedin over a real ledger in the isolated test home.

const req = (qs = ""): Request =>
  new Request(`http://localhost/api/measure/linkedin${qs}`, {
    headers: { host: "127.0.0.1:3030" },
  });

beforeEach(() => {
  getLedger(); // creates the schema in the isolated home
  const db = new Database(`${process.env["ONESHOT_GTM_HOME"]}/ledger.sqlite`);
  db.exec("DELETE FROM sequence_events; DELETE FROM channel_events;");
  db.close();
});

function invite(name: string, step: number, accepted: boolean): void {
  const ledger = getLedger();
  const prospectId = ledger.upsertProspect({
    name,
    email: `${name.toLowerCase()}@example.test`,
    linkedin_url: `https://linkedin.com/in/${name.toLowerCase()}`,
  });
  if (step > 0) {
    ledger.recordSequenceEvent({
      prospectId,
      playName: "luma-events",
      stepIndex: 0,
      channel: "email",
      status: "sent",
      metadata: {},
    });
  }
  ledger.recordLinkedInInviteEvent({
    prospectId,
    playName: "luma-events",
    stepIndex: step,
    status: "sent",
    metadata: {
      evidenceClause: accepted,
      ...(accepted ? { acceptedAt: new Date().toISOString() } : {}),
    },
  });
}

describe("measureLinkedIn", () => {
  it("returns the funnel, the variant split and the filters in effect", async () => {
    invite("Una", 0, true);
    invite("Vic", 2, false);
    const res = measureLinkedIn(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.funnel.invitesSent).toBe(2);
    expect(body.funnel.accepted.total).toBe(1);
    expect(body.variants.withEvidence.invitesSent).toBe(1);
    expect(body.variants.withoutEvidence.invitesSent).toBe(1);
    expect(body.filters).toEqual({ sinceDays: null, play: null, stepKind: null });
  });

  it("filters by step kind and play", async () => {
    invite("Una", 0, true);
    invite("Vic", 2, false);
    const cont = (await measureLinkedIn(req("?stepKind=continuation")).json()) as any;
    expect(cont.funnel.invitesSent).toBe(1);
    expect(cont.filters.stepKind).toBe("continuation");
    const play = (await measureLinkedIn(req("?play=other-play")).json()) as any;
    expect(play.funnel.invitesSent).toBe(0);
  });

  it("refuses a step kind it does not know", async () => {
    const res = measureLinkedIn(req("?stepKind=friend"));
    expect(res.status).toBe(400);
  });

  it("returns an empty funnel for a workspace with no invites", async () => {
    const body = (await measureLinkedIn(req()).json()) as any;
    expect(body.funnel.invitesSent).toBe(0);
    expect(body.funnel.repliedToFirstMessage.rate).toBeNull();
  });
});
