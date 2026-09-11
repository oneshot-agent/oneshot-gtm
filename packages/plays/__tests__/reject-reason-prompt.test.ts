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

  it("asks for the stage fact to be cited", () => {
    expect(prompt).toContain("Stage is the most common mismatch");
    expect(prompt).toContain("cite the fact");
  });
});
