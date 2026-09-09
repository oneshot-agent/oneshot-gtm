import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lintEmail } from "../src/_lib.ts";

/**
 * Issue #593. `accelerator-batch-email.md` tells the model the copy linter
 * catches certain phrases "wherever they appear in the body". For weeks two
 * of the four it named had no pattern, and nothing could have noticed: the
 * existing coverage test checks that the humanizer doc MENTIONS every linter
 * label, never that a prompt's claim about the linter is TRUE. This test
 * checks the useful direction — every phrase the prompt's provenance sentence
 * quotes must actually be flagged when placed mid-body — plus the two other
 * claims the prompt makes about enforcement.
 */
const here = dirname(fileURLToPath(import.meta.url));
const prompt = readFileSync(
  join(here, "..", "..", "prompts", "accelerator-batch-email.md"),
  "utf8",
);
const playSource = readFileSync(join(here, "..", "src", "accelerator-batch.ts"), "utf8");

describe("accelerator-batch-email.md — claims about the linter are true (drift guard)", () => {
  it("every provenance verb the prompt says the linter flags is flagged mid-body", () => {
    const sentence = prompt
      .split("\n")
      .find((line) => line.includes("the copy linter flags those wherever they appear"));
    expect(sentence, "the provenance sentence should still exist").toBeTruthy();
    const phrases = [...sentence!.matchAll(/NEVER ((?:"[^"]+"(?:, )?)+)/g)]
      .flatMap((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((q) => q[1]!))
      .filter((p) => /^I /.test(p));
    expect(phrases.length).toBeGreaterThanOrEqual(4);
    for (const phrase of phrases) {
      const flags = lintEmail("x", `Hey Ada, your launch came up when ${phrase} the S26 list. Sam`);
      expect(
        flags.some((f) => f.startsWith("banned-opener:")),
        `"${phrase}" mid-body`,
      ).toBe(true);
    }
  });

  it("the prompt's 'held the same way' hard bans are actually turned on for the play", () => {
    expect(prompt).toContain("hard bans");
    expect(playSource).toMatch(/hardBans:\s*true/);
  });

  it("the prompt's word cap matches the play's lint threshold", () => {
    const cap = /maxBodyWords:\s*(\d+)/.exec(playSource)?.[1];
    expect(cap).toBeTruthy();
    expect(prompt).toContain(`holds anything past ${cap}`);
  });
});
