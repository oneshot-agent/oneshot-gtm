import { describe, expect, it } from "vitest";
import {
  angleKey,
  isNeverSent,
  neverSentAngles,
  removeAngleFromConfigText,
} from "../src/lib/angleRetire.ts";

const A = "For a founder selling to clinics — the stack breaks on the second touch";
const B = "For a CTO shipping agents — egress is the hole";
const C = "For someone in a marketing role — attribution dies at the handoff";

describe("removeAngleFromConfigText", () => {
  it("drops the angle by normalized match and re-serializes with the editor's indentation", () => {
    const text = JSON.stringify({ cohorts: ["yc-s25"], yourEdge: `${A} // ${B} // ${C}` }, null, 2);
    const next = removeAngleFromConfigText(text, "for a cto shipping agents egress is the hole");
    expect(next).toBe(JSON.stringify({ cohorts: ["yc-s25"], yourEdge: `${A} // ${C}` }, null, 2));
  });

  it("handles yourClaim and a single remaining angle", () => {
    const text = JSON.stringify({ yourClaim: `${A} // ${B}` });
    expect(JSON.parse(removeAngleFromConfigText(text, A)!)).toEqual({ yourClaim: B });
  });

  it("returns null when the text is not a JSON object, has no edge, or lacks the angle", () => {
    expect(removeAngleFromConfigText("not json", A)).toBeNull();
    expect(removeAngleFromConfigText("[1,2]", A)).toBeNull();
    expect(removeAngleFromConfigText(JSON.stringify({ cohorts: [] }), A)).toBeNull();
    expect(removeAngleFromConfigText(JSON.stringify({ yourEdge: B }), A)).toBeNull();
  });

  it("angleKey matches the ledger's normalization", () => {
    expect(angleKey("For a Founder — selling to clinics!")).toBe(
      "for a founder selling to clinics",
    );
  });
});

const row = (over: Partial<Parameters<typeof isNeverSent>[0]>) => ({
  text: "x",
  offered: 0,
  rotatedAway: 0,
  redrafted: 0,
  sent: 0,
  autoSent: 0,
  ...over,
});

describe("never-sent angles", () => {
  it("flags zero sends after two rotations or three offers, never a sent angle", () => {
    expect(isNeverSent(row({ rotatedAway: 2 }))).toBe(true);
    expect(isNeverSent(row({ offered: 3 }))).toBe(true);
    expect(isNeverSent(row({ offered: 2, rotatedAway: 1 }))).toBe(false);
    expect(isNeverSent(row({ offered: 9, rotatedAway: 5, sent: 1 }))).toBe(false);
  });
  it("neverSentAngles tolerates a missing tally", () => {
    expect(neverSentAngles(undefined)).toEqual([]);
    expect(neverSentAngles(null)).toEqual([]);
    expect(
      neverSentAngles({
        angles: [row({ offered: 3 }), row({ text: "y", sent: 2 })],
        generated: row({}),
      }),
    ).toEqual([row({ offered: 3 })]);
  });
});
