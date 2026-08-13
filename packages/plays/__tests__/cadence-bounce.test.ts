import { beforeEach, describe, expect, it, vi } from "vitest";

// Drives pollInboxBounces: DSN → recorded bounce → (hard only) cadence stopped.
// The behaviour that decides whether the tool keeps paying to email an address
// the receiving server has already refused.

type Bounce = {
  messageId: string;
  recipient: string;
  identityId: string;
  kind: "hard" | "block" | "soft";
  statusCode: string | null;
  diagnostic: string | null;
  bouncedAt: string;
};

let bounces: Bounce[] = [];
/** message ids the stub ledger has already stored — mirrors the real PK dedupe. */
let seen: Set<string>;
let recorded: Array<{ recipient: string; kind: string; prospectId: number | null }> = [];
let sequenceEvents: Array<{ playName: string; stepIndex: number; status: string }> = [];
let statusWrites: Array<{ prospectId: number; playName: string; status: string }> = [];

const PROSPECT_EMAIL = "jane@dead.example";
type Row = { prospect_id: number; play_name: string; status: string; current_step: number };
let rows: Row[] = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    listBounces: async () => bounces,
    getLedger: () => ({
      findProspectByEmail: (email: string) =>
        email.trim().toLowerCase() === PROSPECT_EMAIL ? { id: 1 } : null,
      recordBounce: (input: {
        messageId: string;
        recipient: string;
        kind: string;
        prospectId: number | null;
      }) => {
        const key = `${input.messageId}|${input.recipient}`;
        if (seen.has(key)) return false;
        seen.add(key);
        recorded.push({
          recipient: input.recipient,
          kind: input.kind,
          prospectId: input.prospectId,
        });
        return true;
      },
      listCadencesForProspect: (prospectId: number) =>
        rows.filter((r) => r.prospect_id === prospectId),
      recordSequenceEvent: (input: { playName: string; stepIndex: number; status: string }) => {
        sequenceEvents.push({
          playName: input.playName,
          stepIndex: input.stepIndex,
          status: input.status,
        });
        return 1;
      },
      setCadenceStatus: (input: { prospectId: number; playName: string; status: string }) => {
        statusWrites.push(input);
        const row = rows.find(
          (r) => r.prospect_id === input.prospectId && r.play_name === input.playName,
        );
        if (row) row.status = input.status;
      },
    }),
  };
});

const { pollInboxBounces } = await import("../src/_cadence.ts");

function bounce(over: Partial<Bounce> = {}): Bounce {
  return {
    messageId: "dsn-1",
    recipient: PROSPECT_EMAIL,
    identityId: "gmail:me@corp.example",
    kind: "hard",
    statusCode: "5.1.1",
    diagnostic: "smtp; 550 user unknown",
    bouncedAt: "2026-08-01T10:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  bounces = [];
  seen = new Set();
  recorded = [];
  sequenceEvents = [];
  statusWrites = [];
  rows = [{ prospect_id: 1, play_name: "post-funding", status: "active", current_step: 2 }];
});

describe("pollInboxBounces", () => {
  it("stops the cadence on a hard bounce and logs the step that failed", async () => {
    bounces = [bounce()];
    const out = await pollInboxBounces();

    expect(out).toMatchObject({ polled: 1, recorded: 1, cadencesStopped: 1 });
    // current_step is the most recently SENT touch — that's what bounced.
    expect(sequenceEvents).toEqual([{ playName: "post-funding", stepIndex: 2, status: "bounced" }]);
    expect(statusWrites).toEqual([{ prospectId: 1, playName: "post-funding", status: "bounced" }]);
  });

  it("records a policy block WITHOUT stopping the cadence", async () => {
    // 5.7.x is a verdict on the message or our sending domain, not the mailbox.
    // Killing the sequence would discard a live prospect over a spam filter.
    bounces = [bounce({ kind: "block", statusCode: "5.7.1" })];
    const out = await pollInboxBounces();

    expect(out.recorded).toBe(1);
    expect(out.cadencesStopped).toBe(0);
    expect(sequenceEvents).toHaveLength(1);
    expect(statusWrites).toEqual([]);
    expect(rows[0]?.status).toBe("active");
  });

  it("records a soft bounce and takes no further action", async () => {
    bounces = [bounce({ kind: "soft", statusCode: "4.2.2" })];
    const out = await pollInboxBounces();

    expect(recorded).toHaveLength(1);
    expect(out.cadencesStopped).toBe(0);
    expect(sequenceEvents).toEqual([]);
    expect(statusWrites).toEqual([]);
  });

  it("acts only on the first sighting of a DSN", async () => {
    // The 30-day window is re-read every tick; re-acting would re-write the
    // cadence and re-log the event forever.
    bounces = [bounce()];
    await pollInboxBounces();
    sequenceEvents = [];
    statusWrites = [];
    rows[0]!.status = "active";

    const second = await pollInboxBounces();
    expect(second).toMatchObject({ polled: 1, recorded: 0, cadencesStopped: 0 });
    expect(sequenceEvents).toEqual([]);
    expect(statusWrites).toEqual([]);
  });

  it("records a bounce for an unknown address without touching any cadence", async () => {
    // Still counts toward the identity's rate — reputation damage is the same
    // whether or not we happen to track the recipient.
    bounces = [bounce({ recipient: "stranger@elsewhere.example" })];
    const out = await pollInboxBounces();

    expect(recorded).toEqual([
      { recipient: "stranger@elsewhere.example", kind: "hard", prospectId: null },
    ]);
    expect(out.cadencesStopped).toBe(0);
    expect(sequenceEvents).toEqual([]);
    expect(out.details[0]).toMatchObject({ playName: null });
  });

  it("leaves a replied cadence alone", async () => {
    // They answered — the mailbox demonstrably works, whatever this DSN is.
    rows = [{ prospect_id: 1, play_name: "post-funding", status: "replied", current_step: 1 }];
    bounces = [bounce()];
    const out = await pollInboxBounces();

    expect(out.cadencesStopped).toBe(0);
    expect(statusWrites).toEqual([]);
    expect(rows[0]?.status).toBe("replied");
  });

  it("stops every cadence the bounced prospect is enrolled in", async () => {
    rows = [
      { prospect_id: 1, play_name: "post-funding", status: "active", current_step: 0 },
      { prospect_id: 1, play_name: "hiring-signal", status: "active", current_step: 3 },
    ];
    bounces = [bounce()];
    const out = await pollInboxBounces();

    expect(out.cadencesStopped).toBe(2);
    expect(sequenceEvents).toEqual([
      { playName: "post-funding", stepIndex: 0, status: "bounced" },
      { playName: "hiring-signal", stepIndex: 3, status: "bounced" },
    ]);
  });

  it("attributes the bounce to the identity whose mailbox received the DSN", async () => {
    bounces = [bounce({ identityId: "gmail:second@corp.example" })];
    await pollInboxBounces();
    expect(sequenceEvents).toHaveLength(1);
    expect(recorded).toHaveLength(1);
  });
});
