import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { demoMode } from "./demo.ts";
import { logEvent } from "./events.ts";

/**
 * The one SQLite file shared ACROSS workspaces.
 *
 * A workspace (one ONESHOT_GTM_HOME) owns its founder voice, ICP, ledger and
 * sender identities — two products must never mix those. But some data is
 * rightly global to the operator, not the product:
 *
 * - the paid lookup caches (enrichment, LinkedIn): the same person researched
 *   for product A must not be bought again for product B;
 * - contact touches: which workspace emailed whom, when — so two motions
 *   don't pile into the same founder's inbox in the same week.
 *
 * Lives at `$ONESHOT_GTM_SHARED/shared.sqlite` (default `~/.oneshot-gtm-shared`).
 * Tests and demo mode point the env at a throwaway dir, for the same reason
 * ONESHOT_GTM_HOME exists. Many processes (one server per workspace) open this
 * file concurrently, hence WAL and a generous busy_timeout.
 */

/** How long a touch by another workspace holds a new first-touch for review. */
export const CONTACT_TOUCH_WINDOW_MS = 7 * 24 * 3600 * 1000;

/** The flag a draft carries when the recipient was emailed by another workspace recently. */
export const CONTACTED_ELSEWHERE_FLAG = "contacted-elsewhere";

export function sharedDir(): string {
  return process.env["ONESHOT_GTM_SHARED"]?.trim() || join(homedir(), ".oneshot-gtm-shared");
}

export function sharedDbPath(): string {
  return join(sharedDir(), "shared.sqlite");
}

/** The workspace this process acts as, for touch attribution. Set by the CLI shim; "default" for the legacy home. */
export function currentWorkspaceName(): string {
  return process.env["ONESHOT_GTM_WORKSPACE"]?.trim() || "default";
}

export interface ContactTouch {
  workspace: string;
  play_name: string;
  sent_at: string;
}

export class SharedDb {
  private db: Database;
  private importedFrom = new Set<string>();

  constructor(path: string = sharedDbPath()) {
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    // Longer than the ledger's 5s: every workspace's server and every CLI run
    // share this file, so write contention is the normal case, not the edge.
    this.db.exec("PRAGMA busy_timeout = 10000");
    this.migrate();
  }

  private migrate(): void {
    // Same shapes as the ledger's tables, so importing legacy rows is a copy.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS enrichment_cache (
        email TEXT PRIMARY KEY,
        result_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        status TEXT
      );
      CREATE TABLE IF NOT EXISTS linkedin_lookup_cache (
        query_key  TEXT PRIMARY KEY,
        url        TEXT,
        status     TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS contact_touches (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        email     TEXT NOT NULL,
        workspace TEXT NOT NULL,
        play_name TEXT NOT NULL,
        sent_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_touches_email_sent ON contact_touches(email, sent_at);
      -- Which per-workspace ledgers have had their legacy cache rows copied in.
      CREATE TABLE IF NOT EXISTS legacy_imports (
        ledger_path TEXT PRIMARY KEY,
        imported_at TEXT NOT NULL
      );
    `);
  }

  // ── caches (identical contracts to the former Ledger methods) ──────────────

  getCachedEnrichment(
    email: string,
  ): { result_json: string; fetched_at: string; status: string | null } | null {
    return (
      (this.db
        .query("SELECT result_json, fetched_at, status FROM enrichment_cache WHERE email = ?")
        .get(email) as { result_json: string; fetched_at: string; status: string | null }) ?? null
    );
  }

  setCachedEnrichment(email: string, resultJson: string): void {
    this.db
      .prepare(
        `INSERT INTO enrichment_cache(email, result_json, fetched_at, status)
         VALUES(?, ?, ?, NULL)
         ON CONFLICT(email) DO UPDATE SET
           result_json = excluded.result_json,
           fetched_at = excluded.fetched_at,
           status = NULL`,
      )
      .run(email, resultJson, new Date().toISOString());
  }

  setCachedEnrichmentFailure(email: string, message: string): void {
    this.db
      .prepare(
        `INSERT INTO enrichment_cache(email, result_json, fetched_at, status)
         VALUES(?, ?, ?, 'failed')
         ON CONFLICT(email) DO UPDATE SET
           result_json = excluded.result_json,
           fetched_at = excluded.fetched_at,
           status = 'failed'`,
      )
      .run(
        email,
        JSON.stringify({ failed: true, message: message.slice(0, 300) }),
        new Date().toISOString(),
      );
  }

  getCachedLinkedIn(
    queryKey: string,
  ): { url: string | null; status: string; fetched_at: string } | null {
    return (
      (this.db
        .query("SELECT url, status, fetched_at FROM linkedin_lookup_cache WHERE query_key = ?")
        .get(queryKey) as { url: string | null; status: string; fetched_at: string }) ?? null
    );
  }

  setCachedLinkedIn(queryKey: string, url: string | null): void {
    this.db
      .prepare(
        `INSERT INTO linkedin_lookup_cache(query_key, url, status, fetched_at)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(query_key) DO UPDATE SET
           url = excluded.url,
           status = excluded.status,
           fetched_at = excluded.fetched_at`,
      )
      .run(queryKey, url, url ? "hit" : "miss", new Date().toISOString());
  }

  // ── contact touches ────────────────────────────────────────────────────────

  recordTouch(input: {
    email: string;
    workspace: string;
    playName: string;
    sentAt?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO contact_touches(email, workspace, play_name, sent_at) VALUES(?, ?, ?, ?)`,
      )
      .run(
        input.email.trim().toLowerCase(),
        input.workspace,
        input.playName,
        input.sentAt ?? new Date().toISOString(),
      );
  }

