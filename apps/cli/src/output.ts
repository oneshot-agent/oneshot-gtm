import kleur from "kleur";

const NO_COLOR = Boolean(process.env["NO_COLOR"]);
if (NO_COLOR) kleur.enabled = false;

/** kleur's own decision (TTY + env), captured before --json can override it. */
const COLOR_DEFAULT = kleur.enabled;

/**
 * `--json` mode. A scripted caller pipes stdout straight into a parser, so
 * under this flag stdout carries exactly ONE document (written by emitJson)
 * and every human line — headers, ok/warn/fail, notes, progress — is diverted
 * to stderr. Colour is off too, so neither stream carries ANSI escapes.
 *
 * Process-global because the CLI runs one command per process; commands opt in
 * by calling setJsonMode() before their first output line.
 */
let jsonMode = false;

export function setJsonMode(on: boolean): void {
  jsonMode = on;
  kleur.enabled = on ? false : COLOR_DEFAULT;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/** The stream human-readable output belongs on right now. */
function humanStream(): NodeJS.WriteStream {
  return jsonMode ? process.stderr : process.stdout;
}

/** Raw write to the human stream — blank lines, progress, anything unstyled. */
export function human(s: string): void {
  humanStream().write(s);
}

/**
 * Version of the `--json` payload contract. Bump on any breaking change to a
 * payload's shape so a scripted caller can refuse a document it can't read.
 */
export const JSON_SCHEMA_VERSION = 1;

/**
 * Write the one-and-only JSON document to stdout. Always emits `schemaVersion`
 * first; callers pass the rest. Nothing else may reach stdout in this mode.
 */
export function emitJson(payload: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdout = process.stdout;
    const onError = (err: Error): void => {
      stdout.off("error", onError);
      reject(err);
    };

    stdout.once("error", onError);
    stdout.write(
      `${JSON.stringify({ schemaVersion: JSON_SCHEMA_VERSION, ...payload })}\n`,
      (err) => {
        stdout.off("error", onError);
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

export const c = {
  bold: (s: string) => kleur.bold(s),
  dim: (s: string) => kleur.dim(s),
  green: (s: string) => kleur.green(s),
  yellow: (s: string) => kleur.yellow(s),
  red: (s: string) => kleur.red(s),
  cyan: (s: string) => kleur.cyan(s),
  magenta: (s: string) => kleur.magenta(s),
  blue: (s: string) => kleur.blue(s),
};

export function header(s: string): void {
  human(`\n${c.bold(c.cyan(s))}\n`);
}

export function ok(s: string): void {
  human(`  ${c.green("✓")} ${s}\n`);
}

export function warn(s: string): void {
  human(`  ${c.yellow("!")} ${s}\n`);
}

export function fail(s: string): void {
  human(`  ${c.red("✗")} ${s}\n`);
}

/**
 * Sentinel thrown by `bail()`: the command already printed its own message and
 * wants to abort with a non-zero code. The dispatch wrapper (runOrFail)
 * recognizes it, records telemetry, and exits WITHOUT re-printing.
 */
export class CommandExit extends Error {
  public code: number;
  constructor(code = 1) {
    super("command-exit");
    this.name = "CommandExit";
    this.code = code;
  }
}

/**
 * Print a failure message and abort the command. Replaces the
 * `fail(msg); process.exit(1)` pattern so every exit funnels through
 * runOrFail — that's the single place that records telemetry, so a guard
 * clause must not call process.exit() directly (it would skip the event).
 */
export function bail(message: string, code = 1): never {
  fail(message);
  throw new CommandExit(code);
}

/**
 * Exit code for "the run worked, it just produced nothing" under
 * `--fail-on-empty`. Deliberately distinct from bail()'s 1 so a scheduled
 * caller can tell an idle run apart from a broken one.
 */
export const EXIT_EMPTY = 2;

/**
 * Print the empty-run line to stderr and abort with EXIT_EMPTY. stderr (not
 * stdout) because this line is the machine-facing signal a cron wrapper greps
 * — stdout stays the human report — and it carries no colour or glyph.
 */
export function bailEmpty(message: string): never {
  process.stderr.write(`${message}\n`);
  throw new CommandExit(EXIT_EMPTY);
}

export function note(s: string): void {
  human(`${c.dim(s)}\n`);
}

export function box(title: string, body: string): void {
  const line = c.dim("─".repeat(Math.max(title.length + 2, 40)));
  human(`\n${line}\n${c.bold(title)}\n${line}\n${body}\n${line}\n\n`);
}
