import { describe, expect, it } from "vitest";
import { describeDecision } from "@oneshot-gtm/shared-types";
import { buildProspectTimeline } from "../src/api/_prospect-timeline.ts";

const row = {
  play_name: "luma-events",
  found_at: "2026-09-01 08:00:00",
  decided_at: "2026-09-01T09:00:00.000Z",
  decided_by: "machine" as const,
  decision: "auto_reject" as const,
  notes: "auto: not a builder",
  sent_at: null,
};

describe("buildProspectTimeline", () => {
  it("names a skipped letter plainly, with no subject (#610)", () => {
    const out = buildProspectTimeline({
      rows: [row],
      sequenceEvents: [
        {
          id: 2,
          prospect_id: 1,
          play_name: "post-funding",
          step_index: 2,
          channel: "direct_mail",
          status: "skipped",
          metadata_json: JSON.stringify({ label: "Direct mail", reason: "skipped by founder" }),
          created_at: "2026-09-06 07:30:00",
          replied_at: null,
          bounced_at: null,
        },
      ],
      replies: [],
      channelEvents: [],
      outcomes: [],
    });
    const ev = out.find((e) => e.kind === "sequence");
    expect(ev).toMatchObject({ label: "letter skipped", detail: null, playName: "post-funding" });
  });

  it("orders SQLite and ISO timestamps together, newest first", () => {
    const out = buildProspectTimeline({
      rows: [{ ...row, sent_at: "2026-09-02T10:00:00.000Z" }],
      sequenceEvents: [
        {
          id: 1,
          prospect_id: 1,
          play_name: "luma-events",
          step_index: 1,
          channel: "email",
          status: "bounced",
          metadata_json: JSON.stringify({ subject: "following up" }),
          created_at: "2026-09-05 07:30:00",
          replied_at: null,
          bounced_at: null,
        },
      ],
      replies: [
        {
          id: "r",
          thread_key: "t",
          prospect_id: 1,
          play_name: "luma-events",
          from_email: "a@b",
          subject: "Re: hi",
          body: "never surfaced",
          received_at: "2026-09-03T00:00:00.000Z",
          source_identity_id: null,
          thread_id: null,
          message_id: null,
          kind: null,
          intent: null,
          intent_reason: null,
          created_at: "2026-09-03T00:00:00.000Z",
        },
      ],
      channelEvents: [
        {
          id: 1,
          source: "imported",
          external_event_id: "x",
          prospect_id: 1,
          channel: "linkedin",
          event_type: "reply",
          occurred_at: "2026-09-04T00:00:00.000Z",
          body: "hidden",
          created_at: "2026-09-04T00:00:00.000Z",
        },
      ],
      outcomes: [
        {
          id: 1,
          prospect_id: 1,
          play_name: null,
          outcome: "deal_won",
          amount_usd: 2500,
          notes: null,
          recorded_at: "2026-09-06 12:00:00",
        },
      ],
    });
    expect(out.map((e) => [e.kind, e.label])).toEqual([
      ["outcome", "deal won · $2,500"],
      ["sequence", "email step 2 · bounced"],
      ["channel", "linkedin reply"],
      ["reply", "reply"], // NULL kind reads as human; no intent yet
      ["sent", "sent"],
      ["decided", "auto-rejected"],
      ["surfaced", "surfaced"],
    ]);
    expect(out.every((e) => /^\d{4}-\d{2}-\d{2}T/.test(e.at))).toBe(true);
    expect(out.find((e) => e.kind === "decided")?.detail).toBe("auto: not a builder");
    expect(out.find((e) => e.kind === "sequence")?.detail).toBe("following up");
    expect(JSON.stringify(out)).not.toMatch(/never surfaced|hidden/);
  });

  it("uses the step label when the send recorded one, and labels non-human replies by kind", () => {
    const out = buildProspectTimeline({
      rows: [{ ...row, decided_at: null, decision: null, decided_by: null, notes: null }],
      sequenceEvents: [
        {
          id: 1,
          prospect_id: 1,
          play_name: "show-hn",
          step_index: 0,
          channel: "email",
          status: "delivered",
          metadata_json: JSON.stringify({ label: "intro", subject: "s" }),
          created_at: "2026-09-02 07:30:00",
          replied_at: null,
          bounced_at: null,
        },
      ],
      replies: [
        {
          id: "u",
          thread_key: "t",
          prospect_id: 1,
          play_name: null,
          from_email: "a@b",
          subject: null,
          body: "",
          received_at: "2026-09-03T00:00:00.000Z",
          source_identity_id: null,
          thread_id: null,
          message_id: null,
          kind: "unsubscribe",
          intent: null,
          intent_reason: null,
          created_at: "2026-09-03T00:00:00.000Z",
        },
      ],
      channelEvents: [],
      outcomes: [],
    });
    expect(out.map((e) => e.label)).toEqual(["unsubscribed", "email intro", "surfaced"]);
  });
});

