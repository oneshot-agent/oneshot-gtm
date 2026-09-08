/**
 * README count guard.
 *
 * The README advertises hard numbers — how many CLI commands, plays and
 * finders ship — and those numbers go stale the moment someone adds a
 * command without re-counting. Each one here is derived from the code that
 * defines it, so the README can only drift for as long as this test is red.
 *
 * Some of those numbers appear twice: as digits in the tables and spelled out
 * in the prose above them ("Seventeen of them", "Eleven **finders**"). Both are
 * claims a visitor reads, and both drift on the same commit, so both are
 * asserted.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Command } from "commander";
import { PLAYS } from "../../packages/plays/src/registry.ts";
import { TRIGGERS } from "../../packages/find/src/registry.ts";
// `PLAYS` is the *email* dispatch table, so it is two short of the play count
// the README quotes: concierge is a voice play and demo-no-show is SMS, and
// both are invoked straight from the CLI's `motion` group rather than through
// the shared email runner. Importing their runners keeps the +2 honest — delete
// either file and this test stops compiling rather than quietly under-counting.
import { runConcierge } from "../../packages/plays/src/concierge.ts";
import { runDemoNoShow } from "../../packages/plays/src/demo-no-show.ts";

const NON_EMAIL_PLAYS = [runConcierge, runDemoNoShow];
const playCount = Object.keys(PLAYS).length + NON_EMAIL_PLAYS.length;

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const README = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");

/**
 * A leaf command is one a user can actually invoke — `find drain`, not the
 * `find` group that only exists to hold it. Groups print help and exit, so
 * counting them would inflate the total the README quotes.
 */
function countLeafCommands(cmd: Command): number {
  let leaves = 0;
  for (const sub of cmd.commands) {
    leaves += sub.commands.length === 0 ? 1 : countLeafCommands(sub);
  }
  return leaves;
}

/** Pull a single capture group out of the README, failing loudly if the prose moved. */
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

/**
 * Turn a spelled-out count ("seventeen", "twenty-one") into a number. The
 * README writes its counts as words in prose and as digits in the tables, and
 * both drift together — so the word forms need the same guard the digits get.
 */
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

/** Same as `readmeNumber`, but for a count the README spells out in prose. */
function readmeWordNumber(pattern: RegExp, label: string): number {
  return wordToNumber(readmeCapture(pattern, label));
}

let commandCount: number;

beforeAll(async () => {
  // index.ts parses process.argv at import time when it is the real CLI entry
  // point; the sentinel suppresses that so we get the command tree only.
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

  // "Seventeen of them." opens the play list a visitor actually reads, and it
  // goes stale on exactly the commits the digit form does.
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

  // Likewise "Eleven **finders** discover prospects" — the sentence that
  // introduces the finder table, one section above the digit form.
  it("spells out the right number of finders above the finder table", () => {
    const claimed = readmeWordNumber(
      /^([A-Za-z]+(?:-[A-Za-z]+)?) \*\*finders\*\*/m,
      "'<Word> **finders**'",
    );
    expect(claimed, `README spells out ${claimed} finders but code has ${TRIGGERS.length}`).toBe(
      TRIGGERS.length,
    );
  });

  // The README also quotes "N cases across M files" for the test suite, and
  // those two numbers are deliberately NOT asserted here. They are the one
  // pair a test cannot check honestly: any commit that adds or removes a test
  // changes them, and this file is itself a test — so the assertion would fail
  // against the very commit that updates the README to the correct figure, and
  // the correct figure depends on whether this test's own cases are counted.
  // A self-referential guard like that reports red on every green change. The
  // suite totals are spot-checked against a real `bun run test` run instead.
  // We do still confirm the sentence exists, so a reformat can't silently drop
  // the numbers the maintainer is expected to refresh.
  it("still states the test-suite totals for a human to refresh", () => {
    expect(README).toMatch(/(\d+) cases across (\d+) files/);
  });
});
