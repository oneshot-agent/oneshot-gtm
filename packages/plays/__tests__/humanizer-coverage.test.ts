import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SLOP_PHRASES } from "../src/_lib.ts";

/**
 * Drift guard: every flag label that `lintEmail` can emit should have a
 * recognizable counterpart in `_humanizer.md` so the LLM is told not to
 * produce the pattern in the first place. If a future contributor adds a
 * rule to `lintEmail` without updating the humanizer doc, this test fails.
 */
const here = dirname(fileURLToPath(import.meta.url));
const humanizerPath = join(here, "..", "..", "prompts", "_humanizer.md");
const humanizer = readFileSync(humanizerPath, "utf8").toLowerCase();

interface RuleProbe {
  /** Flag label `lintEmail` emits (or family prefix). */
  flag: string;
  /** A phrase / substring that MUST appear in `_humanizer.md`. */
  marker: string;
}

const PROBES: RuleProbe[] = [
  // SLOP_PHRASES — banned openers
  { flag: "banned-opener:I-noticed", marker: "i noticed" },
  { flag: "banned-opener:I-came-across", marker: "i came across" },
  { flag: "banned-opener:hope-this-finds", marker: "hope this" },
  { flag: "banned-opener:quick-question", marker: "quick question" },
  { flag: "banned-opener:loved-your-launch", marker: "loved your launch" },
  { flag: "banned-opener:reaching-out", marker: "reaching out because" },
  // Banned CTAs
  { flag: "banned-cta:love-to-chat", marker: "i'd love to chat" },
  { flag: "banned-cta:worth-15-min", marker: "worth a 15" },
  { flag: "banned-cta:mind-if-i", marker: "mind if i" },
  // Banned filler
  { flag: "banned-filler:just-wanted-to", marker: "just wanted to" },
  { flag: "banned-filler:curious-to", marker: "curious to" },
  // Servile closers
  { flag: "servile-closer", marker: "let me know if you'd like" },
  // Knowledge-cutoff hedges
  { flag: "knowledge-cutoff-hedge", marker: "as of my last training" },
  // Sycophantic opener
  { flag: "sycophantic-opener", marker: "great question" },
  // Negative parallelism
  { flag: "negative-parallelism", marker: "not just" },
  // Generic positive ending
  { flag: "generic-positive-ending", marker: "the future looks bright" },
  // AI vocab — sample a handful
  { flag: "ai-vocab", marker: "additionally" },
  { flag: "ai-vocab", marker: "delve" },
  // Copula avoidance
  { flag: "copula-avoidance", marker: "serves as" },
  // Format / structural
  { flag: "em-dash", marker: "em dashes" },
  { flag: "curly-quotes", marker: "curly quotes" },
  { flag: "emoji", marker: "emoji" },
  { flag: "rule-of-three", marker: "rule of three" },
  { flag: "excess-exclamations", marker: "max one exclamation" },
  { flag: "subject-shouty", marker: "lowercase the whole subject" },
  { flag: "body-too-long", marker: "≤80 words" },
  { flag: "calendar-link", marker: "calendly" },
];

describe("_humanizer.md covers every lintEmail rule (drift guard)", () => {
  for (const { flag, marker } of PROBES) {
    it(`mentions ${flag} (looking for "${marker}")`, () => {
      expect(humanizer).toContain(marker.toLowerCase());
    });
  }

  it("every SLOP_PHRASES flag label has a probe in this test", () => {
    const probedFlags = new Set(PROBES.map((p) => p.flag));
    for (const [, label] of SLOP_PHRASES) {
      expect(probedFlags, `missing probe for SLOP_PHRASES flag '${label}'`).toContain(label);
    }
  });
});
