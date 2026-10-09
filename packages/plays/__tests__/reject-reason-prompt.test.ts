import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Drift guard for reject-reason.md: the prefill must read the company and
// dossier facts, treat the surfacing event as provenance, and name stage
// mismatches with the fact that shows them.
const here = dirname(fileURLToPath(import.meta.url));
const prompt = readFileSync(join(here, "..", "..", "prompts", "reject-reason.md"), "utf8");

describe("reject-reason.md", () => {
  it("names COMPANY and DOSSIER as inputs read before the finder's line", () => {
    expect(prompt).toContain("COMPANY (optional)");
    expect(prompt).toContain("DOSSIER (optional)");
    expect(prompt).toContain("Read COMPANY and DOSSIER before PROSPECT");
  });

  it("treats the surfacing event as provenance, never a reason", () => {
    expect(prompt).toContain("is provenance, never a reason");
  });

  it("returns a category alongside the sentence, one per rejection reason", () => {
    for (const category of [
      "wrong_audience",
      "wrong_person",
      "bad_timing",
      "already_contacted",
      "draft_problem",
      "other",
    ]) {
      expect(prompt).toContain(`\`${category}\``);
    }
    expect(prompt).toContain('"decisionReason"');
    // The evidence alone can only establish a fit mismatch.
    expect(prompt).toContain("use one ONLY when the FOUNDER HINT says so");
  });

  it("treats a founder hint as the reason to state, never to second-guess", () => {
    expect(prompt).toContain("FOUNDER HINT (optional)");
    expect(prompt).toContain("A `category` in the hint is final");
    expect(prompt).toContain("Never contradict the hint");
  });

  it("asks for the stage fact to be cited", () => {
    expect(prompt).toContain("Stage is the most common mismatch");
    expect(prompt).toContain("cite the fact");
  });
});
