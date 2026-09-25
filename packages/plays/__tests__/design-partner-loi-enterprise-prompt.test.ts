import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Issue #707: `design-partner-loi-email.md` gains a stricter, code-enforced
 * ENTERPRISE branch (3-sentence cap, opportunity-not-problem framing, no
 * dossier-observation opener, title-keyed register) while government and
 * hardware keep the play's original general rules untouched. This is a drift
 * guard on the prose itself — not just the linter unit tests — so a future
 * edit that quietly rewrites the general rules block, or drops the
 * enterprise section, fails here instead of only showing up as a behaviour
 * change nobody notices.
 */
const here = dirname(fileURLToPath(import.meta.url));
const promptPath = join(here, "..", "..", "prompts", "design-partner-loi-email.md");
const prompt = readFileSync(promptPath, "utf8");

describe("design-partner-loi-email.md — enterprise branch present, government/hardware unchanged (issue #707)", () => {
  it("carries a bumped prompt-version marker so drafts split cleanly in outcome tracking", () => {
    expect(prompt).toMatch(/\[v2\]/);
  });

  it("has a dedicated ENTERPRISE first-touch section, binding and overriding the general rules", () => {
    expect(prompt).toContain("## ENTERPRISE first touch (BUYER TYPE: enterprise only");
    expect(prompt.toLowerCase()).toContain("binding, overrides the general email rules below");
  });

  it("states the 3-sentence / 70-word enterprise body cap", () => {
    expect(prompt).toContain("at most 3 sentences, under 70 words");
  });

  it("bans a dossier-observation opener for the enterprise branch", () => {
    expect(prompt).toContain("No dossier-observation opener");
    expect(prompt).toContain(
      'no "I noticed...", "saw your...", "your team just...", "congrats on..."',
    );
  });

  it("frames the enterprise hook as opportunity, not a problem to fix", () => {
    expect(prompt).toContain("Opportunity, not problem");
    expect(prompt).toContain("never as a gap or a pain they haven't named");
  });

  it("keys the enterprise register on TITLE alone, never on company signals", () => {
    expect(prompt).toContain("Register tracks seniority, from TITLE alone");
    expect(prompt).toContain(
      "Title strings only decide this — never company size, industry or any other signal",
    );
  });

  it("still bans a demo/pilot/LOI ask and discount framing in the enterprise branch", () => {
    const enterpriseSection = prompt.slice(
      prompt.indexOf("## ENTERPRISE first touch"),
      prompt.indexOf("## Email rules (BUYER TYPE: government or hardware"),
    );
    expect(enterpriseSection).toContain("want a demo?");
    expect(enterpriseSection).toContain("book a demo");
    expect(enterpriseSection).toContain("free-trial framing");
    expect(enterpriseSection).toContain("asking for a pilot or an LOI in this first email");
  });

  it("keeps the government/hardware general rules — 4-6 sentences, under 130 words, unchanged", () => {
    expect(prompt).toContain("## Email rules (BUYER TYPE: government or hardware");
    expect(prompt).toContain("Body: 4-6 short sentences, under 130 words");
    expect(prompt).toContain(
      "Hook (1-2 sentences): a specific, true observation about why this buyer is a fit",
    );
    expect(prompt).toContain(
      "CTA (1 sentence): ask for a SCOPED CONVERSATION about a design-partner slot",
    );
  });

  it("scopes the government/hardware section explicitly to exclude enterprise", () => {
    expect(prompt).toContain("the ENTERPRISE section above governs enterprise instead");
  });

  it("never allows a demo, pilot, or LOI ask on the first touch, for any buyer type", () => {
    expect(prompt).toContain("NEVER ask for a pilot or an LOI in this first touch");
    expect((prompt.match(/want a demo\?/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
