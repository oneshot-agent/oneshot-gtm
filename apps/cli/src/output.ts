import kleur from "kleur";

const NO_COLOR = Boolean(process.env["NO_COLOR"]);
if (NO_COLOR) kleur.enabled = false;

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
  process.stdout.write(`\n${c.bold(c.cyan(s))}\n`);
}

export function bullet(s: string): void {
  process.stdout.write(`  ${c.dim("•")} ${s}\n`);
}

export function ok(s: string): void {
  process.stdout.write(`  ${c.green("✓")} ${s}\n`);
}

export function warn(s: string): void {
  process.stdout.write(`  ${c.yellow("!")} ${s}\n`);
}

export function fail(s: string): void {
  process.stdout.write(`  ${c.red("✗")} ${s}\n`);
}

export function note(s: string): void {
  process.stdout.write(`${c.dim(s)}\n`);
}

export function box(title: string, body: string): void {
  const line = c.dim("─".repeat(Math.max(title.length + 2, 40)));
  process.stdout.write(`\n${line}\n${c.bold(title)}\n${line}\n${body}\n${line}\n\n`);
}

export function diag(label: string, value: string): void {
  process.stdout.write(`  ${c.dim(label.padEnd(16))} ${value}\n`);
}
