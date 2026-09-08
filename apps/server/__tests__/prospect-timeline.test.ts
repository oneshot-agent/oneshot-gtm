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
  it("orders SQLite and ISO timestamps together, newest first", () => {
    const out = buildProspectTimeline({
      row: { ...row, sent_at: "2026-09-02T10:00:00.000Z" },
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
          source: "expandi",
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
      row: { ...row, decided_at: null, decision: null, decided_by: null, notes: null },
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
      row: { ...row, decided_at: "2026-09-07T19:03:34.900Z", sent_at: null },
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
        },
      ],
      replies: [],
      channelEvents: [],
      outcomes: [],
    });
    expect(out.map((e) => e.kind)).toEqual(["decided", "sequence", "surfaced"]);
  });
});

describe("describeDecision (shared vocabulary)", () => {
  it("names who decided, the same way the table and the history do", () => {
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
