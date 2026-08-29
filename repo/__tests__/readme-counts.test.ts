/**
 * README count guard.
 *
 * The README advertises hard numbers — how many CLI commands, plays and
 * finders ship — and those numbers go stale the moment someone adds a
 * command without re-counting. Each one here is derived from the code that
 * defines it, so the README can only drift for as long as this test is red.
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
function readmeNumber(pattern: RegExp, label: string): number {
  const match = README.match(pattern);
  if (!match?.[1]) {
    throw new Error(
      `README.md no longer contains a "${label}" count matching ${pattern}. ` +
        `Update the pattern in this test alongside the prose.`,
    );
  }
  return Number(match[1]);
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
    const actual = Object.keys(PLAYS).length + NON_EMAIL_PLAYS.length;
    expect(claimed, `README claims ${claimed} plays but code has ${actual}`).toBe(actual);
  });

  it("quotes the right number of finders", () => {
    const claimed = readmeNumber(/(\d+) finders/, "N finders");
    expect(claimed, `README claims ${claimed} finders but code has ${TRIGGERS.length}`).toBe(
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
