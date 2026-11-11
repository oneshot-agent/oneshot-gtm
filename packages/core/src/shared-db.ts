import { Database } from "bun:sqlite";

import { homedir } from "node:os";
import { join } from "node:path";
import { demoMode } from "./demo.ts";
import { openStateDatabase } from "./sqlite-open.ts";
import { personAliases, SharedPeople } from "./shared-people.ts";
import { logEvent } from "./events.ts";

/**
 * The one SQLite file shared ACROSS workspaces: person identity (shared-people.ts),
 * paid lookup caches (never
 * re-buy a person researched for another product) and contact touches (two
 * motions must not pile into one founder's inbox the same week). Everything
 * else stays per-workspace. Lives at `$ONESHOT_GTM_SHARED/shared.sqlite`
 * (default `~/.oneshot-gtm-shared`). Opened concurrently by every workspace's
 * server + CLI, hence WAL and a generous busy_timeout.
 */

/** How long a touch by another workspace holds a new first-touch for review. */
export const CONTACT_TOUCH_WINDOW_MS = 7 * 24 * 3600 * 1000;
/**
 * An orphaned pre-send reservation (process died mid-send) stops counting as
 * a touch after this long: covers a slow SDK send without holding a real
 * first touch hostage to a crash.
 */
export const RESERVATION_TTL_MS = 10 * 60 * 1000;

/** A LinkedIn profile already invited by a workspace, or touched by another tool. */
export interface LinkedInTouch {
  slug: string;
  /** `invite:<workspace>` for a GTM invite, `connected:<workspace>` for a known connection messaged without one, `import:<label>` for a suppression import. */
  source: string;
  touched_at: string;
  /**
   * `reserved`: claimed, nothing sent yet (expires). `dispatched`: the invite
   * call is about to be made or its outcome is unknown (never expires; only an
   * explicit release frees it). `confirmed`: sent, or imported.
   */
  status: "reserved" | "dispatched" | "confirmed";
}

/** The flag a draft carries when the recipient was emailed by another workspace recently. */
export const CONTACTED_ELSEWHERE_FLAG = "contacted-elsewhere";

// The flag a first touch carries while another workspace's sequence with the person is live.
export { LIVE_ELSEWHERE_FLAG } from "@oneshot-gtm/shared-types";

/** Cadence statuses that count as a live sequence: another workspace's first touch waits while one lasts. */
export const LIVE_CADENCE_STATUSES: readonly string[] = ["active", "paused"];

/** One cadence of one workspace, as `cadence_presence` mirrors it from that workspace's ledger. */
export interface CadencePresence {
  workspace: string;
  play_name: string;
  /** The prospect's id in that workspace's ledger. */
  prospect_id: number;
  email: string | null;
  /** The LinkedIn profile slug, decoded and lowercased like a person alias. */
  linkedin_slug: string | null;
  status: string;
  updated_at: string;
}

/** A cadence row as a ledger hands it over (`readCadencePresence`). */
export interface CadencePresenceInput {
  prospectId: number;
  playName: string;
  email: string | null;
  linkedinUrl: string | null;
  status: string;
}

/** A person with a live sequence in this workspace and in another one. */
export interface CadenceOverlap {
  here: CadencePresence;
  elsewhere: CadencePresence;
}

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
  /** 'sent' once dispatch succeeded; 'reserved' between the pre-send claim and confirm/release. */
  status: "sent" | "reserved";
}

/** One stored paid lookup (paid-cache.ts). */
export interface PaidCacheRow {
  key: string;
  call_type: string;
  status: "ok" | "failed";
  result_json: string;
  fetched_at: string;
  cost_usd: number | null;
  hits: number;
  saved_usd: number;
}

/** Outcome of an atomic claim: either someone else holds this address, or we now do. */
export type TouchClaim = { held: ContactTouch } | { reservationId: number };

export interface PaymentHold {
  key: string;
  wallet: string;
  method: string;
  claim_token: string;
  settlement_id: string | null;
  created_at: string;
}

export class SharedDb {
  private db: Database;
  private importedFrom = new Set<string>();

  constructor(path: string = sharedDbPath()) {
    // Longer busy timeout than the ledger's 5s: every workspace's server and
    // every CLI run share this file, so write contention is the normal case.
    this.db = openStateDatabase(path, { busyTimeoutMs: 10000 });
    this.migrate();
    // Establish the schema once instead of probing sqlite_master on every touch.
    // An empty registry still resolves to the supplied email, and identities
    // added by another connection become visible without reopening SharedDb.
    SharedPeople.ensureSchema(this.db);
  }

  claimPayment(key: string, wallet: string, method: string, claimToken: string): boolean {
    return (
      this.db.run(
        "INSERT OR IGNORE INTO payment_holds(key,wallet,method,claim_token) VALUES(?,?,?,?)",
        [key, wallet, method, claimToken],
      ).changes === 1
    );
  }

  holdPayment(key: string, claimToken: string, settlementId?: string): void {
    this.db.run("UPDATE payment_holds SET settlement_id=? WHERE key=? AND claim_token=?", [
      settlementId ?? null,
      key,
      claimToken,
    ]);
  }

  paymentHolds(): PaymentHold[] {
    return this.db.query<PaymentHold, []>("SELECT * FROM payment_holds ORDER BY created_at").all();
  }

  releasePayment(key: string, claimToken: string): boolean {
    return (
      this.db.run("DELETE FROM payment_holds WHERE key=? AND claim_token=?", [key, claimToken])
        .changes === 1
    );
  }

