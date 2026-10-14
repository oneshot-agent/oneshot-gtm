/**
 * The Plays page offers a Copy CLI string per play. Check that each one that
 * is a command names a real leaf of the command tree, with flags that command
 * takes and an example file that exists.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Command } from "commander";
import { listPlays } from "../../apps/server/src/api/plays.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

let program: Command;
let plays: Array<{ name: string; cliInvocation: string }>;

beforeAll(async () => {
  // Import the command tree without parsing the test runner's argv.
  process.env["ONESHOT_GTM_CLI_NO_PARSE"] = "1";
  ({ program } = await import("../../apps/cli/src/index.ts"));
  const response = listPlays(new Request("http://localhost/api/plays"));
  ({ plays } = (await response.json()) as { plays: typeof plays });
});

/** Why a Copy CLI string would fail when pasted, or null when it would run. */
function problem(cli: string): string | null {
  const words = (cli.split("#")[0] ?? "").trim().split(/\s+/).slice(1);
  let cmd = program;
  let i = 0;
  for (; i < words.length && !words[i]!.startsWith("-"); i++) {
    const next = cmd.commands.find((c) => c.name() === words[i]);
    if (!next) break;
    cmd = next;
  }
  if (cmd.commands.length > 0) return `no command "${words.slice(0, i + 1).join(" ")}"`;
  const args = words.slice(i);
  const positionals = args.filter((w, n) => !w.startsWith("-") && !args[n - 1]?.startsWith("-"));
  if (positionals.length > cmd.registeredArguments.length) {
    return `"${cmd.name()}" has no "${positionals[cmd.registeredArguments.length]}"`;
  }
  for (const word of args) {
    if (word.startsWith("--") && !cmd.options.some((o) => o.long === word)) {
      return `"${cmd.name()}" takes no ${word}`;
    }
    if (word.startsWith("./") && !fs.existsSync(path.join(REPO_ROOT, word))) {
      return `${word} does not exist`;
    }
  }
  return null;
}

describe("Copy CLI strings on the Plays page", () => {
  it("names a command that exists, with its own flags and a real example file", () => {
    const commands = plays.filter((p) => p.cliInvocation.startsWith("oneshot-gtm "));
    expect(commands.length).toBeGreaterThan(0);
    const broken = commands
      .map((p) => ({ play: p.name, problem: problem(p.cliInvocation) }))
      .filter((p) => p.problem !== null);
    expect(broken).toEqual([]);
  });

  it("catches a subcommand that is not in the tree", () => {
    expect(problem("oneshot-gtm motion show-hn --target ./examples/show-hn.json")).toBe(
      'no command "motion show-hn"',
    );
    expect(problem("oneshot-gtm motion post-funding --sender-cohort yc-w26")).toBe(
      '"post-funding" takes no --sender-cohort',
    );
  });
});