describe("buildProspectTimeline ordering", () => {
  it("orders by instant, so a millisecond timestamp and a whole-second one interleave correctly", () => {
    const out = buildProspectTimeline({
      rows: [{ ...row, decided_at: "2026-09-07T19:03:34.900Z", sent_at: null }],
      sequenceEvents: [
        {
          id: 1,
          prospect_id: 1,
          play_name: "luma-events",
          step_index: 0,
          channel: "email",
          status: "sent",
          metadata_json: null,
          // SQLite whole-second form of the same second; lexically "34Z" > "34.900Z".
          created_at: "2026-09-07 19:03:34",
          replied_at: null,
          bounced_at: null,
        },
      ],
      replies: [],
      channelEvents: [],
      outcomes: [],
    });
    expect(out.map((e) => e.kind)).toEqual(["decided", "sequence", "surfaced"]);
  });
});

describe("buildProspectTimeline for the person pane", () => {
  const step = {
    id: 1,
    prospect_id: 1,
    play_name: "luma-events",
    step_index: 0,
    channel: "email" as const,
    status: "sent" as const,
    metadata_json: JSON.stringify({ subject: "hi", body: "the letter" }),
    created_at: "2026-09-02 07:30:00",
    replied_at: null,
    bounced_at: null,
  };
  const reply = {
    id: "r",
    thread_key: "t",
    prospect_id: 1,
    play_name: "luma-events",
    from_email: "a@b",
    subject: "Re: hi",
    body: "their answer",
    received_at: "2026-09-03T00:00:00.000Z",
    source_identity_id: null,
    thread_id: null,
    message_id: null,
    kind: "human",
    intent: null,
    intent_reason: null,
    created_at: "2026-09-03T00:00:00.000Z",
  };
  const callEvent = {
    id: 9,
    source: "call",
    external_event_id: "c1",
    prospect_id: 1,
    channel: "call",
    event_type: "call",
    occurred_at: "2026-09-04T10:00:00.000Z",
    body: null,
    created_at: "2026-09-04T10:00:00.000Z",
  };
  const call = {
    id: 3,
    prospectId: 1,
    playName: "luma-events",
    member: "mia@example.com",
    startedAt: "2026-09-04T10:00:00.000Z",
    durationSec: 42,
    outcome: "voicemail" as const,
    note: "left one",
    provider: "tel" as const,
    transcriptStatus: "none" as const,
    transcript: null,
    suggestion: null,
  };
  const base = {
    rows: [row],
    sequenceEvents: [step],
    replies: [reply],
    channelEvents: [callEvent as never],
    outcomes: [],
  };

  it("carries bodies only when asked", () => {
    const plain = buildProspectTimeline(base);
    expect(plain.some((e) => "body" in e)).toBe(false);
    expect(JSON.stringify(plain)).not.toMatch(/the letter|their answer/);

    const full = buildProspectTimeline({ ...base, withBodies: true });
    expect(full.find((e) => e.kind === "sequence")).toMatchObject({
      body: "the letter",
      channel: "email",
    });
    expect(full.find((e) => e.kind === "reply")).toMatchObject({
      body: "their answer",
      channel: "email",
    });
    expect(full.find((e) => e.kind === "surfaced")?.channel).toBeNull();
  });

  it("never carries a LinkedIn reply's text: it is private to the account's member", () => {
    const linkedinReply = {
      ...callEvent,
      id: 10,
      source: "linkedin",
      external_event_id: "li1",
      channel: "linkedin",
      event_type: "reply",
      body: "a private linkedin message",
    };
    const full = buildProspectTimeline({
      ...base,
      channelEvents: [linkedinReply as never],
      withBodies: true,
    });
    expect(full.find((e) => e.kind === "channel")).toMatchObject({
      label: "linkedin reply",
      channel: "linkedin",
      body: null,
    });
    expect(JSON.stringify(full)).not.toContain("a private linkedin message");
  });

  it("lists logged calls and drops the bare call channel events they wrote", () => {
    const without = buildProspectTimeline(base);
    expect(without.find((e) => e.kind === "channel")).toMatchObject({
      label: "call call",
      channel: "call",
    });

    const out = buildProspectTimeline({
      ...base,
      calls: [call, { ...call, id: 4, outcome: null, startedAt: "2026-09-05T10:00:00.000Z" }],
    });
    expect(out.some((e) => e.kind === "channel")).toBe(false);
    expect(out.filter((e) => e.kind === "call").map((e) => [e.label, e.call?.id])).toEqual([
      ["call · not logged", 4],
      ["call · left voicemail", 3],
    ]);
    expect(out.find((e) => e.call?.id === 3)).toMatchObject({
      channel: "call",
      detail: null,
      playName: "luma-events",
      call: {
        id: 3,
        outcome: "voicemail",
        durationSec: 42,
        note: "left one",
        member: "mia@example.com",
      },
    });
  });

  it("merges the milestones of every queue row, newest first", () => {
    const out = buildProspectTimeline({
      rows: [
        { ...row, play_name: "show-hn", found_at: "2026-10-01 08:00:00", decided_at: null },
        row,
      ],
      sequenceEvents: [],
      replies: [],
      channelEvents: [],
      outcomes: [],
    });
    expect(out.map((e) => [e.kind, e.playName])).toEqual([
      ["surfaced", "show-hn"],
      ["decided", "luma-events"],
      ["surfaced", "luma-events"],
    ]);
  });

  it("attaches the delivery check to its step", () => {
    const delivery = {
      status: "ok" as const,
      observed: 1,
      deliveredAt: ["2026-09-02T07:30:05.000Z"],
    };
    const out = buildProspectTimeline({
      ...base,
      deliveries: new Map([[1, delivery as never]]),
    });
    expect(out.find((e) => e.kind === "sequence")?.delivery).toEqual(delivery);
  });
});

describe("describeDecision (shared vocabulary)", () => {
  it("names who decided, the same way the table and the history do", () => {
    expect(
      describeDecision({
        decision: "approve",
        decidedBy: "human",
        decidedByMember: "mia@example.com",
      }),
    ).toBe("approved by mia@example.com");
    expect(
      describeDecision({
        decision: "reject",
        decidedBy: "machine",
        decidedByMember: "mia@example.com",
      }),
    ).toBe("auto-rejected");
    expect(describeDecision({ decision: "auto_reject", decidedBy: "machine" })).toBe(
      "auto-rejected",
    );
    expect(describeDecision({ decision: "reject", decidedBy: "human" })).toBe("rejected by you");
    expect(describeDecision({ decision: "approve", decidedBy: "human" })).toBe("approved by you");
    expect(describeDecision({ decision: "approve", decidedBy: "human_bulk" })).toBe(
      "bulk-approved",
    );
    expect(describeDecision({ decision: null, decidedBy: null })).toBe("decided");
  });
});
