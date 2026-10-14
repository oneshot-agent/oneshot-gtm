/**
 * The README states no totals, so none can go stale. Check that it stays that
 * way, that the finder guide names every finder in the registry, and that the
 * README headings other files link to are still there.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { TRIGGERS } from "../../packages/find/src/registry.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const README = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
const FINDERS_GUIDE = fs.readFileSync(path.join(REPO_ROOT, "docs/finders.md"), "utf8");

const NUMBER_WORD =
  "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)";
const COUNT = `(?:\\d+|${NUMBER_WORD}(?:-${NUMBER_WORD})?)`;
const COUNTED_NOUN = "(?:commands|plays|finders|pages|tests|cases|files)";
const TOTAL = new RegExp(
  `\\b${COUNT}[- ](?:\\*\\*)?(?:outreach |dashboard |CLI )?${COUNTED_NOUN}\\b`,
  "i",
);

// Linked from TELEMETRY.md, docs/getting-started.md and the CLI's own output.
const LINKED_HEADINGS = [
  "## Setup",
  "## Where targets come from",
  "### The plays",
  "### Direct mail",
  "### Background monitoring as a service",
  "### Watching what's happening",
];

describe("README and finder guide stay true without totals", () => {
  it("states no command, play, finder, page or test totals", () => {
    const offending = README.split("\n").filter((line) => TOTAL.test(line));
    expect(offending, "a total in README goes stale; name the thing or link to it").toEqual([]);
  });

  it("names every finder in the finder guide", () => {
    const missing = TRIGGERS.map((t) => t.name).filter(
      (name) => !FINDERS_GUIDE.includes(`\`${name}\``),
    );
    expect(missing, "docs/finders.md is missing a finder from the registry").toEqual([]);
  });

  it("keeps the headings other files link to", () => {
    const lines = new Set(README.split("\n"));
    expect(LINKED_HEADINGS.filter((heading) => !lines.has(heading))).toEqual([]);
  });
});
