/**
 * Check README command, play, and finder counts against their registries.
 * Check both table digits and spelled-out counts in prose.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Command } from "commander";
import { PLAYS } from "../../packages/plays/src/registry.ts";
import { TRIGGERS } from "../../packages/find/src/registry.ts";
// Voice and SMS plays bypass the email registry. Import their runners so removal
// fails compilation instead of leaving the count inflated.
import { runConcierge } from "../../packages/plays/src/concierge.ts";
import { runDemoNoShow } from "../../packages/plays/src/demo-no-show.ts";

const NON_EMAIL_PLAYS = [runConcierge, runDemoNoShow];
const playCount = Object.keys(PLAYS).length + NON_EMAIL_PLAYS.length;

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const README = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");

/** Count invokable leaf commands; groups only print help. */
function countLeafCommands(cmd: Command): number {
  let leaves = 0;
  for (const sub of cmd.commands) {
    leaves += sub.commands.length === 0 ? 1 : countLeafCommands(sub);
  }
  return leaves;
}

function readmeCapture(pattern: RegExp, label: string): string {
  const match = README.match(pattern);
  if (!match?.[1]) {
    throw new Error(
      `README.md no longer contains a "${label}" count matching ${pattern}. ` +
        `Update the pattern in this test alongside the prose.`,
    );
  }
  return match[1];
}

function readmeNumber(pattern: RegExp, label: string): number {
  return Number(readmeCapture(pattern, label));
}

const ONES: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

function wordToNumber(word: string): number {
  const parts = word.toLowerCase().split("-");
  if (parts.length === 1) {
    const single = ONES[parts[0]!] ?? TENS[parts[0]!];
    if (single === undefined) {
      throw new Error(
        `"${word}" is not a number word this test knows. Extend ONES/TENS if the ` +
          `count grew past what they cover.`,
      );
    }
    return single;
  }
  const [tens, ones] = parts;
  if (parts.length !== 2 || TENS[tens!] === undefined || ONES[ones!] === undefined) {
    throw new Error(
      `"${word}" is not a number word this test knows. Extend ONES/TENS if the ` +
        `count grew past what they cover.`,
    );
  }
  return TENS[tens!]! + ONES[ones!]!;
}

function readmeWordNumber(pattern: RegExp, label: string): number {
  return wordToNumber(readmeCapture(pattern, label));
}

let commandCount: number;

beforeAll(async () => {
  // Import the command tree without parsing the test runner's argv.
  process.env["ONESHOT_GTM_CLI_NO_PARSE"] = "1";
  const { program } = await import("../../apps/cli/src/index.ts");
  commandCount = countLeafCommands(program);
});

describe("README counts match the code", () => {
  it("quotes the right number of CLI commands in the command table", () => {
    const claimed = readmeNumber(/^(\d+) commands —/m, "N commands");
    expect(claimed, `README claims ${claimed} commands but code has ${commandCount}`).toBe(
      commandCount,
    );
  });

  it("quotes the right number of CLI commands in the layout tree", () => {
    const claimed = readmeNumber(/(\d+)-command CLI/, "N-command CLI");
    expect(claimed, `README claims a ${claimed}-command CLI but code has ${commandCount}`).toBe(
      commandCount,
    );
  });

  it("quotes the right number of plays", () => {
    const claimed = readmeNumber(/(\d+) outreach plays/, "N outreach plays");
    expect(claimed, `README claims ${claimed} plays but code has ${playCount}`).toBe(playCount);
  });

  it("spells out the right number of plays in the play list", () => {
    const claimed = readmeWordNumber(/^([A-Za-z]+(?:-[A-Za-z]+)?) of them\./m, "'<Word> of them'");
    expect(claimed, `README spells out ${claimed} plays but code has ${playCount}`).toBe(playCount);
  });

  it("quotes the right number of finders", () => {
    const claimed = readmeNumber(/(\d+) finders/, "N finders");
    expect(claimed, `README claims ${claimed} finders but code has ${TRIGGERS.length}`).toBe(
      TRIGGERS.length,
    );
  });

  it("spells out the right number of finders above the finder table", () => {
    const claimed = readmeWordNumber(
      /^([A-Za-z]+(?:-[A-Za-z]+)?) \*\*finders\*\*/m,
      "'<Word> **finders**'",
    );
    expect(claimed, `README spells out ${claimed} finders but code has ${TRIGGERS.length}`).toBe(
      TRIGGERS.length,
    );
  });

  // Suite totals are checked against an actual test run; only require the claim here.
  it("still states the test-suite totals for a human to refresh", () => {
    expect(README).toMatch(/(\d+) cases across (\d+) files/);
  });
});
