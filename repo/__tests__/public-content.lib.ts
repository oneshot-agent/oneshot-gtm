// Content guard for the public repository. oneshot-gtm is open source for
// any founder: tracked text must not carry one founder's identity, mailboxes,
// workspaces, ports, pitch or campaign provenance. Identity tokens are
// checked as SHA-256 hashes so this file never publishes what it guards.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Rule =
  | "email-domain"
  | "workspace-name"
  | "port"
  | "oneshot-host"
  | "pitch-phrase"
  | "provenance"
  | "identity"
  | "identity-email";

export interface Finding {
  file: string;
  line: number;
  rule: Rule;
  match: string;
  text: string;
}

export interface AllowEntry {
  /** Exact path, a directory prefix ending in "/", or a glob with "*". */
  file: string;
  /** Rule the exception covers; omitted means every rule. */
  rule?: Rule;
  /** The line must contain this substring for the exception to apply. */
  line?: string;
  reason: string;
}

export interface ScanOptions {
  identityHashes?: ReadonlySet<string>;
  emailLocalHashes?: ReadonlySet<string>;
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Lowercase, split on anything that is not a letter or digit. */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Single tokens plus adjacent two-token phrases, joined by one space. */
export function grams(text: string): string[] {
  const t = tokens(text);
  const out = [...t];
  for (let i = 0; i + 1 < t.length; i++) out.push(`${t[i]} ${t[i + 1]}`);
  return out;
}

// --- file classes -----------------------------------------------------------

const EXCLUDED_DIRS = /^(?:ops|output|launch|\.claude)\//;
const BINARY_OR_LOCK =
  /\.(?:png|jpe?g|gif|webp|ico|icns|svg|woff2?|ttf|otf|eot|pdf|mp3|mp4|mov|wav|zip|tgz|gz|sqlite|db|wasm)$|(?:^|\/)(?:bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

export function isScanned(file: string): boolean {
  return !EXCLUDED_DIRS.test(file) && !BINARY_OR_LOCK.test(file);
}

/** Tests, fixtures, examples and docs: the stricter content class. */
export function isPublicFacing(file: string): boolean {
  return (
    /(?:^|\/)__tests__\//.test(file) ||
    /(?:^|\/)fixtures?\//.test(file) ||
    /\.test\.[cm]?[jt]sx?$/.test(file) ||
    file.startsWith("examples/") ||
    file.startsWith("docs/") ||
    file.endsWith(".md")
  );
}

// --- rules ------------------------------------------------------------------

const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/g;

/** Reserved for documentation by RFC 2606 / RFC 6761. */
export function isReservedDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return (
    /\.(?:example|test|invalid|localhost)$/.test(d) ||
    d === "localhost" ||
    /(?:^|\.)example\.(?:com|org|net)$/.test(d)
  );
}

/**
 * Domains a fixture may use besides the reserved ones: the suite's fictional
 * companies, one- and two-letter placeholders (`a@x.dev`), plain-word
 * placeholders, public mail providers (personal-address detection needs
 * them) and government suffixes (the civic finders key on them).
 */
export const FIXTURE_DOMAINS = [
  /(?:^|\.)(?:tracepoint|acme[a-z0-9-]*|beacon|yourcompany(?:-mail)?)\.[a-z]{2,}(?:\.[a-z]{2})?$/,
  /(?:^|\.)[a-z]{1,2}\.[a-z]{2,5}$/,
  /^(?:[a-z0-9-]+\.)*(?:other|another|elsewhere|team|corp|othercorp|enterprise-corp|startup|personal|old|stealth|evil|bounced|plain|alt|deep|enriched|unknown|prospect|person|be|host|test|foo|bar|baz)\.[a-z]{2,6}$/,
  /^(?:gmail|googlemail|outlook|hotmail|yahoo|icloud|proton)\.(?:com|me)$/,
  /^(?:mail\.gmail|group\.calendar\.google|google)\.com$/,
  /\.gov$/,
];

/** Real infrastructure addresses source code legitimately names. */
export const INFRA_EMAIL_DOMAINS = [
  /(?:^|\.)users\.noreply\.github\.com$/,
  /^(?:noreply\.)?github\.com$/,
];

export const ALLOWED_WORKSPACES = new Set(["default", "acme", "alpha", "beta", "gamma"]);
const WORKSPACE_SITES =
  /(--workspace(?:[ =]|["'`],\s*["'`])|oneshot-gtm-workspaces\/|com\.oneshot-gtm\.workspace\.|ONESHOT_GTM_WORKSPACE=)(["'`]?)([A-Za-z0-9][A-Za-z0-9_-]*)/g;
// Prose about the flag ("--workspace is an error") is not a workspace name.
const FLAG_PROSE = new Set(
  "is in use uses needs selects wins and or the to of with without before after takes sets picks also must can will when if at on for as from still then only so not never always flag flags name names value argument works applies points overrides".split(
    " ",
  ),
);

// 3030 is the base port, and the registry hands named workspaces 3031, 3032,
// … in creation order, so a literal in 3031-3099 pins one install's own
// workspace layout to the docs or a fixture. Fixtures that need a registered
// port use one outside that range (4031 and up) or `BASE_PORT + n`; those are
// deliberately not matched.
const PORT =
  /(?:(?:localhost|127\.0\.0\.1|0\.0\.0\.0)?:|--port[ =]|\bport[ =:]\s*|\bPORT=)(30(?:3[1-9]|[4-9]\d))(?!\d)/gi;

/** The hosts the source talks to. Anything else on these domains is a leak. */
export const ONESHOT_HOSTS = new Set<string>([
  "docs.oneshotagent.com",
  "telemetry.oneshotagent.com",
]);
const ONESHOT_HOST = /(?:[a-z0-9-]+\.)*oneshotagents?\.com/gi;

export const PITCH_PHRASES = [
  /per-call signed receipts/i,
  /signed receipts for every call/i,
  /single SDK/i,
  /unified action API/i,
  /on-chain receipts/i,
  /OneShot credit/i,
];

// A private tracker slug is an identity token, so it lives in the hash list.
export const PROVENANCE = [/verbatim from the live/i, /dogfood/i];

function lineHas(text: string, rx: RegExp): string | null {
  const m = rx.exec(text);
  rx.lastIndex = 0;
  return m ? m[0] : null;
}

export function scanText(file: string, body: string, opts: ScanOptions = {}): Finding[] {
  const out: Finding[] = [];
  const strict = isPublicFacing(file);
  const lines = body.split(/\r?\n/);
  const push = (i: number, rule: Rule, match: string) =>
    out.push({ file, line: i + 1, rule, match, text: (lines[i] ?? "").trim().slice(0, 200) });

  lines.forEach((text, i) => {
    for (const m of text.matchAll(EMAIL)) {
      const domain = (m[1] ?? "").toLowerCase();
      const local = m[0].slice(0, m[0].indexOf("@")).toLowerCase();
      if (opts.emailLocalHashes?.has(sha256(local))) push(i, "identity-email", m[0]);
      const ok =
        isReservedDomain(domain) ||
        FIXTURE_DOMAINS.some((rx) => rx.test(domain)) ||
        INFRA_EMAIL_DOMAINS.some((rx) => rx.test(domain));
      if (!ok) push(i, "email-domain", m[0]);
    }

    for (const m of text.matchAll(WORKSPACE_SITES)) {
      // `<name>`, `${ws}`, `$WS` and an empty value never match the name group.
      const name = (m[3] ?? "").toLowerCase();
      if (m[1] === "--workspace " && !m[2] && FLAG_PROSE.has(name)) continue;
      if (!ALLOWED_WORKSPACES.has(name)) push(i, "workspace-name", m[0]);
    }

    for (const m of text.matchAll(PORT)) push(i, "port", m[0]);

    for (const m of text.matchAll(ONESHOT_HOST)) {
      if (!ONESHOT_HOSTS.has(m[0].toLowerCase())) push(i, "oneshot-host", m[0]);
    }

    if (strict) {
      for (const rx of PITCH_PHRASES) {
        const hit = lineHas(text, rx);
        if (hit) push(i, "pitch-phrase", hit);
      }
    }
    for (const rx of PROVENANCE) {
      const hit = lineHas(text, rx);
      if (hit) push(i, "provenance", hit);
    }

    if (opts.identityHashes?.size) {
      for (const g of grams(text)) {
        if (opts.identityHashes.has(sha256(g)))
          push(i, "identity", `sha256:${sha256(g).slice(0, 12)}`);
      }
    }
  });
  return out;
}

// --- allowlist --------------------------------------------------------------

function fileMatches(pattern: string, file: string): boolean {
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  if (!pattern.includes("*")) return file === pattern;
  const rx = new RegExp(
    `^${pattern
      .split("*")
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*")}$`,
  );
  return rx.test(file);
}

export function isAllowed(f: Finding, allow: readonly AllowEntry[], rawLine: string): boolean {
  return allow.some(
    (a) =>
      fileMatches(a.file, f.file) &&
      (a.rule === undefined || a.rule === f.rule) &&
      (a.line === undefined || rawLine.includes(a.line)),
  );
}

export const ALLOW_FILE = "repo/__tests__/public-content.allow.json";

function quotesAnEntry(raw: string, allow: readonly AllowEntry[]): boolean {
  return allow.some(
    (a) => a.line !== undefined && raw.trim() === `"line": ${JSON.stringify(a.line)},`,
  );
}

export function trackedFiles(root: string): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter(isScanned);
}

export function scanRepo(
  root: string,
  allow: readonly AllowEntry[],
  opts: ScanOptions,
): { findings: Finding[]; usedAllow: Set<number> } {
  const findings: Finding[] = [];
  const usedAllow = new Set<number>();
  for (const file of trackedFiles(root)) {
    let body: string;
    try {
      body = readFileSync(join(root, file), "utf8");
    } catch {
      continue; // deleted in the working tree
    }
    if (body.includes("\0")) continue; // binary without a known extension
    const lines = body.split(/\r?\n/);
    for (const f of scanText(file, body, opts)) {
      const raw = lines[f.line - 1] ?? "";
      // The allowlist quotes the lines it excepts; those quotes are not leaks.
      if (file === ALLOW_FILE && quotesAnEntry(raw, allow)) continue;
      const idx = allow.findIndex((a) => isAllowed(f, [a], raw));
      if (idx >= 0) usedAllow.add(idx);
      else findings.push(f);
    }
  }
  return { findings, usedAllow };
}

export function formatFindings(findings: readonly Finding[]): string {
  return findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.match} -- ${f.text}`).join("\n");
}
