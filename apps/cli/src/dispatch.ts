import type { Command } from "commander";

/**
 * Pure helpers for turning commander's action arguments into the small
 * telemetry envelope (command path + flag names). Extracted from index.ts so
 * they can be unit-tested without importing the CLI entrypoint, which runs
 * `program.parseAsync` on import.
 */

export interface Invocation {
  command: string;
  flags: string[];
}

/** `dryRun` → `dry-run`, `skipSms` → `skip-sms`. Names only — never values. */
export function toKebabCase(s: string): string {
  return s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

/**
 * Recover the command path and the flag names the user actually passed from
 * commander's action arguments. The Command instance is the last action arg;
 * we walk its parent chain (stopping before the root program) to build paths
 * like "motion show-hn", and use getOptionValueSource to keep only flags set
 * on the CLI — never their values.
 */
export function extractInvocation(args: unknown[]): Invocation {
  const cmd = args.findLast(
    (a): a is Command =>
      !!a &&
      typeof a === "object" &&
      typeof (a as Command).name === "function" &&
      typeof (a as Command).opts === "function",
  );
  if (!cmd) return { command: "unknown", flags: [] };

  const parts: string[] = [];
  let cur: Command | null = cmd;
  while (cur && cur.parent) {
    parts.unshift(cur.name());
    cur = cur.parent;
  }
  const command = parts.join(" ") || cmd.name() || "unknown";

  const opts = cmd.opts();
  const flags = Object.keys(opts)
    .filter((k) => {
      try {
        return cmd.getOptionValueSource(k) === "cli";
      } catch {
        return false;
      }
    })
    .map(toKebabCase);

  return { command, flags };
}