  private migrate(): void {
    // Same shapes as the ledger's tables, so importing legacy rows is a copy.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS payment_holds (
        key TEXT PRIMARY KEY, wallet TEXT NOT NULL, method TEXT NOT NULL,
        settlement_id TEXT, claim_token TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
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
        sent_at   TEXT NOT NULL,
        status    TEXT NOT NULL DEFAULT 'sent'
      );
      CREATE INDEX IF NOT EXISTS idx_touches_email_sent ON contact_touches(email, sent_at);
      -- LinkedIn invite slots per account + workspace + UTC day (workspace share of the account cap).
      CREATE TABLE IF NOT EXISTS linkedin_invite_slots (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id  TEXT NOT NULL,
        workspace   TEXT NOT NULL,
        day         TEXT NOT NULL,
        status      TEXT NOT NULL,
        reserved_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_invite_slots_key ON linkedin_invite_slots(account_id, workspace, day);
      -- LinkedIn profiles already invited (by any workspace) or touched by another tool.
      -- status 'reserved' is the reserve-before-await claim; it expires like a touch reservation.
      -- 'dispatched' is written just before the invite call and never expires: a crash or an
      -- unknown outcome after that point must keep the profile suppressed.
      CREATE TABLE IF NOT EXISTS linkedin_touched (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        slug       TEXT NOT NULL UNIQUE,
        source     TEXT NOT NULL,
        touched_at TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'confirmed'
      );
      -- Which per-workspace ledgers have had their legacy cache rows copied in.
      CREATE TABLE IF NOT EXISTS legacy_imports (
        ledger_path TEXT PRIMARY KEY,
        imported_at TEXT NOT NULL
      );
      -- Every paid lookup's result, keyed by call type + normalised input
      -- (paid-cache.ts). status 'failed' is a negative entry: a genuine
      -- failure, kept so the same input is not bought again straight away.
      CREATE TABLE IF NOT EXISTS paid_call_cache (
        key         TEXT PRIMARY KEY,
        call_type   TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'ok',
        result_json TEXT NOT NULL,
        fetched_at  TEXT NOT NULL,
        cost_usd    REAL,
        hits        INTEGER NOT NULL DEFAULT 0,
        saved_usd   REAL NOT NULL DEFAULT 0,
        last_hit_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_paid_call_cache_type ON paid_call_cache(call_type, fetched_at);
      -- Every workspace's cadences, mirrored from its ledger (status included,
      -- live or not), so a first touch can see the person is in another
      -- workspace's live sequence. Keyed like the ledger's cadence_state.
      CREATE TABLE IF NOT EXISTS cadence_presence (
        workspace     TEXT NOT NULL,
        play_name     TEXT NOT NULL,
        prospect_id   INTEGER NOT NULL,
        email         TEXT,
        linkedin_slug TEXT,
        status        TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (workspace, play_name, prospect_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cadence_presence_email ON cadence_presence(email);
      CREATE INDEX IF NOT EXISTS idx_cadence_presence_slug ON cadence_presence(linkedin_slug);
      -- Per UTC day and call type: answers from the cache vs purchases, for doctor.
      CREATE TABLE IF NOT EXISTS paid_cache_daily (
        day        TEXT NOT NULL,
        call_type  TEXT NOT NULL,
        hits       INTEGER NOT NULL DEFAULT 0,
        saved_usd  REAL NOT NULL DEFAULT 0,
        purchases  INTEGER NOT NULL DEFAULT 0,
        spent_usd  REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (day, call_type)
      );
    `);
    // Shared files created before reservations existed. Every workspace's
    // server runs this on boot, possibly at the same instant: take the write
    // lock so the second process re-checks AFTER the first's ALTER lands, and
    // still tolerate the duplicate-column error if two connections slip past
    // (SQLite's ALTER is not itself idempotent).
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const paymentCols = this.db
        .query<{ name: string }, []>("PRAGMA table_info(payment_holds)")
        .all();
      if (!paymentCols.some((c) => c.name === "claim_token")) {
        this.db.exec("ALTER TABLE payment_holds ADD COLUMN claim_token TEXT NOT NULL DEFAULT ''");
      }
      const cols = this.db.query("PRAGMA table_info(contact_touches)").all() as Array<{
        name: string;
      }>;
      if (!cols.some((c) => c.name === "status")) {
        try {
          this.db.exec(
            "ALTER TABLE contact_touches ADD COLUMN status TEXT NOT NULL DEFAULT 'sent'",
          );
        } catch (err) {
          if (!/duplicate column/i.test((err as Error).message ?? "")) throw err;
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
  }

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

  /** Write the row only when no row has the key: true for the one caller that wrote it. */
  claimCachedEnrichment(email: string, resultJson: string): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO enrichment_cache(email, result_json, fetched_at, status)
         VALUES(?, ?, ?, NULL)`,
      )
      .run(email, resultJson, new Date().toISOString());
    return res.changes > 0;
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

  /** How many cache rows under a key prefix were written since `sinceIso`. The daily counter for throttled paid reads. */
  countCachedEnrichmentSince(prefix: string, sinceIso: string): number {
    const row = this.db
      .query(
        "SELECT COUNT(*) AS n FROM enrichment_cache WHERE email LIKE ? ESCAPE '\\' AND fetched_at >= ? AND status IS NULL",
      )
      .get(`${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, sinceIso) as { n: number };
    return Number(row?.n ?? 0);
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

  getPaidCache(key: string): PaidCacheRow | null {
    return (
      (this.db
        .query(
          "SELECT key, call_type, status, result_json, fetched_at, cost_usd, hits, saved_usd FROM paid_call_cache WHERE key = ?",
        )
        .get(key) as PaidCacheRow) ?? null
    );
  }

  /** Write a purchase or a negative entry. `keepExisting` never overwrites a row (the legacy import). */
  setPaidCache(
    row: {
      key: string;
      callType: string;
      status: "ok" | "failed";
      resultJson: string;
      costUsd: number | null;
      fetchedAt?: string;
    },
    opts: { keepExisting?: boolean } = {},
  ): boolean {
    const res = this.db
      .prepare(
        opts.keepExisting
          ? `INSERT OR IGNORE INTO paid_call_cache(key, call_type, status, result_json, fetched_at, cost_usd)
             VALUES(?, ?, ?, ?, ?, ?)`
          : `INSERT INTO paid_call_cache(key, call_type, status, result_json, fetched_at, cost_usd)
             VALUES(?, ?, ?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET
               call_type = excluded.call_type,
               status = excluded.status,
               result_json = excluded.result_json,
               fetched_at = excluded.fetched_at,
               cost_usd = excluded.cost_usd`,
      )
      .run(
        row.key,
        row.callType,
        row.status,
        row.resultJson,
        row.fetchedAt ?? new Date().toISOString(),
        row.costUsd,
      );
    return res.changes > 0;
  }

  /** A lookup answered from the cache: the row's counters and the day's tally. */
  recordPaidCacheHit(key: string, callType: string, savedUsd: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE paid_call_cache SET hits = hits + 1, saved_usd = saved_usd + ?, last_hit_at = ? WHERE key = ?",
      )
      .run(savedUsd, now, key);
    this.bumpPaidCacheDaily(now.slice(0, 10), callType, { hits: 1, savedUsd });
  }

  /** A lookup bought because the cache could not answer it. */
  recordPaidCachePurchase(callType: string, spentUsd: number): void {
    this.bumpPaidCacheDaily(new Date().toISOString().slice(0, 10), callType, {
      purchases: 1,
      spentUsd,
    });
  }

  private bumpPaidCacheDaily(
    day: string,
    callType: string,
    d: { hits?: number; savedUsd?: number; purchases?: number; spentUsd?: number },
  ): void {
    this.db
      .prepare(
        `INSERT INTO paid_cache_daily(day, call_type, hits, saved_usd, purchases, spent_usd)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, call_type) DO UPDATE SET
           hits = hits + excluded.hits,
           saved_usd = saved_usd + excluded.saved_usd,
           purchases = purchases + excluded.purchases,
           spent_usd = spent_usd + excluded.spent_usd`,
      )
      .run(day, callType, d.hits ?? 0, d.savedUsd ?? 0, d.purchases ?? 0, d.spentUsd ?? 0);
  }

  /** Successful results of one call type written since `sinceIso`: the daily counter for capped paid reads. */
  countPaidCacheSince(callType: string, sinceIso: string): number {
    const row = this.db
      .query(
        "SELECT COUNT(*) AS n FROM paid_call_cache WHERE call_type = ? AND status = 'ok' AND fetched_at >= ?",
      )
      .get(callType, sinceIso) as { n: number };
    return Number(row?.n ?? 0);
  }

  /** Hits, savings and purchases per call type since `sinceDay` (YYYY-MM-DD, UTC). */
  paidCacheDaily(sinceDay: string): Array<{
    call_type: string;
    hits: number;
    saved_usd: number;
    purchases: number;
    spent_usd: number;
  }> {
    return this.db
      .query(
        `SELECT call_type, SUM(hits) AS hits, SUM(saved_usd) AS saved_usd,
                SUM(purchases) AS purchases, SUM(spent_usd) AS spent_usd
         FROM paid_cache_daily WHERE day >= ? GROUP BY call_type ORDER BY call_type`,
      )
      .all(sinceDay) as Array<{
      call_type: string;
      hits: number;
      saved_usd: number;
      purchases: number;
      spent_usd: number;
    }>;
  }

  /** Delete up to `limit` rows of one call type and status fetched before `beforeIso`. */
  prunePaidCache(
    callType: string,
    status: "ok" | "failed",
    beforeIso: string,
    limit: number,
  ): number {
    const res = this.db
      .prepare(
        `DELETE FROM paid_call_cache WHERE key IN (
           SELECT key FROM paid_call_cache
           WHERE call_type = ? AND status = ? AND fetched_at < ? LIMIT ?
         )`,
      )
      .run(callType, status, beforeIso, limit);
    return res.changes;
  }

  /** Test hook (`_resetPaidCache`): drop every stored paid result and tally. */
  clearPaidCache(): void {
    this.db.exec("DELETE FROM paid_call_cache; DELETE FROM paid_cache_daily;");
  }

  /** Every enrichment_cache row, for the one-time copy into paid_call_cache. */
  allCachedEnrichment(): Array<{
    email: string;
    result_json: string;
    fetched_at: string;
    status: string | null;
  }> {
    return this.db
      .query("SELECT email, result_json, fetched_at, status FROM enrichment_cache")
      .all() as Array<{
      email: string;
      result_json: string;
      fetched_at: string;
      status: string | null;
    }>;
  }

  /**
   * Run `fn` once per shared file, under one write lock, recorded in
   * legacy_imports under `name`. A failure rolls back and leaves it to run again.
   */
  runOnce(name: string, fn: () => void): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.query("SELECT 1 FROM legacy_imports WHERE ledger_path = ?").get(name)) {
        this.db.exec("COMMIT");
        return false;
      }
      fn();
      this.db
        .prepare(`INSERT INTO legacy_imports(ledger_path, imported_at) VALUES(?, ?)`)
        .run(name, new Date().toISOString());
      this.db.exec("COMMIT");
      return true;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
  }

  /** Rows that count as "this address was touched": confirmed sends, plus unexpired reservations. */
  private static readonly LIVE_TOUCH_SQL = `(status = 'sent' OR (status = 'reserved' AND sent_at >= ?))`;

  private liveTouchArgs(): [string] {
    return [new Date(Date.now() - RESERVATION_TTL_MS).toISOString()];
  }

  /** Record a completed touch directly (no reservation step: used by replies, which aren't held). */
  recordTouch(input: {
    email: string;
    workspace: string;
    playName: string;
    sentAt?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO contact_touches(email, workspace, play_name, sent_at, status) VALUES(?, ?, ?, ?, 'sent')`,
      )
      .run(
        input.email.trim().toLowerCase(),
        input.workspace,
        input.playName,
        input.sentAt ?? new Date().toISOString(),
      );
  }

  /** Include every verified email alias of the shared person in contact protection. */
  private contactEmails(email: string): string[] {
    const normalized = email.trim().toLowerCase();
    const aliases = this.db
      .query(`SELECT substr(alias,7) email FROM person_aliases
      WHERE alias LIKE 'email:%' AND person_id=(SELECT person_id FROM person_aliases WHERE alias=?)`)
      .all(`email:${normalized}`) as { email: string }[];
    return [...new Set([normalized, ...aliases.map((row) => row.email)])];
  }

  /** Most recent live touch of `email` by a workspace OTHER than `workspace` within the window, or null. */
  recentTouchElsewhere(
    email: string,
    workspace: string,
    windowMs: number = CONTACT_TOUCH_WINDOW_MS,
  ): ContactTouch | null {
    const since = new Date(Date.now() - windowMs).toISOString();
    const emails = this.contactEmails(email);
    return (
      (this.db
        .query(
          `SELECT workspace, play_name, sent_at, status FROM contact_touches
           WHERE email IN (${emails.map(() => "?").join(",")}) AND workspace != ? AND sent_at >= ? AND ${SharedDb.LIVE_TOUCH_SQL}
           ORDER BY sent_at DESC LIMIT 1`,
        )
        .get(...emails, workspace, since, ...this.liveTouchArgs()) as ContactTouch) ?? null
    );
  }

  /**
   * Atomic check-and-reserve (closes the check→dispatch→record race): under
   * BEGIN IMMEDIATE either another workspace holds this address. Return it:
   * or a 'reserved' row lands BEFORE any network call. Confirm on success,
   * release on failure; orphans expire after RESERVATION_TTL_MS.
   */
  claimTouch(input: {
    email: string;
    workspace: string;
    playName: string;
    windowMs?: number;
  }): TouchClaim {
    const email = input.email.trim().toLowerCase();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const held = this.recentTouchElsewhere(email, input.workspace, input.windowMs);
      if (held) {
        this.db.exec("ROLLBACK");
        return { held };
      }
      const id = this.reserveTouchUnlocked(email, input.workspace, input.playName);
      this.db.exec("COMMIT");
      return { reservationId: id };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
  }

  /** Reserve without checking. The manual override still has to be visible to other workspaces. */
  reserveTouch(input: { email: string; workspace: string; playName: string }): number {
    return this.reserveTouchUnlocked(
      input.email.trim().toLowerCase(),
      input.workspace,
      input.playName,
    );
  }

  private reserveTouchUnlocked(email: string, workspace: string, playName: string): number {
    const res = this.db
      .prepare(
        `INSERT INTO contact_touches(email, workspace, play_name, sent_at, status) VALUES(?, ?, ?, ?, 'reserved')`,
      )
      .run(email, workspace, playName, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  /** Dispatch succeeded: the reservation becomes a real touch, stamped at send time. */
  confirmTouch(id: number): void {
    this.db
      .prepare(`UPDATE contact_touches SET status = 'sent', sent_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  /** Dispatch failed before the provider accepted anything: nobody was touched. */
  releaseTouch(id: number): void {
    this.db.prepare(`DELETE FROM contact_touches WHERE id = ? AND status = 'reserved'`).run(id);
  }

  private static readonly LIVE_SLOT_SQL = `(status = 'confirmed' OR (status = 'reserved' AND reserved_at >= ?))`;

  /** Invite slots this workspace holds on the account for the UTC day: confirmed, plus unexpired reservations. */
  inviteSlotsUsed(
    accountId: string,
    workspace: string,
    day: string,
    now: Date = new Date(),
  ): number {
    const cutoff = new Date(now.getTime() - RESERVATION_TTL_MS).toISOString();
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n FROM linkedin_invite_slots
         WHERE account_id = ? AND workspace = ? AND day = ? AND ${SharedDb.LIVE_SLOT_SQL}`,
      )
      .get(accountId, workspace, day, cutoff) as { n: number };
    return Number(row?.n ?? 0);
  }

  /**
   * Atomic check-and-reserve of one invite slot. Under BEGIN IMMEDIATE the
   * count and the insert happen together, so concurrent senders (any process
   * on this machine) cannot both take the last slot. `limit` null = count
   * only. A reservation never confirmed (crash) stops counting after
   * RESERVATION_TTL_MS; a new UTC day starts from zero.
   */
  reserveInviteSlot(input: {
    accountId: string;
    workspace: string;
    limit: number | null;
    now?: Date;
  }): { id: number; used: number } | { full: true; used: number } {
    const now = input.now ?? new Date();
    const day = now.toISOString().slice(0, 10);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const used = this.inviteSlotsUsed(input.accountId, input.workspace, day, now);
      if (input.limit !== null && used >= input.limit) {
        this.db.exec("ROLLBACK");
        return { full: true, used };
      }
      // Past days are never read again.
      this.db.prepare(`DELETE FROM linkedin_invite_slots WHERE day < ?`).run(day);
      const res = this.db
        .prepare(
          `INSERT INTO linkedin_invite_slots(account_id, workspace, day, status, reserved_at) VALUES(?, ?, ?, 'reserved', ?)`,
        )
        .run(input.accountId, input.workspace, day, now.toISOString());
      this.db.exec("COMMIT");
      return { id: Number(res.lastInsertRowid), used: used + 1 };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
  }

  /** The invite was accepted by the API: the slot is spent for the day. */
  confirmInviteSlot(id: number): void {
    this.db.prepare(`UPDATE linkedin_invite_slots SET status = 'confirmed' WHERE id = ?`).run(id);
  }

  /** The invite did not go out: give the slot back. */
  releaseInviteSlot(id: number): void {
    this.db
      .prepare(`DELETE FROM linkedin_invite_slots WHERE id = ? AND status = 'reserved'`)
      .run(id);
  }

  /**
   * A slot kept for an invite whose outcome was unknown (a pending job, a
   * 429), which later proved not sent: give it back, whatever its status.
   * Ids are never reused, and only today's slots count, so freeing one from
   * an earlier day (or one already gone) changes nothing.
   */
  freeInviteSlot(id: number): void {
    this.db.prepare(`DELETE FROM linkedin_invite_slots WHERE id = ?`).run(id);
  }

  /** The live record for a LinkedIn profile slug (confirmed, or an unexpired reservation), if any. */
  linkedInTouch(slug: string, now: Date = new Date()): LinkedInTouch | null {
    const cutoff = new Date(now.getTime() - RESERVATION_TTL_MS).toISOString();
    return (
      (this.db
        .query(
          `SELECT slug, source, touched_at, status FROM linkedin_touched
           WHERE slug = ? AND (status IN ('confirmed', 'dispatched') OR (status = 'reserved' AND touched_at >= ?))`,
        )
        .get(slug, cutoff) as LinkedInTouch | null) ?? null
    );
  }

  /**
   * Atomic check-and-reserve of one LinkedIn profile. Under BEGIN IMMEDIATE the
   * read and the insert happen together, so two workspaces sharing an account
   * cannot both invite the same profile. An unconfirmed reservation (crash)
   * stops holding after RESERVATION_TTL_MS.
   */
  claimLinkedInProfile(input: {
    slug: string;
    source: string;
    now?: Date;
  }): { id: number } | { held: LinkedInTouch } {
    const now = input.now ?? new Date();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const held = this.linkedInTouch(input.slug, now);
      if (held) {
        this.db.exec("ROLLBACK");
        return { held };
      }
      this.db.prepare(`DELETE FROM linkedin_touched WHERE slug = ?`).run(input.slug);
      const res = this.db
        .prepare(
          `INSERT INTO linkedin_touched(slug, source, touched_at, status) VALUES(?, ?, ?, 'reserved')`,
        )
        .run(input.slug, input.source, now.toISOString());
      this.db.exec("COMMIT");
      return { id: Number(res.lastInsertRowid) };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
  }

  /**
   * The invite call is about to be made: the claim stops expiring. From here a
   * crash, a timeout or a failed confirmation keeps the profile suppressed;
   * only `releaseLinkedInProfile` (a provider-reported non-delivery) frees it.
   * Throws when the reservation is gone, so the caller does not send.
   */
  dispatchLinkedInProfile(id: number): void {
    const res = this.db
      .prepare(
        `UPDATE linkedin_touched SET status = 'dispatched', touched_at = ? WHERE id = ? AND status = 'reserved'`,
      )
      .run(new Date().toISOString(), id);
    if (Number(res.changes) !== 1) throw new Error("the LinkedIn profile reservation was lost");
  }

  /** The invite was accepted by the API: the profile stays touched for good. */
  confirmLinkedInProfile(id: number): void {
    this.db
      .prepare(
        `UPDATE linkedin_touched SET status = 'confirmed', touched_at = ? WHERE id = ? AND status IN ('reserved', 'dispatched')`,
      )
      .run(new Date().toISOString(), id);
  }

  /** The invite did not go out (the provider said so): free the profile. */
  releaseLinkedInProfile(id: number): void {
    this.db
      .prepare(`DELETE FROM linkedin_touched WHERE id = ? AND status IN ('reserved', 'dispatched')`)
      .run(id);
  }

  /**
   * Settle an invite claim still unsettled (`reserved` or `dispatched`) under
   * exactly this source: `confirm` keeps it for good, `release` frees the
   * profile. A confirmed record, or another source's, is left alone.
   */
  settleLinkedInTouch(slug: string, source: string, outcome: "confirm" | "release"): void {
    if (outcome === "confirm") {
      this.db
        .prepare(
          `UPDATE linkedin_touched SET status = 'confirmed', touched_at = ?
           WHERE slug = ? AND source = ? AND status IN ('reserved', 'dispatched')`,
        )
        .run(new Date().toISOString(), slug, source);
      return;
    }
    this.db
      .prepare(
        `DELETE FROM linkedin_touched
         WHERE slug = ? AND source = ? AND status IN ('reserved', 'dispatched')`,
      )
      .run(slug, source);
  }

  /** Invite claims under this source that never settled: what the reconcile command checks. */
  listUnsettledLinkedInTouches(source: string): LinkedInTouch[] {
    return this.db
      .query(
        `SELECT slug, source, touched_at, status FROM linkedin_touched
         WHERE source = ? AND status IN ('reserved', 'dispatched') ORDER BY touched_at`,
      )
      .all(source) as LinkedInTouch[];
  }

  /** Free a profile held under exactly this source, whatever its status. */
  releaseLinkedInTouch(slug: string, source: string): void {
    this.db.prepare(`DELETE FROM linkedin_touched WHERE slug = ? AND source = ?`).run(slug, source);
  }

  /**
   * One-time copy of a ledger's recorded invites into `linkedin_touched`
   * (INSERT OR IGNORE: an existing record wins), so profiles invited before the
   * guard existed keep excluding other plays and workspaces. The marker and the
   * rows commit together; keyed in `legacy_imports` by `key`.
   */
  importLinkedInInvites(
    key: string,
    read: () => Array<{ slug: string; source: string; touchedAt: string }>,
  ): number {
    const imported = (): boolean =>
      this.db.query(`SELECT 1 FROM legacy_imports WHERE ledger_path = ?`).get(key) != null;
    // The guard calls this on every check: once imported, answer from a plain
    // read instead of taking the shared file's write lock each time.
    if (imported()) return 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Checked again under the lock: another process may have just imported it.
      if (imported()) {
        this.db.exec("ROLLBACK");
        return 0;
      }
      const entries = read();
      const ins = this.db.prepare(
        `INSERT OR IGNORE INTO linkedin_touched(slug, source, touched_at, status) VALUES(?, ?, ?, 'confirmed')`,
      );
      for (const e of entries) ins.run(e.slug, e.source, e.touchedAt);
      this.db
        .prepare(`INSERT OR IGNORE INTO legacy_imports(ledger_path, imported_at) VALUES(?, ?)`)
        .run(key, new Date().toISOString());
      this.db.exec("COMMIT");
      return entries.length;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
  }

  /** Suppress a profile touched outside GTM (an import). An existing row wins. */
  markLinkedInTouched(input: { slug: string; source: string; touchedAt?: string }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO linkedin_touched(slug, source, touched_at, status) VALUES(?, ?, ?, 'confirmed')`,
      )
      .run(input.slug, input.source, input.touchedAt ?? new Date().toISOString());
  }

  /**
   * Suppress many profiles at once, in one transaction. A slug already in the
   * table (any status) is left as it is and counted as present. With `dryRun`
   * nothing is written; the counts are what a real run would give.
   */
  importLinkedInTouched(
    entries: Array<{ slug: string; source: string; touchedAt: string }>,
    opts: { dryRun?: boolean } = {},
  ): { imported: number; present: number } {
    let imported = 0;
    let present = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // An expired reservation holds nothing: it is replaced, not counted.
      const cutoff = new Date(Date.now() - RESERVATION_TTL_MS).toISOString();
      const has = this.db.prepare(
        `SELECT 1 FROM linkedin_touched
         WHERE slug = ? AND (status IN ('confirmed', 'dispatched') OR touched_at >= ?)`,
      );
      const clear = this.db.prepare(`DELETE FROM linkedin_touched WHERE slug = ?`);
      const ins = this.db.prepare(
        `INSERT INTO linkedin_touched(slug, source, touched_at, status) VALUES(?, ?, ?, 'confirmed')`,
      );
      const seen = new Set<string>();
      for (const e of entries) {
        if (seen.has(e.slug) || has.get(e.slug, cutoff) != null) {
          present++;
          continue;
        }
        seen.add(e.slug);
        imported++;
        if (!opts.dryRun) {
          clear.run(e.slug);
          ins.run(e.slug, e.source, e.touchedAt);
        }
      }
      this.db.exec("COMMIT");
      return { imported, present };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
  }

  /** How many profiles the suppression list holds (live reservations and confirmed rows). */
  countLinkedInTouched(now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - RESERVATION_TTL_MS).toISOString();
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n FROM linkedin_touched
         WHERE status IN ('confirmed', 'dispatched') OR (status = 'reserved' AND touched_at >= ?)`,
      )
      .get(cutoff) as { n: number };
    return row.n;
  }

  private static readonly LIVE_CADENCE_SQL = `status IN (${LIVE_CADENCE_STATUSES.map((st) => `'${st}'`).join(",")})`;

  /**
   * Make this workspace's presence rows match `rows`, under one write lock:
   * upsert each (a row that has not changed keeps its `updated_at`), then
   * delete the workspace's rows `rows` no longer has, for the prospects in
   * `scope` or, with `all`, every one of them.
   */
  syncCadencePresence(
    workspace: string,
    rows: CadencePresenceInput[],
    scope: { prospectIds: number[] } | "all",
  ): { changed: number; removed: number } {
    const now = new Date().toISOString();
    let changed = 0;
    let removed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const upsert = this.db.prepare(
        `INSERT INTO cadence_presence(workspace, play_name, prospect_id, email, linkedin_slug, status, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace, play_name, prospect_id) DO UPDATE SET
           email = excluded.email,
           linkedin_slug = excluded.linkedin_slug,
           status = excluded.status,
           updated_at = excluded.updated_at
         WHERE cadence_presence.email IS NOT excluded.email
            OR cadence_presence.linkedin_slug IS NOT excluded.linkedin_slug
            OR cadence_presence.status IS NOT excluded.status`,
      );
      const keep = new Set<string>();
      for (const r of rows) {
        keep.add(`${r.prospectId}\u0000${r.playName}`);
        const res = upsert.run(
          workspace,
          r.playName,
          r.prospectId,
          r.email?.trim().toLowerCase() || null,
          linkedInAliasSlug(r.linkedinUrl),
          r.status,
          now,
        );
        changed += Number(res.changes);
      }
      const existing = (
        scope === "all"
          ? this.db
              .query(`SELECT prospect_id, play_name FROM cadence_presence WHERE workspace = ?`)
              .all(workspace)
          : scope.prospectIds.flatMap((id) =>
              this.db
                .query(
                  `SELECT prospect_id, play_name FROM cadence_presence WHERE workspace = ? AND prospect_id = ?`,
                )
                .all(workspace, id),
            )
      ) as Array<{ prospect_id: number; play_name: string }>;
      const del = this.db.prepare(
        `DELETE FROM cadence_presence WHERE workspace = ? AND prospect_id = ? AND play_name = ?`,
      );
      for (const e of existing) {
        if (keep.has(`${e.prospect_id}\u0000${e.play_name}`)) continue;
        removed += Number(del.run(workspace, e.prospect_id, e.play_name).changes);
      }
      this.db.exec("COMMIT");
      return { changed, removed };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
  }

  /**
   * Every email and LinkedIn slug the shared registry knows for the person
   * behind these identities (its aliases included), for matching presence rows.
   */
  private presenceIdentity(
    email: string | null,
    slug: string | null,
  ): { emails: string[]; slugs: string[] } {
    const own = [...(email ? [`email:${email}`] : []), ...(slug ? [`linkedin:${slug}`] : [])];
    if (own.length === 0) return { emails: [], slugs: [] };
    const rows = this.db
      .query(
        `SELECT alias FROM person_aliases WHERE person_id IN (
           SELECT person_id FROM person_aliases WHERE alias IN (${own.map(() => "?").join(",")}))`,
      )
      .all(...own) as Array<{ alias: string }>;
    const all = new Set([...own, ...rows.map((r) => r.alias)]);
    const pick = (prefix: string): string[] =>
      [...all].filter((a) => a.startsWith(prefix)).map((a) => a.slice(prefix.length));
    return { emails: pick("email:"), slugs: pick("linkedin:") };
  }

  /** Live presence rows of workspaces other than `workspace` for these identities, newest first. */
  private livePresenceElsewhere(
    workspace: string,
    id: { emails: string[]; slugs: string[] },
    limit: number,
  ): CadencePresence[] {
    const match = [
      ...(id.emails.length > 0 ? [`email IN (${id.emails.map(() => "?").join(",")})`] : []),
      ...(id.slugs.length > 0 ? [`linkedin_slug IN (${id.slugs.map(() => "?").join(",")})`] : []),
    ];
    if (match.length === 0) return [];
    return this.db
      .query(
        `SELECT workspace, play_name, prospect_id, email, linkedin_slug, status, updated_at
         FROM cadence_presence
         WHERE workspace != ? AND ${SharedDb.LIVE_CADENCE_SQL} AND (${match.join(" OR ")})
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(workspace, ...id.emails, ...id.slugs, limit) as CadencePresence[];
  }

  /**
   * A live cadence (active or paused) another workspace runs with this person,
   * matched by the email, its known aliases, or the LinkedIn profile; null when
   * none. `workspace`'s own cadences never count.
   */
  liveCadenceElsewhere(input: {
    email?: string | null;
    linkedinUrl?: string | null;
    workspace: string;
  }): CadencePresence | null {
    const id = this.presenceIdentity(
      input.email?.trim().toLowerCase() || null,
      linkedInAliasSlug(input.linkedinUrl),
    );
    return this.livePresenceElsewhere(input.workspace, id, 1)[0] ?? null;
  }

  /** Every live cadence of `workspace` whose person also has a live cadence in another workspace. */
  cadenceOverlaps(workspace: string): CadenceOverlap[] {
    const here = this.db
      .query(
        `SELECT workspace, play_name, prospect_id, email, linkedin_slug, status, updated_at
         FROM cadence_presence WHERE workspace = ? AND ${SharedDb.LIVE_CADENCE_SQL}
         ORDER BY play_name, COALESCE(email, linkedin_slug), prospect_id`,
      )
      .all(workspace) as CadencePresence[];
    return here.flatMap((row) => {
      const id = this.presenceIdentity(row.email, row.linkedin_slug);
      return this.livePresenceElsewhere(workspace, id, 1000)
        .toSorted(
          (a, b) =>
            a.workspace.localeCompare(b.workspace) || a.play_name.localeCompare(b.play_name),
        )
        .map((elsewhere) => ({ here: row, elsewhere }));
    });
  }

  /** One workspace's presence rows, by prospect and play. */
  cadencePresenceOf(workspace: string): CadencePresence[] {
    return this.db
      .query(
        `SELECT workspace, play_name, prospect_id, email, linkedin_slug, status, updated_at
         FROM cadence_presence WHERE workspace = ? ORDER BY prospect_id, play_name`,
      )
      .all(workspace) as CadencePresence[];
  }

  /** All live touches of an email across workspaces, newest first (doctor / UI detail). */
  touchesFor(email: string, limit = 20): ContactTouch[] {
    const emails = this.contactEmails(email);
    return this.db
      .query(
        `SELECT workspace, play_name, sent_at, status FROM contact_touches
         WHERE email IN (${emails.map(() => "?").join(",")}) AND ${SharedDb.LIVE_TOUCH_SQL} ORDER BY sent_at DESC LIMIT ?`,
      )
      .all(...emails, ...this.liveTouchArgs(), limit) as ContactTouch[];
  }

  /**
   * One-time copy of a ledger's cache tables into the shared file (INSERT OR
   * IGNORE: shared rows win). Keyed by ledger path; the ledger's own tables
   * are left in place for rollback.
   */
  ensureImported(ledgerDb: Database, ledgerPath: string): void {
    if (this.importedFrom.has(ledgerPath)) return;
    // Everything (marker check, row copy, marker insert) under ONE write
    // lock. Committing the marker first would let a copy failure permanently
    // abandon the rows, and let a concurrent process see "imported" while the
    // copy was still running.
    this.db.exec("BEGIN IMMEDIATE");
    let copied = { enrich: 0, linkedin: 0 };
    try {
      const done = this.db
        .query("SELECT 1 FROM legacy_imports WHERE ledger_path = ?")
        .get(ledgerPath);
      if (!done) {
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
        const ins1 = this.db.prepare(
          `INSERT OR IGNORE INTO enrichment_cache(email, result_json, fetched_at, status) VALUES(?, ?, ?, ?)`,
        );
        for (const r of enrich) ins1.run(r.email, r.result_json, r.fetched_at, r.status);
        const ins2 = this.db.prepare(
          `INSERT OR IGNORE INTO linkedin_lookup_cache(query_key, url, status, fetched_at) VALUES(?, ?, ?, ?)`,
        );
        for (const r of linkedin) ins2.run(r.query_key, r.url, r.status, r.fetched_at);
        this.db
          .prepare(`INSERT OR IGNORE INTO legacy_imports(ledger_path, imported_at) VALUES(?, ?)`)
          .run(ledgerPath, new Date().toISOString());
        copied = { enrich: enrich.length, linkedin: linkedin.length };
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
    this.importedFrom.add(ledgerPath);
    if (copied.enrich + copied.linkedin > 0) {
      logEvent("shared_db.legacy_import", {
        enrichment_rows: copied.enrich,
        linkedin_rows: copied.linkedin,
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
    // Don't leak the old handle (tests re-point ONESHOT_GTM_SHARED per file).
    try {
      singleton?.db.close();
    } catch {
      // already closed
    }
    singleton = { path, db: new SharedDb(path) };
  }
  return singleton.db;
}

/**
 * Advisory read (draft time); the authoritative gate is `claimContactTouch`
 * at send time. Fail-open: a shared-DB hiccup must not block a send. This is
 * reputation hygiene, not hard-bounce suppression.
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

/**
 * Send-time gate: atomically learn another workspace holds this address, or
 * reserve it. Caller invokes `finish(ok)`: confirm on success, release on
 * failure. `override` reserves without checking (the manual send must still
 * be visible to other workspaces). Fail-open; no-op in demo mode.
 */
export function claimContactTouch(input: { email: string; playName: string; override: boolean }): {
  held: ContactTouch | null;
  finish: (ok: boolean) => void;
} {
  const noop = { held: null, finish: () => {} };
  if (demoMode()) return noop;
  try {
    const db = getSharedDb();
    const workspace = currentWorkspaceName();
    let id: number;
    if (input.override) {
      id = db.reserveTouch({ email: input.email, workspace, playName: input.playName });
    } else {
      const claim = db.claimTouch({ email: input.email, workspace, playName: input.playName });
      // The row observed INSIDE the claim transaction is the verdict. Re-
      // querying here could see it released a millisecond later and let the
      // send go out unreserved.
      if ("held" in claim) return { held: claim.held, finish: () => {} };
      id = claim.reservationId;
    }
    return {
      held: null,
      finish: (ok) => {
        try {
          if (ok) db.confirmTouch(id);
          else db.releaseTouch(id);
        } catch (err) {
          logEvent(
            "shared_db.write_failed",
            { message_120: ((err as Error).message ?? "").slice(0, 120) },
            "warn",
          );
        }
      },
    };
  } catch (err) {
    logEvent(
      "shared_db.write_failed",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
    return noop;
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

/**
 * A personal LinkedIn profile's slug as person aliases key it (decoded,
 * lowercased), or null for anything else (X and GitHub URLs, company pages).
 */
export function linkedInAliasSlug(url: string | null | undefined): string | null {
  const alias = personAliases({ linkedin_url: url ?? null }).find((a) => a.startsWith("linkedin:"));
  return alias ? alias.slice("linkedin:".length) : null;
}

/**
 * Advisory read for a first touch: another workspace's live cadence with
 * this person, or null. Fail-open like `recentTouchElsewhere`; null in demo
 * mode, which never reads real contact history.
 */
export function liveCadenceElsewhere(input: {
  email?: string | null;
  linkedinUrl?: string | null;
}): CadencePresence | null {
  if (demoMode()) return null;
  try {
    return getSharedDb().liveCadenceElsewhere({ ...input, workspace: currentWorkspaceName() });
  } catch (err) {
    logEvent(
      "shared_db.read_failed",
      { message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
    return null;
  }
}

/** Human phrasing for a hold: "in a live sequence in workspace 'x' (play)". */
export function describeLiveCadence(p: CadencePresence): string {
  return `in a live sequence in workspace '${p.workspace}' (${p.play_name})`;
}

/** Human phrasing for a hold note / tooltip: "emailed by workspace 'x' (play) 3d ago". */
export function describeTouch(t: ContactTouch): string {
  const days = Math.max(0, Math.floor((Date.now() - new Date(t.sent_at).getTime()) / 86_400_000));
  return `emailed by workspace '${t.workspace}' (${t.play_name}) ${days}d ago`;
}
