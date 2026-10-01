import { describe, expect, it } from "vitest";
import type { SendDeliveryView } from "@oneshot-gtm/shared-types";
import { buildProspectTimeline, deliveryNote } from "../src/api/_prospect-timeline.ts";

const row = {
  play_name: "accelerator-batch",
  found_at: "2026-09-27 08:00:00",
  decided_at: "2026-09-28T07:05:49.383Z",
  decided_by: "human" as const,
  decision: "approve" as const,
  notes: null,
  sent_at: "2026-09-29T01:59:02.916Z",
};

const event = {
  id: 1518,
  prospect_id: 860,
  play_name: "accelerator-batch",
  step_index: 0,
  channel: "email",
  status: "sent",
  metadata_json: JSON.stringify({ subject: "perceptron ml" }),
  created_at: "2026-09-29 01:59:02",
  replied_at: null,
  bounced_at: null,
  receipt_id: 28169,
};

const dup: SendDeliveryView = {
  status: "duplicate",
  expected: 1,
  observed: 3,
  deliveredAt: ["2026-09-29T02:00:14.000Z", "2026-09-29T02:00:38.000Z", "2026-09-29T02:01:18.000Z"],
  sentAt: "2026-09-29T01:59:02.000Z",
  checkedAt: "2026-09-29T02:10:00.000Z",
  transport: "smartlead",
  identity: "smartlead:jn@mail.example",
  error: null,
};

describe("buildProspectTimeline delivery checks", () => {
  it("adds a mismatch as its own entry with the copy times", () => {
    const out = buildProspectTimeline({
      row,
      sequenceEvents: [event as never],
      replies: [],
      channelEvents: [],
      outcomes: [],
      deliveries: new Map([[1518, dup]]),
    });
    const entry = out.find((e) => e.label === "delivered 3× by the mail provider");
    expect(entry).toBeDefined();
    expect(entry?.detail).toBe("02:00:14, 02:00:38, 02:01:18 UTC");
  });

  it("a clean check adds nothing", () => {
    expect(deliveryNote({ ...dup, status: "ok", observed: 1 })).toBeNull();
    const out = buildProspectTimeline({
      row,
      sequenceEvents: [event as never],
      replies: [],
      channelEvents: [],
      outcomes: [],
      deliveries: new Map([[1518, { ...dup, status: "ok", observed: 1 }]]),
    });
    expect(out.some((e) => e.label.includes("delivered"))).toBe(false);
  });
});
