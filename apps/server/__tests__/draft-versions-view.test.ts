import { describe, expect, it } from "vitest";
import type { AngleUsageRow, DraftVersionRow } from "@oneshot-gtm/core";
import {
  angleUsageForEdge,
  draftUsageView,
  toDraftVersionView,
} from "../src/api/_draft-versions.ts";

/**
 * Wire projections of the draft-version record: the per-angle tally is
 * mapped onto the trigger's CURRENT edge by normalized text, so an edited or
 * reordered edge cannot mis-assign a count, and a retired angle drops out.
 */

const A = "For a founder selling to clinics — the stack breaks";
const B = "For a CTO shipping agents — egress is the hole";

function row(over: Partial<AngleUsageRow>): AngleUsageRow {
  return {
    angleKey: "",
    angleText: "",
    origin: "configured",
    offered: 0,
    rotatedAway: 0,
    redrafted: 0,
    sent: 0,
    autoSent: 0,
    ...over,
  };
}

describe("angleUsageForEdge", () => {
  it("maps rows onto configured angles in config order, zero where nothing was recorded", () => {
    const usage = angleUsageForEdge({ yourEdge: `${A} // ${B}` }, [
      row({
        angleKey: "for a cto shipping agents egress is the hole",
        angleText: B,
        offered: 4,
        sent: 2,
      }),
    ]);
    expect(usage).toEqual({
      angles: [
        { text: A, offered: 0, rotatedAway: 0, redrafted: 0, sent: 0, autoSent: 0 },
        { text: B, offered: 4, rotatedAway: 0, redrafted: 0, sent: 2, autoSent: 0 },
      ],
      generated: {
        text: "generated",
        offered: 0,
        rotatedAway: 0,
        redrafted: 0,
        sent: 0,
        autoSent: 0,
      },
    });
  });

  it("drops rows for angles no longer in the edge and sums generated rows into one bucket", () => {
    const usage = angleUsageForEdge({ yourClaim: A }, [
      row({
        angleKey: "for a founder selling to clinics the stack breaks",
        angleText: A,
        offered: 1,
      }),
      row({ angleKey: "retired angle", angleText: "Retired angle", offered: 7, sent: 3 }),
      row({
        angleKey: "gen one",
        angleText: "Gen one",
        origin: "generated",
        offered: 2,
        rotatedAway: 1,
      }),
      row({ angleKey: "gen two", angleText: "Gen two", origin: "generated", offered: 1, sent: 1 }),
    ])!;
    expect(usage.angles.map((a) => a.text)).toEqual([A]);
    expect(usage.generated).toEqual({
      text: "generated",
      offered: 3,
      rotatedAway: 1,
      redrafted: 0,
      sent: 1,
      autoSent: 0,
    });
  });

  it("is null without a config or an edge field", () => {
    expect(angleUsageForEdge(null, [])).toBeNull();
    expect(angleUsageForEdge({ cohorts: ["yc-s25"] }, [])).toBeNull();
    expect(angleUsageForEdge({ yourEdge: "   " }, [])).toBeNull();
  });
});

describe("draftUsageView", () => {
  it("passes both scopes through and is null when the play has no versions", () => {
    expect(draftUsageView(undefined)).toBeNull();
    expect(
      draftUsageView({
        intro: { open: 1, regenerated: 2, rotated: 3, sent: 4, autoSent: 5 },
        followUp: { open: 0, regenerated: 0, rotated: 0, sent: 1, autoSent: 0 },
      }),
    ).toEqual({
      intro: { open: 1, regenerated: 2, rotated: 3, sent: 4, autoSent: 5 },
      followUp: { open: 0, regenerated: 0, rotated: 0, sent: 1, autoSent: 0 },
    });
  });
});

describe("toDraftVersionView", () => {
  const base: DraftVersionRow = {
    id: 9,
    play_name: "luma-events",
    prospect_key: "a@x.dev",
    step_index: 0,
    queue_id: 3,
    prospect_id: null,
    subject: "s",
    body: "b",
    flags_json: '["ai-vocab"]',
    angle_key: "a",
    angle_text: "A",
    angle_origin: "configured",
    outcome: "discarded",
    discard_reason: "rotate",
    created_at: "2026-09-15T00:00:00.000Z",
    closed_at: "2026-09-15T00:01:00.000Z",
  };
  it("projects the row and tolerates malformed flags", () => {
    expect(toDraftVersionView(base)).toEqual({
      id: 9,
      stepIndex: 0,
      subject: "s",
      body: "b",
      flags: ["ai-vocab"],
      angle: { text: "A", origin: "configured" },
      outcome: "discarded",
      discardReason: "rotate",
      createdAt: "2026-09-15T00:00:00.000Z",
      closedAt: "2026-09-15T00:01:00.000Z",
    });
    expect(
      toDraftVersionView({ ...base, flags_json: "{oops", angle_text: null, angle_origin: null }),
    ).toMatchObject({ flags: [], angle: null });
  });
});
