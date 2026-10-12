import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { linkedInInviteHistory } from "./ledger-linkedin-guard.ts";
import { openLedgerDatabase } from "./ledger.ts";
import { normalizeLinkedInProfile } from "./linkedin-guard.ts";
import type { SharedDb } from "./shared-db.ts";
import { currentWorkspaceName } from "./shared-db.ts";
import { legacyHome, listWorkspaces, loadRegistry } from "./workspaces.ts";

/**
 * Profiles already contacted on LinkedIn from outside GTM, loaded into the
 * shared `linkedin_touched` suppression table so the invite guard refuses them.
 * The import never sends anything and never touches a cadence.
 */

export interface TouchedRow {
  url: string;
  touchedAt?: string;
}

export interface TouchedImportResult {
  imported: number;
  present: number;
  /** Inputs that are not a personal LinkedIn profile URL. */
  rejected: string[];
}

const URL_COLUMNS = ["profile_url", "linkedin_url", "url"];

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && field.length === 0) quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (quoted) throw new Error("unterminated quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const headerKey = (h: string): string =>
  h
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

/**
 * Rows from a CSV (a `profile_url`, `linkedin_url` or `url` column, plus an
 * optional `touched_at`) or a JSON array of strings or `{ url, touched_at? }`.
 * The format is read off the content, not the file name.
 */
export function parseTouchedFile(text: string): TouchedRow[] {
  const body = text.replace(/^\uFEFF/, "");
  if (/^\s*[[{]/.test(body)) return parseJson(body);
  const rows = csvRows(body);
  if (rows.length === 0) throw new Error("the file is empty");
  const headers = rows[0]!.map(headerKey);
  const urlAt = headers.findIndex((h) => URL_COLUMNS.includes(h));
  if (urlAt < 0) {
    throw new Error(`no URL column: name one of ${URL_COLUMNS.join(", ")}`);
  }
  const atAt = headers.indexOf("touched_at");
  return rows.slice(1).map((r) => {
    const touchedAt = atAt >= 0 ? r[atAt]?.trim() : undefined;
    const row: TouchedRow = { url: (r[urlAt] ?? "").trim() };
    if (touchedAt) row.touchedAt = touchedAt;
    return row;
  });
}

function parseJson(text: string): TouchedRow[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  if (!Array.isArray(data)) throw new Error("JSON must be an array of URLs or { url, touched_at }");
  return data.map((item): TouchedRow => {
    if (typeof item === "string") return { url: item.trim() };
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const url = typeof o["url"] === "string" ? o["url"].trim() : "";
      const at = typeof o["touched_at"] === "string" ? o["touched_at"].trim() : "";
      const row: TouchedRow = { url };
      if (at) row.touchedAt = at;
      return row;
    }
    return { url: "" };
  });
}

/** An ISO time for a file's `touched_at`; `now` when it is missing or not a date. */
function isoOrNow(raw: string | undefined, now: Date): string {
  if (!raw) return now.toISOString();
  const t = new Date(raw);
  return Number.isNaN(t.getTime()) ? now.toISOString() : t.toISOString();
}

/** `import` by default, `import:<label>` when the caller names its source. */
export function touchedImportSource(label?: string): string {
  const l = label?.trim();
  return l ? `import:${l}` : "import";
}

/** Normalise and upsert the rows. Re-running the same rows imports nothing. */
export function importTouchedProfiles(
  shared: SharedDb,
  rows: TouchedRow[],
  opts: { source?: string; dryRun?: boolean; now?: Date } = {},
): TouchedImportResult {
  const now = opts.now ?? new Date();
  const source = touchedImportSource(opts.source);
  const rejected: string[] = [];
  const entries: Array<{ slug: string; source: string; touchedAt: string }> = [];
  for (const row of rows) {
    const profile = normalizeLinkedInProfile(row.url);
    if (!profile) {
      rejected.push(row.url);
      continue;
    }
    entries.push({ slug: profile.key, source, touchedAt: isoOrNow(row.touchedAt, now) });
  }
  const { imported, present } = shared.importLinkedInTouched(entries, { dryRun: opts.dryRun });
  return { imported, present, rejected };
}

export interface LedgerImportResult {
  workspace: string;
  imported: number;
  present: number;
  /** Set when this workspace's ledger could not be read; the others still run. */
  error?: string;
}

/**
 * Copy the LinkedIn invites recorded in every other registered workspace's
 * ledger into `linkedin_touched`, as `invite:<workspace>` with the invite's own
 * time. The current workspace is skipped: the guard backfills its own ledger.
 * Each ledger is opened read-only and closed before the next, whatever
 * happens. Workspaces come from the registry under `ONESHOT_GTM_WORKSPACES`.
 */
export function importLedgerInvites(
  shared: SharedDb,
  opts: {
    dryRun?: boolean;
    /** Test seam: how a ledger file is opened. */
    open?: (path: string) => Database;
  } = {},
): LedgerImportResult[] {
  const open = opts.open ?? ((path: string) => openLedgerDatabase(path, { readonly: true }));
  const current = currentWorkspaceName();
  const results: LedgerImportResult[] = [];
  // The implicit `default` workspace lives at ~/.oneshot-gtm whatever
  // ONESHOT_GTM_WORKSPACES says, so under an isolated registry it is a real install: skip it.
  const isolated = Boolean(process.env["ONESHOT_GTM_WORKSPACES"]?.trim());
  for (const [workspace, entry] of listWorkspaces(loadRegistry())) {
    if (workspace === current) continue;
    if (isolated && entry.home === legacyHome()) continue;
    const path = join(entry.home, "ledger.sqlite");
    if (!existsSync(path)) continue;
    let db: Database | null = null;
    try {
      db = open(path);
      const source = `invite:${workspace}`;
      const entries = linkedInInviteHistory(db).map((h) => ({
        slug: h.slug,
        source,
        touchedAt: h.touchedAt,
      }));
      results.push({ workspace, ...shared.importLinkedInTouched(entries, opts) });
    } catch (err) {
      results.push({
        workspace,
        imported: 0,
        present: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      try {
        db?.close();
      } catch {
        // already closed
      }
    }
  }
  return results;
}
