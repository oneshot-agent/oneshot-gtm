import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Drift guard for the claim-grounding rules in reply-email.md. A LinkedIn
 * reply (2026-09-11) answered "is the receipt log the source of truth you
 * replay from?" with yes, in the prospect's own vocabulary, because nothing
 * in the prompt separated what the brief says from what the sender just
 * said. These assertions fail if a future edit to the .md drops the rules.
 */
const here = dirname(fileURLToPath(import.meta.url));
const prompt = readFileSync(join(here, "..", "..", "prompts", "reply-email.md"), "utf8");

describe("reply-email.md — claim grounding (drift guard)", () => {
  it("names the brief as the only source of product facts", () => {
    expect(prompt).toContain("PRODUCT BRIEF is the only source of product facts");
  });

  it("forbids describing the product in the sender's vocabulary", () => {
    expect(prompt).toContain("never in the sender's vocabulary from their message");
  });

  it("forbids affirming a capability the brief does not establish", () => {
    expect(prompt).toContain("PRODUCT BRIEF does not establish X, do not say yes");
  });

  it("forbids war stories and anecdotes outside the brief", () => {
    expect(prompt).toContain('No war stories, no "saved us from"');
  });

  it("requires conceding a correct point the brief cannot refute", () => {
    expect(prompt).toContain("concede it plainly in the first sentence");
  });

  it("explains the ICP gate as context the thread outranks", () => {
    expect(prompt).toContain("ICP GATE (optional)");
    expect(prompt).toContain("The thread outranks it");
    expect(prompt).toContain("Never mention the gate to them");
  });
});