  /** Most recent touch of `email` by a workspace OTHER than `workspace` within the window, or null. */
  recentTouchElsewhere(
    email: string,
    workspace: string,
    windowMs: number = CONTACT_TOUCH_WINDOW_MS,
  ): ContactTouch | null {
    const since = new Date(Date.now() - windowMs).toISOString();
    return (
      (this.db
        .query(
          `SELECT workspace, play_name, sent_at FROM contact_touches
           WHERE email = ? AND workspace != ? AND sent_at >= ?
           ORDER BY sent_at DESC LIMIT 1`,
        )
        .get(email.trim().toLowerCase(), workspace, since) as ContactTouch) ?? null
    );
  }

  /** All touches of an email across workspaces, newest first (doctor / UI detail). */
  touchesFor(email: string, limit = 20): ContactTouch[] {
    return this.db
      .query(
        `SELECT workspace, play_name, sent_at FROM contact_touches
         WHERE email = ? ORDER BY sent_at DESC LIMIT ?`,
      )
      .all(email.trim().toLowerCase(), limit) as ContactTouch[];
  }

  // ── legacy import ──────────────────────────────────────────────────────────

  /**
   * One-time copy of a per-workspace ledger's cache tables into the shared
   * file (INSERT OR IGNORE — shared rows win). Keyed by ledger path so each
   * workspace imports once; cheap no-op afterwards. The ledger's own tables
   * are left in place, unwritten, for rollback.
   */
  ensureImported(ledgerDb: Database, ledgerPath: string): void {
    if (this.importedFrom.has(ledgerPath)) return;
    const done = this.db
      .query("SELECT 1 FROM legacy_imports WHERE ledger_path = ?")
      .get(ledgerPath);
    if (done) {
      this.importedFrom.add(ledgerPath);
      return;
    }
    const enrich = ledgerDb
      .query("SELECT email, result_json, fetched_at, status FROM enrichment_cache")
      .all() as Array<{
      email: string;
      result_json: string;
      fetched_at: string;
      status: string | null;
    }>;
    const linkedin = ledgerDb
      .query("SELECT query_key, url, status, fetched_at FROM linkedin_lookup_cache")
      .all() as Array<{
      query_key: string;
      url: string | null;
      status: string;
      fetched_at: string;
    }>;
    const tx = this.db.transaction(() => {
      const ins1 = this.db.prepare(
        `INSERT OR IGNORE INTO enrichment_cache(email, result_json, fetched_at, status) VALUES(?, ?, ?, ?)`,
      );
      for (const r of enrich) ins1.run(r.email, r.result_json, r.fetched_at, r.status);
      const ins2 = this.db.prepare(
        `INSERT OR IGNORE INTO linkedin_lookup_cache(query_key, url, status, fetched_at) VALUES(?, ?, ?, ?)`,
      );
      for (const r of linkedin) ins2.run(r.query_key, r.url, r.status, r.fetched_at);
      this.db
        .prepare(`INSERT INTO legacy_imports(ledger_path, imported_at) VALUES(?, ?)`)
        .run(ledgerPath, new Date().toISOString());
    });
    tx();
    this.importedFrom.add(ledgerPath);
    if (enrich.length + linkedin.length > 0) {
      logEvent("shared_db.legacy_import", {
        enrichment_rows: enrich.length,
        linkedin_rows: linkedin.length,
      });
    }
  }

  close(): void {
    this.db.close();
  }
}

let singleton: { path: string; db: SharedDb } | null = null;

/** Process-wide handle, re-opened if the env-resolved path changes (tests). */
export function getSharedDb(): SharedDb {
  const path = sharedDbPath();
  if (!singleton || singleton.path !== path) {
    singleton = { path, db: new SharedDb(path) };
  }
  return singleton.db;
}

/**
 * Was this address emailed by ANOTHER workspace inside the hold window? Fail-
 * open: a shared-DB hiccup must not block a send — this is reputation hygiene,
 * not a hard-bounce suppression.
 */
export function recentTouchElsewhere(email: string): ContactTouch | null {
  try {
    return getSharedDb().recentTouchElsewhere(email, currentWorkspaceName());
  } catch (err) {
    logEvent(
      "shared_db.read_failed",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
    return null;
  }
}

/** Record that this workspace just emailed `email`. Best-effort; never in demo mode. */
export function recordContactTouch(email: string, playName: string): void {
  if (demoMode()) return;
  try {
    getSharedDb().recordTouch({ email, workspace: currentWorkspaceName(), playName });
  } catch (err) {
    logEvent(
      "shared_db.write_failed",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
  }
}

/** Human phrasing for a hold note / tooltip: "emailed by workspace 'x' (play) 3d ago". */
export function describeTouch(t: ContactTouch): string {
  const days = Math.max(0, Math.floor((Date.now() - new Date(t.sent_at).getTime()) / 86_400_000));
  return `emailed by workspace '${t.workspace}' (${t.play_name}) ${days}d ago`;
}
