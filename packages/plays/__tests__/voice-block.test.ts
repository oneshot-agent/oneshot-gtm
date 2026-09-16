import { beforeEach, describe, expect, it, vi } from "vitest";

// The VOICE block: the founder's register card reaches the drafts as one
// runtime input block, mirrors socialProofBlock's contract (null when blank),
// carries a per-surface budget that keeps it under the humanizer, and stays
// platform-generic — no founder, product or influence named in the directive.

let cfgOverride: Record<string, unknown> = {};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), founderVoice: null, ...cfgOverride }),
  };
});

const { voiceBlock, voiceKey } = await import("../src/_lib.ts");

const CARD = [
  "MOVES",
  "- a concrete fact, then the mechanism under it, then one flat line that closes it",
  "SENTENCES",
  "- short declaratives; one long build, then a blunt one; lowercase body",
  "NEVER",
  "- hedges, hype, exclamation marks",
  "EXEMPLARS",
  "- cost is not friction. cost is information.",
].join("\n");

beforeEach(() => {
  cfgOverride = {};
});

describe("voiceBlock", () => {
  it("is null when no card is set, blank or whitespace", () => {
    expect(voiceBlock("intro")).toBeNull();
    cfgOverride = { founderVoice: "   \n " };
    expect(voiceBlock("intro")).toBeNull();
  });

  it("carries the card verbatim with the directive and the surface's budget line", () => {
    cfgOverride = { founderVoice: CARD };
    const out = voiceBlock("intro")!;
    expect(out.text.startsWith("VOICE (")).toBe(true);
    expect(out.text).toContain(CARD);
    expect(out.text).toContain("VOICE BUDGET: at most ONE aphoristic");
    expect(out.text).toContain("never in the CTA");
    expect(out.text).toContain("never as \"X isn't A, it's B\"");
    expect(out.key).toBe(voiceKey(CARD));
    expect(out.key).toMatch(/^[0-9a-f]{8}$/);
  });

  it("gives a breakup no aphorism and a reply none in logistics mode", () => {
    cfgOverride = { founderVoice: CARD };
    expect(voiceBlock("breakup")!.text).toContain("no aphorism in a breakup");
    expect(voiceBlock("breakup")!.text).not.toContain("at most ONE");
    expect(voiceBlock("reply")!.text).toContain("logistics mode");
    expect(voiceBlock("followup")!.text).toContain("at most ONE aphoristic");
  });

  it("truncates an over-long card but keys on the whole of it", () => {
    const long = `${CARD}\n${"x".repeat(2000)}`;
    cfgOverride = { founderVoice: long };
    const out = voiceBlock("intro")!;
    expect(out.text).not.toContain("x".repeat(1500));
    expect(out.text.length).toBeLessThan(long.length);
    expect(out.key).toBe(voiceKey(long));
    expect(out.key).not.toBe(voiceKey(CARD));
  });

  it("keeps the directive platform-generic: the card is the only founder-specific text", () => {
    cfgOverride = { founderVoice: "MOVES\n- x" };
    const out = voiceBlock("intro")!.text;
    for (const rx of [/oneshot/i, /taleb/i, /agent/i, /founder's name/i])
      expect(out).not.toMatch(rx);
  });

  it("the key is stable across whitespace at the edges only", () => {
    expect(voiceKey("  a card \n")).toBe(voiceKey("a card"));
    expect(voiceKey("a card")).not.toBe(voiceKey("a  card"));
  });
});
