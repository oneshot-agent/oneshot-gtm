import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./config.ts";
import { getSharedDb } from "./shared-db.ts";
import type { ReplyKind } from "./reply-classify.ts";
import type {
  AuthVerdict,
  BounceKind,
  BounceRecord,
  CanaryResultRecord,
  GmailPlacement,
  InboxReplyRecord,
  IcpDecisionExample,
  InterviewRecord,
  ProspectRecord,
  QueueRow,
  QueueStatus,
  ReceiptRecord,
  SequenceEventRecord,
  TriggerRow,
} from "./types.ts";

const ICP_EXAMPLE_FIELDS = [
  "title",
  "url",
  "summary",
  "author",
  "description",
  "postTitle",
  "postUrl",
  "repo",
  "repoUrl",
  "eventName",
  "eventUrl",
  "company",
] as const;

/** Keep classifier examples useful without returning enriched contact data. */
function icpExampleCandidate(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const source = payload as Record<string, unknown>;
  return Object.fromEntries(
    ICP_EXAMPLE_FIELDS.flatMap((field) => {
      const value = source[field];
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? [[field, value] as const]
        : [];
    }),
  );
}

const DEFAULT_DB_PATH = join(configDir(), "ledger.sqlite");

/** How long a SUCCESSFUL enrichment is reused before refetching (profiles are stable). */
export const ENRICH_CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
/** How long a FAILED enrichment suppresses retries — long enough to ride out an SDK outage, short enough to self-heal. */
export const ENRICH_FAILURE_TTL_MS = 3 * 24 * 3600 * 1000;
/**
 * Hard ceiling on waiting for one enrichProfile call. The platform's enrich
 * tool has been observed HANGING (no error, no result, 5+ min) rather than
 * failing — callers race against this and treat a deadline as a failure.
 */
export const ENRICH_DEADLINE_MS = 120_000;

/**
 * How long a SUCCESSFUL person dossier (deepResearchPerson) is reused. Longer
 * than the enrich TTL: a person's org history and profiles change slowly, and
 * the call costs 10x as much (~$0.05 vs ~$0.005).
 */
export const RESEARCH_CACHE_TTL_MS = 90 * 24 * 3600 * 1000;
/**
 * Hard ceiling on one deepResearchPerson call. Its own doc comment puts it at
 * 2-5 minutes, so this sits above that rather than at the enrich ceiling — the
 * call is legitimately slow, and racing it at 120s would abandon work we paid for.
 */
export const RESEARCH_DEADLINE_MS = 360_000;

/** How long a FOUND LinkedIn URL is reused. Profile URLs effectively never change. */
export const LINKEDIN_CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
/**
 * How long a genuine MISS ("we searched, this person has no findable profile")
 * suppresses re-searching. Longer than the enrich failure TTL because a miss is
 * a real answer rather than an outage — but not permanent, since people do
 * create profiles. Every re-search costs ~$0.01, so this directly caps the
 * spend of repeatedly running finders over the same candidate pool.
 */
export const LINKEDIN_MISS_TTL_MS = 14 * 24 * 3600 * 1000;

/**
 * Canonical form for matching prospect emails — trim + lowercase. Inbound reply
 * addresses (cadence inbox poll) are normalized the same way, so a prospect
 * stored from a mixed-case address still matches when they reply. Applied on
 * both store (upsertProspect) and every lookup so the two never diverge.
 */
function canonEmail(email: string): string {
  return email.trim().toLowerCase();
}

function safeParseJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** A `cadence_state` row joined with its prospect's email/name/company. */
export interface CadenceWithProspect {
  prospect_id: number;
  play_name: string;
  current_step: number;
  status: string;
  enrolled_at: string;
  next_due_at: string | null;
  last_polled_at: string | null;
  next_step_draft_json: string | null;
  next_step_drafted_at: string | null;
  /**
   * ISO timestamp when a fire-and-forget send was claimed for this cadence.
   * Null = no send in flight. Survives server restart so the UI's "sending"
   * spinner doesn't get stranded by a `bun --watch` reload mid-SDK-call.
   */
  sending_started_at: string | null;
  /** Last send-failure message (truncated); cleared on any forward progress.
   *  Non-null = the most recent send attempt failed and nothing has succeeded
   *  since — drives the "send failed · retrying" row indicator. */
  last_send_error: string | null;
  /** ISO timestamp of `last_send_error`. */
  last_send_error_at: string | null;
  prospect_email: string | null;
  prospect_name: string | null;
  prospect_company: string | null;
}

/**
 * Subject as a thread key: reply/forward prefixes stripped (en/de/fr/es/sv/
 * pt/nl variants, repeated), case-folded, whitespace collapsed. Empty → null.
 */
function normalizeSubject(subject: string | null | undefined): string | null {
  if (!subject) return null;
  let s = subject.trim();
  // Each `\s*` is reachable by exactly one path, so a run of spaces can't be
  // split between two of them (CodeQL: polynomial backtracking).
  const prefix = /^(?:re|fw|fwd|aw|wg|sv|vs|rv|enc|tr|antw)(?:\s*\[\d+\])?\s*:\s*/i;
  while (prefix.test(s)) s = s.replace(prefix, "");
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s.length > 0 ? s : null;
}

export class Ledger {
  private db: Database;
  private readonly path: string;

  constructor(path: string = DEFAULT_DB_PATH) {
    this.path = path;
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    // Wait (don't immediately throw) when another connection holds the write
    // lock — e.g. a background send and a request both opening the ledger, or
    // parallel test workers running first-run migrations against a shared file.
    // Without this, concurrent DDL surfaces as a spurious "database is locked"
    // / "no such table" mid-migration.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        play_name TEXT NOT NULL,
        call_type TEXT NOT NULL,
        cost_usd REAL,
        signed_receipt TEXT,
        oneshot_request_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_receipts_play ON receipts(play_name);
      CREATE INDEX IF NOT EXISTS idx_receipts_created ON receipts(created_at);
      -- listReceipts / spend rollups filter (play_name, created_at) together and
      -- sort by created_at; the composite serves both without a separate sort scan.
      CREATE INDEX IF NOT EXISTS idx_receipts_play_created ON receipts(play_name, created_at);
      -- Backs recordReceipt's dedup-by-job-id lookup. Partial (non-null only):
      -- many receipts have no request_id and must NOT collapse together.
      CREATE INDEX IF NOT EXISTS idx_receipts_request ON receipts(oneshot_request_id)
        WHERE oneshot_request_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS prospects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        email TEXT,
        phone TEXT,
        company TEXT,
        linkedin_url TEXT,
        dossier_json TEXT,
        source TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_email ON prospects(email) WHERE email IS NOT NULL;

      CREATE TABLE IF NOT EXISTS sequence_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prospect_id INTEGER NOT NULL,
        play_name TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(prospect_id) REFERENCES prospects(id)
      );
      -- sequence_events is read by listColdProspects (MAX(created_at) per
      -- prospect), per-play send counts, and cadence scans — all by
      -- prospect_id and/or created_at. Without this it's a full table scan.
      CREATE INDEX IF NOT EXISTS idx_sequence_events_prospect_created ON sequence_events(prospect_id, created_at);
      -- listSequenceEventsForProspectPlay (per-row in /api/cadences toView)
      -- and listSequenceEventsForCadences (bulk variant) both filter on
      -- (prospect_id, play_name) and ORDER BY step_index — composite index
      -- serves both the seek and the sort, no temp B-tree.
      CREATE INDEX IF NOT EXISTS idx_sequence_events_prospect_play ON sequence_events(prospect_id, play_name, step_index);

      CREATE TABLE IF NOT EXISTS interviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        person TEXT NOT NULL,
        transcript_path TEXT,
        jtbd TEXT,
        pain_quotes_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS cadence_state (
        prospect_id INTEGER NOT NULL,
        play_name TEXT NOT NULL,
        current_step INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
        next_due_at TEXT,
        last_polled_at TEXT,
        PRIMARY KEY (prospect_id, play_name)
      );
      CREATE INDEX IF NOT EXISTS idx_cadence_status ON cadence_state(status);
      CREATE INDEX IF NOT EXISTS idx_cadence_next_due ON cadence_state(next_due_at);

      CREATE TABLE IF NOT EXISTS deal_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prospect_id INTEGER NOT NULL,
        play_name TEXT,
        outcome TEXT NOT NULL,
        amount_usd REAL,
        notes TEXT,
        recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY(prospect_id) REFERENCES prospects(id)
      );
      CREATE INDEX IF NOT EXISTS idx_outcomes_prospect ON deal_outcomes(prospect_id);
      CREATE INDEX IF NOT EXISTS idx_outcomes_outcome ON deal_outcomes(outcome);
      CREATE INDEX IF NOT EXISTS idx_outcomes_play ON deal_outcomes(play_name);

      CREATE TABLE IF NOT EXISTS target_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        play_name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        found_at TEXT NOT NULL DEFAULT (datetime('now')),
        reviewed_at TEXT,
        sent_at TEXT,
        notes TEXT,
        prospect_id INTEGER,
        last_draft_json TEXT,
        last_drafted_at TEXT,
        FOREIGN KEY(prospect_id) REFERENCES prospects(id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_dedupe ON target_queue(play_name, dedupe_key);
      CREATE INDEX IF NOT EXISTS idx_queue_status ON target_queue(status);
      CREATE INDEX IF NOT EXISTS idx_queue_play ON target_queue(play_name);
      -- The /queue page filters by (status, play) together; the composite
      -- serves that pair without falling back to a single-column scan.
      CREATE INDEX IF NOT EXISTS idx_queue_status_play ON target_queue(status, play_name);

      CREATE TABLE IF NOT EXISTS triggers (
        name TEXT PRIMARY KEY,
        last_polled_at TEXT,
        last_run_summary TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT,
        running_started_at TEXT
      );

      CREATE TABLE IF NOT EXISTS enrichment_cache (
        email TEXT PRIMARY KEY,
        result_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );

      -- v17 (2026-08): persistent LinkedIn-lookup cache. findLinkedInUrl used a
      -- per-process Map, so every scheduler restart re-paid ~$0.01/webSearch for
      -- the same misses. Keyed by the normalized (fullName, disambiguators)
      -- query. A NULL url with status 'miss' = searched and genuinely not found;
      -- transient failures are NEVER cached (see the isTransientToolError guard
      -- at the call site) or an outage would suppress lookups for weeks.
      CREATE TABLE IF NOT EXISTS linkedin_lookup_cache (
        query_key  TEXT PRIMARY KEY,
        url        TEXT,
        status     TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        play_name TEXT NOT NULL,
        dry_run INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','done','interrupted','cancelled')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        target_count INTEGER NOT NULL,
        drafted_count INTEGER NOT NULL DEFAULT 0,
        sent_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        targets_json TEXT NOT NULL,
        dedupe_keys_json TEXT NOT NULL DEFAULT '[]',
        events_json TEXT NOT NULL DEFAULT '[]',
        prospect_emails_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
      INSERT OR IGNORE INTO schema_version(version) VALUES(6);
    `);

    // Lightweight migrations for installs that pre-date a column.
    this.addColumnIfMissing("prospects", "phone", "TEXT");
    // v17: source profile URL (GitHub / X / Luma) as a re-enrichment key —
    // `linkedin_url` is polymorphic and can't serve that role.
    this.addColumnIfMissing("prospects", "source_profile_url", "TEXT");
    // v18: job title at contact time (person-level ICP gate, _qualify.ts).
    // NULL on rows contacted before the gate existed.
    this.addColumnIfMissing("prospects", "title", "TEXT");
    // v18: person-level ICP verdict ('pass' | 'reject', NULL = unjudged) +
    // reason. The cadence step runner refuses follow-ups to 'reject' rows —
    // the gate must be code-level, not prompt-level.
    this.addColumnIfMissing("prospects", "icp_verdict", "TEXT");
    this.addColumnIfMissing("prospects", "icp_verdict_reason", "TEXT");
    // v5: trigger run-state, so a restart doesn't strand fire-and-forget runs.
    // See sweepStaleRunningTriggers + fireTriggerNow.
    this.addColumnIfMissing("triggers", "running_started_at", "TEXT");
    // v6: persisted per-row drafts (the /run SSE stream is ephemeral).
    this.addColumnIfMissing("target_queue", "last_draft_json", "TEXT");
    this.addColumnIfMissing("target_queue", "last_drafted_at", "TEXT");
    // v7: lease column — dequeueApproved flips it in a transaction so
    // concurrent drains claim disjoint slices; 15-min lease self-heals a
    // crashed drain.
    this.addColumnIfMissing("target_queue", "drain_claimed_at", "TEXT");
    // v8: per-cadence next-step draft preview; cleared on cadence advance.
    this.addColumnIfMissing("cadence_state", "next_step_draft_json", "TEXT");
    this.addColumnIfMissing("cadence_state", "next_step_drafted_at", "TEXT");
    // v9: send-in-flight marker so a fire-and-forget cadence send survives a
    // restart. CAS-claimed (claimCadenceSendingMarker); cleared on success and
    // failure; sweepStaleCadenceSends treats cold-boot markers as stranded.
    this.addColumnIfMissing("cadence_state", "sending_started_at", "TEXT");
    // v10: mirror of v9 for the queue Send-draft path (claimQueueSendingMarker
    // + sweepStaleQueueSends; cleared by setQueueStatus on terminal states).
    this.addColumnIfMissing("target_queue", "send_started_at", "TEXT");
    // v11: sender rotation. sender_identity feeds the per-identity daily
    // counter + warm-up date; sender_assignments pins each prospect to their
    // first-touch identity so follow-ups never switch From address mid-thread.
    // Keyed by email, NOT prospect_id — some sends predate the prospect row.
    this.addColumnIfMissing("receipts", "sender_identity", "TEXT");
    // v12: negative enrichment caching. NULL/"ok" = success, "failed" = skip
    // retries within ENRICH_FAILURE_TTL_MS instead of re-paying ~70s timeouts.
    this.addColumnIfMissing("enrichment_cache", "status", "TEXT");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sender_assignments (
        email TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL,
        assigned_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_receipts_calltype_sender
        ON receipts(call_type, sender_identity, created_at);
    `);
    // v13: inbox reply persistence. thread_key = Gmail thread_id (else email
    // id). inbox_drafts = single mutable draft per thread (cleared on send);
    // inbox_sent = append-only history of replies actually sent.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_drafts (
        thread_key       TEXT PRIMARY KEY,
        inbound_email_id TEXT NOT NULL,
        to_email         TEXT NOT NULL,
        subject          TEXT,
        identity_id      TEXT,
        body             TEXT NOT NULL,
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS inbox_sent (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_key  TEXT NOT NULL,
        to_email    TEXT NOT NULL,
        subject     TEXT,
        body        TEXT NOT NULL,
        identity_id TEXT,
        request_id  TEXT,
        sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_inbox_sent_thread
        ON inbox_sent(thread_key, sent_at);
    `);
    // v14: last cadence send FAILURE, so /cadences can distinguish "blocked
    // upstream" from "waiting on the founder". Set by recordCadenceSendError;
    // cleared on any forward progress.
    this.addColumnIfMissing("cadence_state", "last_send_error", "TEXT");
    this.addColumnIfMissing("cadence_state", "last_send_error_at", "TEXT");
    // v15: candidates whose contact-resolution failed on a TRANSIENT platform
    // error. Time-windowed finders (luma, show-hn) can't re-discover an expired
    // source, so the scheduler retry pass drains this; the (play_name,
    // dedupe_key) PK doubles as the de-dup key against re-scan.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_resolution (
        play_name       TEXT NOT NULL,
        dedupe_key      TEXT NOT NULL,
        source          TEXT NOT NULL,
        raw_json        TEXT NOT NULL,
        first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
        last_attempt_at TEXT,
        attempts        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (play_name, dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS idx_pending_resolution_seen
        ON pending_resolution(first_seen_at);
    `);
    // v16: receipt annotation. memo + decision_context mirror the audit fields
    // sent to OneShot at call time; value_tag(_at) hold the outcome value set
    // by tagOutcomeValue. sequence_events.receipt_id links a sent step to its
    // send receipt so outcomes know which receipts to tag (resolved upstream
    // via request_id — no platform receipt-id backfill needed).
    this.addColumnIfMissing("receipts", "memo", "TEXT");
    this.addColumnIfMissing("receipts", "decision_context", "TEXT");
    this.addColumnIfMissing("receipts", "value_tag", "TEXT");
    this.addColumnIfMissing("receipts", "value_tagged_at", "TEXT");
    this.addColumnIfMissing("sequence_events", "receipt_id", "INTEGER");
    this.db.exec(`
      -- value-tag filter on the /receipts page; partial (tagged rows only).
      CREATE INDEX IF NOT EXISTS idx_receipts_value_tag
        ON receipts(value_tag, created_at) WHERE value_tag IS NOT NULL;
    `);
    // v17: goal-level value attribution — goal_id mirrors decisionContext.goalId
    // so an outcome tags every receipt in the cadence at once.
    this.addColumnIfMissing("receipts", "goal_id", "TEXT");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_receipts_goal
        ON receipts(goal_id) WHERE goal_id IS NOT NULL;
    `);
    // v18: delivery failures parsed from DSNs. PK (message_id, recipient):
    // the provider's message id makes the every-tick re-sweep idempotent, and
    // recipient keeps multi-recipient reports from collapsing into one row.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bounces (
        message_id  TEXT NOT NULL,
        recipient   TEXT NOT NULL,
        identity_id TEXT,
        kind        TEXT NOT NULL,
        status_code TEXT,
        diagnostic  TEXT,
        prospect_id INTEGER,
        bounced_at  TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (message_id, recipient)
      );
      -- doctor's per-identity rate over a trailing window.
      CREATE INDEX IF NOT EXISTS idx_bounces_identity ON bounces(identity_id, bounced_at);
      -- suppressionFor, on the send pre-flight path — must be an index seek.
      CREATE INDEX IF NOT EXISTS idx_bounces_recipient ON bounces(recipient, kind);
    `);
    // v19: inbox-placement canary results — one row per manual A→B test.
    // Append-only so the reputation trend stays visible.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS canary_results (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        from_identity TEXT NOT NULL,
        to_identity   TEXT NOT NULL,
        placement     TEXT NOT NULL,
        labels_json   TEXT,
        spf           TEXT NOT NULL,
        dkim          TEXT NOT NULL,
        dmarc         TEXT NOT NULL,
        subject       TEXT,
        source_play   TEXT,
        same_domain   INTEGER NOT NULL DEFAULT 0,
        latency_ms    INTEGER,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_canary_created ON canary_results(created_at DESC);
    `);
    // v20: reply-poll watermark — persisted high-water mark makes the inbox
    // poll "everything since last success"; a failed tick leaves the mark in
    // place so the next good poll re-covers the gap.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS poll_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // v21: inbound replies persisted at detection (body included) — the ledger,
    // not the mailbox, is the store; a reply must never depend on a live fetch
    // window. PK is the provider email id so the poll's overlap re-sweeps and
    // the /inbox route's opportunistic captures are idempotent (mirrors
    // bounces). Only prospect-matched mail is stored.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_replies (
        id                 TEXT PRIMARY KEY,
        thread_key         TEXT NOT NULL,
        prospect_id        INTEGER NOT NULL,
        play_name          TEXT,
        from_email         TEXT NOT NULL,
        subject            TEXT,
        body               TEXT NOT NULL,
        received_at        TEXT NOT NULL,
        source_identity_id TEXT,
        thread_id          TEXT,
        message_id         TEXT,
        created_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_inbox_replies_prospect
        ON inbox_replies(prospect_id, received_at);
      CREATE INDEX IF NOT EXISTS idx_inbox_replies_thread
        ON inbox_replies(thread_key, received_at);
    `);
    // v23: reply classification ('human' | 'auto' | 'auto_permanent' |
    // 'unsubscribe', see reply-classify.ts). NULL = row predates the
    // classifier and reads as 'human' everywhere (coalesce). Must run after
    // the CREATE TABLE above — ALTER on a fresh install needs the table.
    this.addColumnIfMissing("inbox_replies", "kind", "TEXT");
    // contactSuppressionFor, on the send pre-flight path — must be an index seek.
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_inbox_replies_from_kind ON inbox_replies(from_email, kind)`,
    );
    // v22: tweets the x-reposters finder already paid to harvest. Both X data
    // providers bill per resource RETURNED, and the finder's freshness window
    // (48h) is wider than its daily cadence — without this ledger every fresh
    // tweet would be re-bought on two consecutive runs.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS x_harvested_tweets (
        tweet_id     TEXT PRIMARY KEY,
        harvested_at TEXT NOT NULL
      );
    `);
    // v24: 'cancelled' — the terminal state a run lands in when the SSE client
    // disconnects or POST /api/run/:runId/cancel fires, plus the reason that
    // got it there. The CREATE TABLE above already allows it on a fresh
    // install; older installs carry the narrower CHECK and need the rebuild.
    this.widenRunsStatusCheck();
    this.addColumnIfMissing("runs", "cancel_reason", "TEXT");
    this.addColumnIfMissing("runs", "dedupe_keys_json", "TEXT");
    this.db.exec(`UPDATE runs SET dedupe_keys_json = '[]' WHERE dedupe_keys_json IS NULL`);
  }

  /**
   * SQLite cannot ALTER a CHECK constraint, so admitting 'cancelled' into
   * `runs.status` means rebuilding the table. The sqlite_master probe makes
   * this a no-op on fresh installs and on every boot after the first. Only the
   * original columns are copied — `cancel_reason` is added by the ALTER that
   * follows, so this stays correct whichever order an install arrives in.
   * DROP TABLE takes the indexes with it, hence the recreate.
   */
  private widenRunsStatusCheck(): void {
    // Use explicit BEGIN IMMEDIATE so the schema probe happens while holding
    // the write lock — concurrent processes that see the old schema won't both
    // migrate it and destroy each other's cancel_reason data.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'`)
        .get() as { sql: string | null } | null;
      if (!row?.sql || row.sql.includes("'cancelled'")) {
        this.db.exec("ROLLBACK");
        return;
      }
      this.db.exec(`
        CREATE TABLE runs_widened (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          play_name TEXT NOT NULL,
          dry_run INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('running','done','interrupted','cancelled')),
          started_at TEXT NOT NULL,
          completed_at TEXT,
          target_count INTEGER NOT NULL,
          drafted_count INTEGER NOT NULL DEFAULT 0,
          sent_count INTEGER NOT NULL DEFAULT 0,
          error_count INTEGER NOT NULL DEFAULT 0,
          targets_json TEXT NOT NULL,
          events_json TEXT NOT NULL DEFAULT '[]',
          prospect_emails_json TEXT NOT NULL DEFAULT '[]'
        );
        INSERT INTO runs_widened
          (id, play_name, dry_run, status, started_at, completed_at, target_count,
           drafted_count, sent_count, error_count, targets_json, events_json,
           prospect_emails_json)
          SELECT id, play_name, dry_run, status, started_at, completed_at, target_count,
                 drafted_count, sent_count, error_count, targets_json, events_json,
                 prospect_emails_json
          FROM runs;
        DROP TABLE runs;
        ALTER TABLE runs_widened RENAME TO runs;
        CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
      `);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * CAS-claim a timestamp marker on a single row: true when the marker was
   * NULL (or older than `staleCutoffIso`) and was set; false when another
   * caller holds the claim. Shared by every in-flight marker in the ledger.
   * Table/column names are whitelisted to bare ASCII (SQLite can't bind them).
   */
  private claimMarker(opts: {
    table: string;
    pkeyWhere: string;
    column: string;
    pkeyValues: unknown[];
    startedAtIso: string;
    staleCutoffIso?: string;
  }): boolean {
    this.assertSafeIdentifiers(opts.table, opts.column);
    const staleClause = opts.staleCutoffIso
      ? ` AND (${opts.column} IS NULL OR ${opts.column} < ?)`
      : ` AND ${opts.column} IS NULL`;
    const args = opts.staleCutoffIso
      ? [opts.startedAtIso, ...opts.pkeyValues, opts.staleCutoffIso]
      : [opts.startedAtIso, ...opts.pkeyValues];
    const result = this.db
      .prepare(
        `UPDATE ${opts.table}
         SET ${opts.column} = ?
         WHERE ${opts.pkeyWhere}${staleClause}`,
      )
      .run(...(args as never[]));
    return result.changes > 0;
  }

  /**
   * Release a timestamp marker (set to NULL). Idempotent — no-op if the row
   * doesn't exist or the column is already NULL.
   */
  private clearMarker(opts: {
    table: string;
    pkeyWhere: string;
    column: string;
    pkeyValues: unknown[];
  }): void {
    this.assertSafeIdentifiers(opts.table, opts.column);
    this.db
      .prepare(`UPDATE ${opts.table} SET ${opts.column} = NULL WHERE ${opts.pkeyWhere}`)
      .run(...(opts.pkeyValues as never[]));
  }

  private assertSafeIdentifiers(table: string, column: string): void {
    const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
    if (!ident.test(table) || !ident.test(column)) {
      throw new Error(`unsafe identifier in marker helper: ${table}.${column}`);
    }
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    // Defense-in-depth: SQLite has no parameter binding for table/column/type
    // names, so we must validate. Whitelist to bare ASCII identifiers only.
    const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
    if (!ident.test(table) || !ident.test(column)) {
      throw new Error(`unsafe identifier in addColumnIfMissing: ${table}.${column}`);
    }
    if (!/^[A-Z][A-Z0-9_ ]*$/.test(type)) {
      throw new Error(`unsafe column type in addColumnIfMissing: ${type}`);
    }
    const cols = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch (err) {
      // Two connections can both see the column as missing (check-then-alter
      // is unlocked); the loser's ALTER must not abort Ledger construction.
      // Same tolerance as SharedDb.migrate.
      if (!/duplicate column/i.test((err as Error).message ?? "")) throw err;
    }
  }

  enrollCadence(input: { prospectId: number; playName: string; nextDueAt: string }): void {
    this.db
      .prepare(
        `INSERT INTO cadence_state(prospect_id, play_name, current_step, status, next_due_at)
         VALUES(?, ?, 0, 'active', ?)
         ON CONFLICT(prospect_id, play_name) DO UPDATE SET
           status = 'active',
           next_due_at = excluded.next_due_at,
           last_polled_at = NULL,
           last_send_error = NULL,
           last_send_error_at = NULL`,
      )
      .run(input.prospectId, input.playName, input.nextDueAt);
  }

  listActiveCadences(opts: { dueByIso?: string } = {}): CadenceWithProspect[] {
    const where: string[] = ["c.status = 'active'"];
    const args: unknown[] = [];
    if (opts.dueByIso) {
      where.push("(c.next_due_at IS NULL OR c.next_due_at <= ?)");
      args.push(opts.dueByIso);
    }
    const sql = `
      SELECT c.*, p.email AS prospect_email, p.name AS prospect_name, p.company AS prospect_company
      FROM cadence_state c
      JOIN prospects p ON p.id = c.prospect_id
      WHERE ${where.join(" AND ")}
      ORDER BY c.next_due_at ASC NULLS LAST
    `;
    return this.db.query(sql).all(...(args as never[])) as never;
  }

  listAllCadences(): CadenceWithProspect[] {
    const sql = `
      SELECT c.*, p.email AS prospect_email, p.name AS prospect_name, p.company AS prospect_company
      FROM cadence_state c
      JOIN prospects p ON p.id = c.prospect_id
      ORDER BY c.status ASC, c.next_due_at ASC NULLS LAST
    `;
    return this.db.query(sql).all() as never;
  }

  /**
   * Single cadence (joined with its prospect) by (prospect_id, play_name) — an
   * index seek on the `cadence_state` PRIMARY KEY. Replaces the O(n)
   * `listAllCadences().find(...)` scan callers used to do per row.
   */
  getCadence(prospectId: number, playName: string): CadenceWithProspect | null {
    const sql = `
      SELECT c.*, p.email AS prospect_email, p.name AS prospect_name, p.company AS prospect_company
      FROM cadence_state c
      JOIN prospects p ON p.id = c.prospect_id
      WHERE c.prospect_id = ? AND c.play_name = ?
    `;
    return (this.db.query(sql).get(prospectId, playName) as CadenceWithProspect) ?? null;
  }

  /** All cadences for one prospect — index seek on cadence_state.prospect_id (PK prefix). */
  listCadencesForProspect(prospectId: number): CadenceWithProspect[] {
    const sql = `
      SELECT c.*, p.email AS prospect_email, p.name AS prospect_name, p.company AS prospect_company
      FROM cadence_state c
      JOIN prospects p ON p.id = c.prospect_id
      WHERE c.prospect_id = ?
      ORDER BY c.status ASC, c.next_due_at ASC NULLS LAST
    `;
    return this.db.query(sql).all(prospectId) as never;
  }

  advanceCadence(input: {
    prospectId: number;
    playName: string;
    newStep: number;
    nextDueAt: string | null;
  }): void {
    // Also clear any persisted next-step draft AND the sending marker — the
    // draft was for the OLD next step (stale after advance), and a successful
    // advance means the in-flight send for this row is done. /cadences will
    // surface a fresh "no preview yet" state.
    // A successful advance also clears any prior send-failure marker (the send
    // that just advanced us obviously succeeded).
    this.db
      .prepare(
        `UPDATE cadence_state
         SET current_step = ?, next_due_at = ?, last_polled_at = datetime('now'),
             next_step_draft_json = NULL, next_step_drafted_at = NULL,
             sending_started_at = NULL,
             last_send_error = NULL, last_send_error_at = NULL
         WHERE prospect_id = ? AND play_name = ?`,
      )
      .run(input.newStep, input.nextDueAt, input.prospectId, input.playName);
  }

  /**
   * Record the last cadence send FAILURE so /cadences can show the row is
   * blocked upstream (vs. waiting on the founder). Cleared by advanceCadence /
   * setCadenceStatus on any forward progress. No-op if the row is gone.
   */
  recordCadenceSendError(input: { prospectId: number; playName: string; error: string }): void {
    this.db
      .prepare(
        `UPDATE cadence_state
         SET last_send_error = ?, last_send_error_at = datetime('now')
         WHERE prospect_id = ? AND play_name = ?`,
      )
      .run(input.error.slice(0, 200), input.prospectId, input.playName);
  }

  setCadenceStatus(input: {
    prospectId: number;
    playName: string;
    status: "active" | "replied" | "breakup" | "completed" | "bounced" | "off-icp" | "unsubscribed";
  }): void {
    // Non-active terminal states clear the persisted draft AND any send
    // marker — a replied / breakup / completed / bounced cadence shouldn't have
    // a sendable preview hanging around or a stuck "sending" flag. A reply /
    // breakup / completion / bounce also clears any stale send-failure marker
    // (for a bounce that marker is actively misleading: it reads as
    // "retrying", but a dead address will never accept a retry).
    this.db
      .prepare(
        `UPDATE cadence_state
         SET status = ?,
             next_step_draft_json = CASE WHEN ? = 'active' THEN next_step_draft_json ELSE NULL END,
             next_step_drafted_at = CASE WHEN ? = 'active' THEN next_step_drafted_at ELSE NULL END,
             sending_started_at = CASE WHEN ? = 'active' THEN sending_started_at ELSE NULL END,
             last_send_error = CASE WHEN ? = 'active' THEN last_send_error ELSE NULL END,
             last_send_error_at = CASE WHEN ? = 'active' THEN last_send_error_at ELSE NULL END
         WHERE prospect_id = ? AND play_name = ?`,
      )
      .run(
        input.status,
        input.status,
        input.status,
        input.status,
        input.status,
        input.status,
        input.prospectId,
        input.playName,
      );
  }

  setCadenceDraft(input: {
    prospectId: number;
    playName: string;
    draft: {
      subject: string;
      body: string;
      flags: string[];
      payload: unknown;
    };
  }): void {
    const draftedAtIso = new Date().toISOString();
    const json = JSON.stringify({ ...input.draft, draftedAt: draftedAtIso });
    this.db
      .prepare(
        `UPDATE cadence_state
         SET next_step_draft_json = ?, next_step_drafted_at = ?
         WHERE prospect_id = ? AND play_name = ?`,
      )
      .run(json, draftedAtIso, input.prospectId, input.playName);
  }

  getCadenceDraft(input: { prospectId: number; playName: string }): {
    subject: string;
    body: string;
    flags: string[];
    payload: unknown;
    draftedAt: string;
  } | null {
    const row = this.db
      .query(
        `SELECT next_step_draft_json AS j FROM cadence_state
         WHERE prospect_id = ? AND play_name = ?`,
      )
      .get(input.prospectId, input.playName) as { j: string | null } | null;
    if (!row?.j) return null;
    try {
      return JSON.parse(row.j) as {
        subject: string;
        body: string;
        flags: string[];
        payload: unknown;
        draftedAt: string;
      };
    } catch {
      return null;
    }
  }

  clearCadenceDraft(input: { prospectId: number; playName: string }): void {
    this.db
      .prepare(
        `UPDATE cadence_state
         SET next_step_draft_json = NULL, next_step_drafted_at = NULL
         WHERE prospect_id = ? AND play_name = ?`,
      )
      .run(input.prospectId, input.playName);
  }

  /**
   * Save (or overwrite) the single in-progress draft for an inbox thread.
   * Backs the /inbox composer's debounced auto-save so a refresh or navigation
   * away no longer discards the draft. Keyed by thread_key (see `inboxThreadKey`
   * in shared-types) — Gmail thread_id, else the email id.
   */
  upsertInboxDraft(input: {
    threadKey: string;
    inboundEmailId: string;
    toEmail: string;
    subject: string;
    identityId: string | null;
    body: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO inbox_drafts(thread_key, inbound_email_id, to_email, subject, identity_id, body, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_key) DO UPDATE SET
           inbound_email_id = excluded.inbound_email_id,
           to_email = excluded.to_email,
           subject = excluded.subject,
           identity_id = excluded.identity_id,
           body = excluded.body,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.threadKey,
        input.inboundEmailId,
        input.toEmail,
        input.subject,
        input.identityId,
        input.body,
        new Date().toISOString(),
      );
  }

  clearInboxDraft(threadKey: string): void {
    this.db.prepare(`DELETE FROM inbox_drafts WHERE thread_key = ?`).run(threadKey);
  }

  /**
   * Record a reply that was actually sent (append to history) and clear the
   * thread's draft in one transaction. History is append-only because we let
   * the founder reply again on the same thread.
   */
  recordInboxSent(input: {
    threadKey: string;
    toEmail: string;
    subject: string;
    body: string;
    identityId: string | null;
    requestId: string | null;
  }): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO inbox_sent(thread_key, to_email, subject, body, identity_id, request_id, sent_at)
           VALUES(?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.threadKey,
          input.toEmail,
          input.subject,
          input.body,
          input.identityId,
          input.requestId,
          new Date().toISOString(),
        );
      this.db.prepare(`DELETE FROM inbox_drafts WHERE thread_key = ?`).run(input.threadKey);
    })();
  }

  /**
   * Bulk-read persisted reply state for the inbox list route: the saved draft
   * (if any) plus the sent history per thread. Mirrors the `byEmail` map the
   * list route builds for cadence context — one read, indexed by thread_key.
   */
  getInboxThreads(): Map<
    string,
    { draftBody: string | null; sent: { body: string; sentAt: string }[] }
  > {
    const map = new Map<
      string,
      { draftBody: string | null; sent: { body: string; sentAt: string }[] }
    >();
    const ensure = (key: string) => {
      let entry = map.get(key);
      if (!entry) {
        entry = { draftBody: null, sent: [] };
        map.set(key, entry);
      }
      return entry;
    };
    const drafts = this.db
      .query(`SELECT thread_key AS k, body AS b FROM inbox_drafts`)
      .all() as Array<{ k: string; b: string }>;
    for (const d of drafts) ensure(d.k).draftBody = d.b;
    const sent = this.db
      .query(`SELECT thread_key AS k, body AS b, sent_at AS t FROM inbox_sent ORDER BY sent_at ASC`)
      .all() as Array<{ k: string; b: string; t: string }>;
    for (const s of sent) ensure(s.k).sent.push({ body: s.b, sentAt: s.t });
    return map;
  }

  /**
   * Atomic CAS claim of the sending marker — two concurrent Send clicks can't
   * double-fire. `staleCutoffIso` lets a fresh click reclaim a marker stranded
   * by a restart before the cold-boot sweep (else the row 409s until reboot).
   */
  claimCadenceSendingMarker(input: {
    prospectId: number;
    playName: string;
    startedAtIso: string;
    staleCutoffIso?: string;
  }): boolean {
    return this.claimMarker({
      table: "cadence_state",
      pkeyWhere: "prospect_id = ? AND play_name = ?",
      column: "sending_started_at",
      pkeyValues: [input.prospectId, input.playName],
      startedAtIso: input.startedAtIso,
      ...(input.staleCutoffIso ? { staleCutoffIso: input.staleCutoffIso } : {}),
    });
  }

  /** Release the sending marker for this cadence (sets sending_started_at = NULL). */
  clearCadenceSendingMarker(input: { prospectId: number; playName: string }): void {
    this.clearMarker({
      table: "cadence_state",
      pkeyWhere: "prospect_id = ? AND play_name = ?",
      column: "sending_started_at",
      pkeyValues: [input.prospectId, input.playName],
    });
  }

  /**
   * Sweep stale `sending_started_at` markers (any non-null value when
   * `staleAgeMs` is 0 — cold-boot semantics). A matching sequence_event means
   * the send went out: clear the marker only; no event means it was stranded:
   * clear the marker but keep the draft. Returns swept rows; takes `now` +
   * `maxAgeMs` as args so tests don't fake the clock.
   */
  sweepStaleCadenceSends(input: { now: Date; maxAgeMs: number }): Array<{
    prospectId: number;
    playName: string;
    startedAt: string;
    ageMs: number;
    actuallySent: boolean;
  }> {
    const cutoffMs = input.now.getTime() - input.maxAgeMs;
    const rows = this.db
      .query(
        `SELECT prospect_id, play_name, current_step, sending_started_at
         FROM cadence_state
         WHERE sending_started_at IS NOT NULL`,
      )
      .all() as Array<{
      prospect_id: number;
      play_name: string;
      current_step: number;
      sending_started_at: string;
    }>;
    const swept: Array<{
      prospectId: number;
      playName: string;
      startedAt: string;
      ageMs: number;
      actuallySent: boolean;
    }> = [];
    const checkEvent = this.db.prepare(
      `SELECT 1 FROM sequence_events
       WHERE prospect_id = ? AND play_name = ? AND step_index = ?
         AND status IN ('sent','delivered','replied')
       LIMIT 1`,
    );
    const clear = this.db.prepare(
      `UPDATE cadence_state
       SET sending_started_at = NULL
       WHERE prospect_id = ? AND play_name = ?`,
    );
    for (const row of rows) {
      const startedMs = new Date(row.sending_started_at).getTime();
      if (Number.isFinite(startedMs) && startedMs > cutoffMs) continue; // still fresh
      const ageMs = Number.isFinite(startedMs) ? input.now.getTime() - startedMs : -1;
      // The in-flight step's step_index is `current_step + 1` (= nextIndex in the
      // engine): the marker is claimed while current_step still holds the OLD
      // value, and `recordSequenceEvent` writes at nextIndex. So "did the
      // in-flight send land?" checks current_step + 1. We also check current_step
      // to cover the race where advanceCadence already ran (current_step moved to
      // the sent step) but the marker hadn't been cleared yet.
      const sentInflight = checkEvent.get(row.prospect_id, row.play_name, row.current_step + 1);
      const sentAfterAdvance = checkEvent.get(row.prospect_id, row.play_name, row.current_step);
      const actuallySent = sentInflight != null || sentAfterAdvance != null;
      clear.run(row.prospect_id, row.play_name);
      swept.push({
        prospectId: row.prospect_id,
        playName: row.play_name,
        startedAt: row.sending_started_at,
        ageMs,
        actuallySent,
      });
    }
    return swept;
  }

  findProspectByEmail(email: string): { id: number } | null {
    return (
      (this.db.query("SELECT id FROM prospects WHERE email = ?").get(canonEmail(email)) as {
        id: number;
      }) ?? null
    );
  }

  /** Full prospect record by email — used to attach name/company to inbox replies. */
  getProspectByEmail(email: string): ProspectRecord | null {
    return (
      (this.db
        .query("SELECT * FROM prospects WHERE email = ?")
        .get(canonEmail(email)) as ProspectRecord) ?? null
    );
  }

  /**
   * Emails of every prospect with a recorded reply — the target list for the
   * inbox's known-replier fetch, so a reply is never lost to the live window.
   */
  listRepliedProspectEmails(): string[] {
    const rows = this.db
      .query(
        `SELECT DISTINCT p.email FROM sequence_events se
         JOIN prospects p ON p.id = se.prospect_id
         WHERE se.status = 'replied' AND p.email IS NOT NULL AND p.email != ''`,
      )
      .all() as Array<{ email: string }>;
    return rows.map((r) => r.email);
  }

  /**
   * Persist one inbound reply (full body) keyed by provider email id.
   * INSERT OR IGNORE — re-sweeps and double captures are no-ops. Returns true
   * when this call stored a NEW reply.
   */
  recordInboxReply(row: {
    id: string;
    threadKey: string;
    prospectId: number;
    playName?: string | null;
    fromEmail: string;
    subject?: string | null;
    body: string;
    receivedAt: string;
    sourceIdentityId?: string | null;
    threadId?: string | null;
    messageId?: string | null;
    kind?: ReplyKind | null;
  }): boolean {
    const res = this.db
      .query(
        `INSERT OR IGNORE INTO inbox_replies
           (id, thread_key, prospect_id, play_name, from_email, subject, body,
            received_at, source_identity_id, thread_id, message_id, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.threadKey,
        row.prospectId,
        row.playName ?? null,
        canonEmail(row.fromEmail),
        row.subject ?? null,
        row.body,
        row.receivedAt,
        row.sourceIdentityId ?? null,
        row.threadId ?? null,
        row.messageId ?? null,
        row.kind ?? null,
      );
    return res.changes > 0;
  }

  /** All persisted inbound replies for one prospect, oldest first. */
  listInboxRepliesForProspect(prospectId: number): InboxReplyRecord[] {
    return this.db
      .query(`SELECT * FROM inbox_replies WHERE prospect_id = ? ORDER BY received_at ASC, id ASC`)
      .all(prospectId) as InboxReplyRecord[];
  }

  /** Provider ids of every persisted reply — dedupe set for capture passes. */
  listInboxReplyIds(): Set<string> {
    const rows = this.db.query(`SELECT id FROM inbox_replies`).all() as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  }

  /** Prospects that have at least one persisted reply, most recent activity first. */
  listProspectIdsWithReplies(): number[] {
    const rows = this.db
      .query(
        `SELECT prospect_id, MAX(received_at) AS last FROM inbox_replies
         GROUP BY prospect_id ORDER BY last DESC`,
      )
      .all() as Array<{ prospect_id: number }>;
    return rows.map((r) => r.prospect_id);
  }

  /** Full prospect record by id (PK seek). Avoids loading every prospect to find one. */
  getProspectById(id: number): ProspectRecord | null {
    return (
      (this.db.query("SELECT * FROM prospects WHERE id = ?").get(id) as ProspectRecord) ?? null
    );
  }

  /**
   * Paid-lookup caches live in the cross-workspace SHARED DB (shared-db.ts) —
   * the same person must never be bought twice across products. These methods
   * keep their contracts and delegate; this ledger's legacy cache rows are
   * copied across once on first use.
   */
  private shared(): ReturnType<typeof getSharedDb> {
    const shared = getSharedDb();
    shared.ensureImported(this.db, this.path);
    return shared;
  }

  getCachedEnrichment(
    email: string,
  ): { result_json: string; fetched_at: string; status: string | null } | null {
    return this.shared().getCachedEnrichment(email);
  }

  getCachedLinkedIn(
    queryKey: string,
  ): { url: string | null; status: string; fetched_at: string } | null {
    return this.shared().getCachedLinkedIn(queryKey);
  }

  setCachedLinkedIn(queryKey: string, url: string | null): void {
    this.shared().setCachedLinkedIn(queryKey, url);
  }

  setCachedEnrichment(email: string, resultJson: string): void {
    this.shared().setCachedEnrichment(email, resultJson);
  }

  setCachedEnrichmentFailure(email: string, message: string): void {
    this.shared().setCachedEnrichmentFailure(email, message);
  }

  recordReceipt(input: {
    playName: string;
    callType: string;
    /** Per-call USD cost. Every wrapper in `oneshot.ts` reads `result.cost`
     *  from the SDK response (declared on every result type in
     *  `@oneshot-agent/sdk@0.15.2+`) and forwards it here. NULL in the
     *  column when undefined — visible signal that the SDK omitted cost. */
    costUsd?: number;
    signedReceipt?: unknown;
    oneshotRequestId?: string;
    /** EmailIdentity id for email.send receipts — drives per-identity daily caps. */
    senderIdentity?: string;
    /** Call-time memo (the same value sent to OneShot); defaults to "{play} {callType}". */
    memo?: string;
    /** Call-time decisionContext blob; JSON-stringified into the column. */
    decisionContext?: unknown;
  }): number {
    // Idempotent on the job id: the SDK's idempotency replay returns the
    // ORIGINAL request_id when a timed-out/double-fired send is retried, and a
    // Gmail message id is unique per send — so a non-null request_id already in
    // the table means "same underlying send". Return the existing receipt
    // instead of inserting a duplicate that would double-count spend and caps.
    // Null request_ids (cache hits, SDK omissions) are distinct events and skip
    // this — they must never collapse together.
    if (input.oneshotRequestId) {
      const existing = this.db
        .query("SELECT id FROM receipts WHERE oneshot_request_id = ?")
        .get(input.oneshotRequestId) as { id: number } | undefined;
      if (existing) return existing.id;
    }
    // Number.isFinite guard rejects undefined / Infinity / NaN — those land
    // as NULL in the column, NOT silently distorted into a number.
    const costUsd =
      typeof input.costUsd === "number" && Number.isFinite(input.costUsd) ? input.costUsd : null;
    // Mirror what buildAuditOpts sends to OneShot so the stored memo/context
    // match the platform receipt even at call sites that don't enrich.
    const memo = input.memo ?? `${input.playName} ${input.callType}`;
    const decisionContext = input.decisionContext ?? {
      playName: input.playName,
      callType: input.callType,
    };
    // Mirror the cadence correlation key (decisionContext.goalId) into its own
    // column so an outcome can value-tag the whole goal in one UPDATE.
    const goalId =
      typeof (decisionContext as { goalId?: unknown }).goalId === "string"
        ? (decisionContext as { goalId: string }).goalId
        : null;
    const stmt = this.db.prepare(`
      INSERT INTO receipts(play_name, call_type, cost_usd, signed_receipt, oneshot_request_id, sender_identity, memo, decision_context, goal_id)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.playName,
      input.callType,
      costUsd,
      input.signedReceipt ? JSON.stringify(input.signedReceipt) : null,
      input.oneshotRequestId ?? null,
      input.senderIdentity ?? null,
      memo,
      JSON.stringify(decisionContext),
      goalId,
    );
    return Number(result.lastInsertRowid);
  }

  getSenderAssignment(email: string): string | null {
    const row = this.db
      .query("SELECT identity_id FROM sender_assignments WHERE email = ?")
      .get(canonEmail(email)) as { identity_id: string } | undefined;
    return row?.identity_id ?? null;
  }

  /**
   * Pin a prospect email to a sending identity. INSERT OR IGNORE + read-back
   * makes concurrent first-touches race-safe: both callers end up using the
   * single winning assignment instead of splitting the thread across senders.
   */
  assignSender(email: string, identityId: string): string {
    const canon = canonEmail(email);
    this.db
      .prepare("INSERT OR IGNORE INTO sender_assignments(email, identity_id) VALUES(?, ?)")
      .run(canon, identityId);
    return this.getSenderAssignment(canon) ?? identityId;
  }

  /**
   * Sends by an identity since `sinceUtcSqlite`. The timestamp MUST be in
   * SQLite datetime('now') format ("YYYY-MM-DD HH:MM:SS", UTC) — receipts
   * default created_at to that format, and an ISO string with its 'T'
   * separator compares GREATER than any same-day SQLite timestamp, silently
   * excluding today's rows.
   */
  countEmailSendsSince(identityId: string, sinceUtcSqlite: string): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n FROM receipts
         WHERE call_type = 'email.send' AND sender_identity = ? AND created_at >= ?`,
      )
      .get(identityId, sinceUtcSqlite) as { n: number };
    return row.n;
  }

  /**
   * Did we ever email this address pre-rotation? Used to lazy-pin legacy
   * prospects (e.g. in-flight cadences) to the legacy identity instead of
   * letting the rotation picker move their thread to a new From address.
   */
  hasPriorEmailSend(email: string): boolean {
    const row = this.db
      .query(
        `SELECT 1 FROM sequence_events se
         JOIN prospects p ON p.id = se.prospect_id
         WHERE p.email = ? AND se.channel = 'email'
           AND se.status IN ('sent','delivered','replied')
         LIMIT 1`,
      )
      .get(canonEmail(email)) as 1 | undefined;
    return row != null;
  }

  /** First email.send by this identity (warm-up ramp anchor). SQLite-format UTC or null. */
  firstEmailSendAt(identityId: string): string | null {
    const row = this.db
      .query(
        `SELECT MIN(created_at) AS first FROM receipts
         WHERE call_type = 'email.send' AND sender_identity = ?`,
      )
      .get(identityId) as { first: string | null };
    return row.first;
  }

  /**
   * Record one delivery failure. INSERT OR IGNORE on (message_id, recipient):
   * the sweep re-sees the same DSN every tick and it must count once. Returns
   * true only for a NEW bounce — callers gate receipt-tagging/logging on that.
   */
  recordBounce(input: {
    messageId: string;
    recipient: string;
    identityId: string | null;
    kind: BounceKind;
    statusCode: string | null;
    diagnostic: string | null;
    prospectId: number | null;
    bouncedAt: string;
  }): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO bounces
           (message_id, recipient, identity_id, kind, status_code, diagnostic, prospect_id, bounced_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.messageId,
        canonEmail(input.recipient),
        input.identityId,
        input.kind,
        input.statusCode,
        input.diagnostic?.slice(0, 300) ?? null,
        input.prospectId,
        input.bouncedAt,
      );
    return result.changes > 0;
  }

  /**
   * The hard bounce that suppresses this address, or null if it's still
   * sendable. HARD ONLY — a `block` is the receiving server refusing a message
   * on policy, not a statement that the mailbox is dead, so suppressing on it
   * would permanently burn valid prospects over one spam-filter verdict.
   * Soft bounces are transient by definition.
   */
  suppressionFor(email: string): BounceRecord | null {
    return (
      (this.db
        .query(
          `SELECT * FROM bounces WHERE recipient = ? AND kind = 'hard'
           ORDER BY bounced_at DESC LIMIT 1`,
        )
        .get(canonEmail(email)) as BounceRecord) ?? null
    );
  }

  /**
   * A do-not-send verdict from the reply stream: the newest 'unsubscribe'
   * (they asked to stop) or 'auto_permanent' (their responder says the
   * mailbox is dead) captured from this address. Durable on purpose — it
   * outlives any one cadence, so a later play can never re-enroll and email
   * an unsubscribed or gone prospect. Sibling of suppressionFor (bounces).
   */
  contactSuppressionFor(email: string): { kind: string; received_at: string } | null {
    return (
      (this.db
        .query(
          `SELECT kind, received_at FROM inbox_replies
           WHERE from_email = ? AND kind IN ('unsubscribe', 'auto_permanent')
           ORDER BY received_at DESC LIMIT 1`,
        )
        .get(canonEmail(email)) as { kind: string; received_at: string }) ?? null
    );
  }

  /** Bounce counts per sending identity since `sinceIso` — the doctor check's numerator. */
  bounceStatsByIdentity(opts: {
    sinceIso: string;
  }): Map<string, { hard: number; block: number; soft: number }> {
    const rows = this.db
      .query(
        `SELECT identity_id, kind, COUNT(*) AS n FROM bounces
         WHERE bounced_at >= ? AND identity_id IS NOT NULL
         GROUP BY identity_id, kind`,
      )
      .all(opts.sinceIso) as Array<{ identity_id: string; kind: BounceKind; n: number }>;
    const out = new Map<string, { hard: number; block: number; soft: number }>();
    for (const r of rows) {
      let entry = out.get(r.identity_id);
      if (!entry) {
        entry = { hard: 0, block: 0, soft: 0 };
        out.set(r.identity_id, entry);
      }
      entry[r.kind] = r.n;
    }
    return out;
  }

  /** Most recent bounces for display (doctor detail lines, debugging). */
  listRecentBounces(opts: { limit?: number } = {}): BounceRecord[] {
    return this.db
      .query(`SELECT * FROM bounces ORDER BY bounced_at DESC LIMIT ?`)
      .all(opts.limit ?? 20) as BounceRecord[];
  }

  recordCanaryResult(input: {
    fromIdentity: string;
    toIdentity: string;
    placement: GmailPlacement;
    labelIds: string[];
    auth: { spf: AuthVerdict; dkim: AuthVerdict; dmarc: AuthVerdict };
    subject: string | null;
    sourcePlay: string | null;
    sameDomain: boolean;
    latencyMs: number | null;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO canary_results
           (from_identity, to_identity, placement, labels_json, spf, dkim, dmarc,
            subject, source_play, same_domain, latency_ms)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.fromIdentity,
        input.toIdentity,
        input.placement,
        JSON.stringify(input.labelIds),
        input.auth.spf,
        input.auth.dkim,
        input.auth.dmarc,
        input.subject,
        input.sourcePlay,
        input.sameDomain ? 1 : 0,
        input.latencyMs,
      );
    return Number(result.lastInsertRowid);
  }

  /** Newest placement test, or null if one has never been run. */
  latestCanaryResult(): CanaryResultRecord | null {
    return (
      (this.db
        .query(`SELECT * FROM canary_results ORDER BY created_at DESC, id DESC LIMIT 1`)
        .get() as CanaryResultRecord) ?? null
    );
  }

  /**
   * Subject + body of the most recent email this tool actually SENT, for the
   * placement canary to replay. Spam filters judge content, so testing with
   * invented copy would measure nothing that transfers to real outreach.
   * Reads the persisted draft off the sequence_events row (metadata_json
   * carries {subject, body} for sent email steps).
   */
  latestSentEmailCopy(
    opts: { playName?: string } = {},
  ): { subject: string; body: string; playName: string } | null {
    const rows = this.db
      .query(
        // 'sent' rows are UPDATEd in place to 'replied', so all three statuses
        // mean "sent" — matching only 'sent' would skip every prospect who
        // answered. Usability is filtered in SQL (not a JS slice) so the small
        // bound below only ever trims genuinely valid candidates.
        `SELECT play_name, metadata_json FROM sequence_events
         WHERE status IN ('sent', 'delivered', 'replied')
           AND channel = 'email' AND metadata_json IS NOT NULL
           AND json_valid(metadata_json)
           AND json_extract(metadata_json, '$.subject') IS NOT NULL
           AND trim(coalesce(json_extract(metadata_json, '$.body'), '')) != ''
           ${opts.playName ? "AND play_name = ?" : ""}
         -- id DESC breaks ties: created_at is second-precision, and a cadence
         -- batch writes several rows within one second, leaving their relative
         -- order otherwise unspecified.
         ORDER BY created_at DESC, id DESC LIMIT 25`,
      )
      .all(...(opts.playName ? [opts.playName] : [])) as Array<{
      play_name: string;
      metadata_json: string;
    }>;
    // Backstop for shapes SQL can't reject — a numeric subject, say, which
    // json_extract happily returns but which isn't usable copy.
    for (const row of rows) {
      let meta: { subject?: unknown; body?: unknown };
      try {
        meta = JSON.parse(row.metadata_json) as { subject?: unknown; body?: unknown };
      } catch {
        continue;
      }
      if (typeof meta.subject === "string" && typeof meta.body === "string" && meta.body.trim()) {
        return { subject: meta.subject, body: meta.body, playName: row.play_name };
      }
    }
    return null;
  }

  getReceipt(id: number): ReceiptRecord | null {
    return (this.db.query("SELECT * FROM receipts WHERE id = ?").get(id) as ReceiptRecord) ?? null;
  }

  listReceipts(
    opts: { playName?: string; sinceIso?: string; limit?: number } = {},
  ): ReceiptRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.playName) {
      where.push("play_name = ?");
      args.push(opts.playName);
    }
    if (opts.sinceIso) {
      where.push("created_at >= ?");
      args.push(opts.sinceIso);
    }
    const sql = `SELECT * FROM receipts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`;
    args.push(opts.limit ?? 200);
    return this.db.query(sql).all(...(args as never[])) as ReceiptRecord[];
  }

  upsertProspect(input: Partial<ProspectRecord> & { email?: string | null }): number {
    // Store the canonical (lowercased) email so reply matching — which
    // normalizes the inbound from-address the same way — always lands.
    const email = input.email ? canonEmail(input.email) : null;
    if (email) {
      const existing = this.db.query("SELECT id FROM prospects WHERE email = ?").get(email) as
        | { id: number }
        | undefined;
      if (existing) return existing.id;
    }
    const stmt = this.db.prepare(`
      INSERT INTO prospects(name, email, phone, company, linkedin_url, dossier_json, source,
                            source_profile_url, title)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.name ?? null,
      email,
      (input as { phone?: string | null }).phone ?? null,
      input.company ?? null,
      input.linkedin_url ?? null,
      input.dossier_json ?? null,
      input.source ?? null,
      input.source_profile_url ?? null,
      input.title ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * Backfill identity columns that are NULL on an existing prospect — the only
   * such path (`upsertProspect` never writes twice). COALESCE on purpose: a
   * backfill must never clobber a URL a finder already resolved, and
   * `undefined`/`null` leaves the column untouched. True when a column changed.
   */
  updateProspectIdentity(
    id: number,
    patch: {
      linkedin_url?: string | null;
      phone?: string | null;
      company?: string | null;
      source_profile_url?: string | null;
      title?: string | null;
    },
  ): boolean {
    const cols = ["linkedin_url", "phone", "company", "source_profile_url", "title"] as const;
    const set: string[] = [];
    const blank: string[] = [];
    const args: Array<string | number> = [];
    for (const col of cols) {
      const value = patch[col];
      if (typeof value !== "string" || value.trim() === "") continue;
      // NULLIF, not a bare COALESCE: the WHERE guard below counts '' as empty
      // (listProspectsMissingLinkedIn selects those rows), so COALESCE alone
      // would match the row, report a change, and leave the '' in place.
      set.push(`${col} = COALESCE(NULLIF(${col}, ''), ?)`);
      // Guard in the WHERE so the statement only matches when at least one
      // target column is actually empty. Without this `changes` would report 1
      // for a pure no-op (it counts matched rows, not modified columns) and
      // every caller would over-report how much it backfilled.
      blank.push(`(${col} IS NULL OR ${col} = '')`);
      args.push(value.trim());
    }
    if (set.length === 0) return false;
    args.push(id);
    const result = this.db
      .prepare(`UPDATE prospects SET ${set.join(", ")} WHERE id = ? AND (${blank.join(" OR ")})`)
      .run(...(args as never[]));
    return Number(result.changes) > 0;
  }

  /**
   * Record the person-level ICP verdict for a prospect. Overwrites — a
   * re-audit with better data (a real title instead of a stale event bio)
   * must be able to flip an earlier call in either direction.
   *
   * `unclear` is a real, persisted verdict: qualifyPerson is 4-state, and
   * writing its ambiguity as NULL made "we looked and couldn't tell"
   * indistinguishable from "never judged". It is PROVISIONAL, not settled —
   * _qualify.ts escalates `unclear` rather than dropping a candidate, so a
   * re-audit re-judges those rows (picking up role text that arrived since)
   * and skips only pass/reject. Suppression is unaffected — the cadence gate
   * tests `=== "reject"`, so `unclear` fails open exactly as NULL did.
   * `transient` is never persisted; it stays a retry signal.
   */
  setProspectIcpVerdict(
    id: number,
    verdict: "pass" | "reject" | "unclear",
    reason?: string | null,
  ): void {
    this.db
      .prepare("UPDATE prospects SET icp_verdict = ?, icp_verdict_reason = ? WHERE id = ?")
      .run(verdict, reason ?? null, id);
  }

  /**
   * Persist a research dossier onto an existing prospect.
   *
   * Deliberately NOT part of updateProspectIdentity: that method's column
   * allowlist is write-once (COALESCE(NULLIF(col,''), ?)), which is right for
   * identity fields but wrong here — re-researching a person must be able to
   * refresh a stale dossier. Plain overwrite; callers decide whether to skip
   * rows that already have one. Pass null to clear.
   */
  setProspectDossier(id: number, dossier: string | null): void {
    this.db.prepare("UPDATE prospects SET dossier_json = ? WHERE id = ?").run(dossier, id);
  }

  /**
   * Prospects that could take a LinkedIn URL but don't have one. Rows already
   * holding a GitHub/X URL in `linkedin_url` are skipped (updateProspectIdentity
   * won't overwrite them); a name is required — the lookup searches by name.
   */
  listProspectsMissingLinkedIn(opts: { limit?: number; play?: string } = {}): Array<{
    id: number;
    name: string | null;
    company: string | null;
    email: string | null;
    source: string | null;
    source_profile_url: string | null;
  }> {
    const where = ["(linkedin_url IS NULL OR linkedin_url = '')", "name IS NOT NULL", "name != ''"];
    const args: Array<string | number> = [];
    if (opts.play) {
      where.push("source = ?");
      args.push(opts.play);
    }
    args.push(opts.limit ?? 500);
    return this.db
      .query(
        `SELECT id, name, company, email, source, source_profile_url
           FROM prospects
          WHERE ${where.join(" AND ")}
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(...(args as never[])) as Array<{
      id: number;
      name: string | null;
      company: string | null;
      email: string | null;
      source: string | null;
      source_profile_url: string | null;
    }>;
  }

  /**
   * Prospects worth buying a research dossier for, by scope:
   *
   * - `active`   — a cadence is still running, so a dossier changes what gets sent
   * - `replied`  — a live conversation, where reply drafting reads the dossier
   * - `unjudged` — no ICP verdict AND a profile URL to research, so the gate can judge
   * - `all`      — every prospect
   *
   * Scopes union. Rows that already hold a dossier are excluded unless
   * `includeResearched`, so an interrupted run resumes instead of re-buying.
   * A row needs a social URL or an email — deepResearchPerson has nothing to
   * chase otherwise.
   */
  listProspectsForResearch(
    opts: {
      scopes?: ReadonlyArray<"active" | "replied" | "unjudged" | "all">;
      includeResearched?: boolean;
      limit?: number;
    } = {},
  ): Array<{
    id: number;
    name: string | null;
    company: string | null;
    email: string | null;
    source: string | null;
    source_profile_url: string | null;
    linkedin_url: string | null;
  }> {
    const scopes = opts.scopes?.length ? opts.scopes : (["active", "replied", "unjudged"] as const);
    const any: string[] = [];
    if (scopes.includes("all")) {
      any.push("1 = 1");
    } else {
      if (scopes.includes("active")) {
        any.push(
          "EXISTS(SELECT 1 FROM cadence_state cs WHERE cs.prospect_id = p.id AND cs.status = 'active')",
        );
      }
      if (scopes.includes("replied")) {
        any.push("EXISTS(SELECT 1 FROM inbox_replies ir WHERE ir.prospect_id = p.id)");
      }
      if (scopes.includes("unjudged")) {
        any.push(
          "(p.icp_verdict IS NULL AND COALESCE(NULLIF(TRIM(p.source_profile_url), ''), NULLIF(TRIM(p.linkedin_url), '')) IS NOT NULL)",
        );
      }
    }
    if (any.length === 0) return [];

    const where = [`(${any.join(" OR ")})`];
    if (!opts.includeResearched)
      where.push("(p.dossier_json IS NULL OR TRIM(p.dossier_json) = '')");
    // Something for deepResearchPerson to key on.
    where.push(
      "(COALESCE(NULLIF(TRIM(p.source_profile_url), ''), NULLIF(TRIM(p.linkedin_url), '')) IS NOT NULL OR (p.email IS NOT NULL AND TRIM(p.email) != ''))",
    );

    return this.db
      .query(
        `SELECT p.id, p.name, p.company, p.email, p.source, p.source_profile_url, p.linkedin_url
           FROM prospects p
          WHERE ${where.join(" AND ")}
          ORDER BY p.id DESC
          LIMIT ?`,
      )
      .all(opts.limit ?? 100_000) as Array<{
      id: number;
      name: string | null;
      company: string | null;
      email: string | null;
      source: string | null;
      source_profile_url: string | null;
      linkedin_url: string | null;
    }>;
  }

  recordOutcome(input: {
    prospectId: number;
    playName?: string;
    outcome: "meeting_booked" | "sql_qualified" | "deal_won" | "deal_lost" | "ghosted";
    amountUsd?: number;
    notes?: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO deal_outcomes(prospect_id, play_name, outcome, amount_usd, notes)
      VALUES(?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.prospectId,
      input.playName ?? null,
      input.outcome,
      input.amountUsd ?? null,
      input.notes ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  countOutcomes(
    opts: {
      sinceIso?: string;
      playName?: string;
      outcome?: string;
    } = {},
  ): number {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.sinceIso) {
      where.push("recorded_at >= ?");
      args.push(opts.sinceIso);
    }
    if (opts.playName) {
      where.push("play_name = ?");
      args.push(opts.playName);
    }
    if (opts.outcome) {
      where.push("outcome = ?");
      args.push(opts.outcome);
    }
    const sql = `SELECT COUNT(*) AS n FROM deal_outcomes ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    return (this.db.query(sql).get(...(args as never[])) as { n: number } | null)?.n ?? 0;
  }

  outcomesByPlay(opts: { sinceIso?: string } = {}): Array<{
    play_name: string | null;
    meetings: number;
    sqls: number;
    won: number;
    lost: number;
    ghosted: number;
  }> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.sinceIso) {
      where.push("recorded_at >= ?");
      args.push(opts.sinceIso);
    }
    const sql = `
      SELECT
        play_name,
        SUM(CASE WHEN outcome = 'meeting_booked' THEN 1 ELSE 0 END) AS meetings,
        SUM(CASE WHEN outcome = 'sql_qualified' THEN 1 ELSE 0 END) AS sqls,
        SUM(CASE WHEN outcome = 'deal_won' THEN 1 ELSE 0 END) AS won,
        SUM(CASE WHEN outcome = 'deal_lost' THEN 1 ELSE 0 END) AS lost,
        SUM(CASE WHEN outcome = 'ghosted' THEN 1 ELSE 0 END) AS ghosted
      FROM deal_outcomes
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY play_name
      ORDER BY play_name ASC NULLS LAST
    `;
    return this.db.query(sql).all(...(args as never[])) as never;
  }

  listColdProspects(opts: {
    minDaysSinceLastEvent: number;
    maxDaysSinceLastEvent: number;
    limit?: number;
  }): Array<{
    id: number;
    name: string | null;
    email: string | null;
    company: string | null;
    linkedin_url: string | null;
    phone: string | null;
    last_event_at: string | null;
  }> {
    const sql = `
      SELECT p.id, p.name, p.email, p.company, p.linkedin_url, p.phone, MAX(s.created_at) AS last_event_at
      FROM prospects p
      LEFT JOIN sequence_events s ON s.prospect_id = p.id
      GROUP BY p.id
      HAVING last_event_at IS NOT NULL
        AND julianday('now') - julianday(last_event_at) BETWEEN ? AND ?
      ORDER BY last_event_at ASC
      LIMIT ?
    `;
    return this.db
      .query(sql)
      .all(opts.minDaysSinceLastEvent, opts.maxDaysSinceLastEvent, opts.limit ?? 50) as never;
  }

  recordSequenceEvent(input: {
    prospectId: number;
    playName: string;
    stepIndex: number;
    channel: SequenceEventRecord["channel"];
    status: SequenceEventRecord["status"];
    metadata?: unknown;
    /** The send receipt this step produced — links the step to its billable call
     *  so an outcome (reply/deal) can tag the receipt's value. */
    receiptId?: number;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO sequence_events(prospect_id, play_name, step_index, channel, status, metadata_json, receipt_id)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.prospectId,
      input.playName,
      input.stepIndex,
      input.channel,
      input.status,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.receiptId ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  /** Persist the RoCS value tag (JSON `{type,amount?,label?}`) on a single receipt. */
  setReceiptValueTag(receiptId: number, valueTagJson: string): void {
    this.db
      .prepare(`UPDATE receipts SET value_tag = ?, value_tagged_at = datetime('now') WHERE id = ?`)
      .run(valueTagJson, receiptId);
  }

  /**
   * Local mirror of a goal-level value tag: stamp every receipt in the cadence
   * (matching `goal_id`) so the /receipts UI shows the value per row. Returns the
   * number of receipts touched. The platform records the value once per goal via
   * `tagReceiptValue({goalId})`; this just keeps the dashboard in sync.
   */
  setReceiptValueTagByGoal(goalId: string, valueTagJson: string): number {
    const res = this.db
      .prepare(
        `UPDATE receipts SET value_tag = ?, value_tagged_at = datetime('now') WHERE goal_id = ?`,
      )
      .run(valueTagJson, goalId);
    return res.changes;
  }

  /** Current local value tag for a goal (any one of its receipts), or null. */
  currentGoalValueTag(goalId: string): string | null {
    const row = this.db
      .query(`SELECT value_tag FROM receipts WHERE goal_id = ? AND value_tag IS NOT NULL LIMIT 1`)
      .get(goalId) as { value_tag: string } | undefined;
    return row?.value_tag ?? null;
  }

  /**
   * Human labels (play + prospect) for a set of goalIds, derived from the local
   * receipts so the Measure page can render OneShot's opaque goal_id rollups as
   * "{play} → {prospect}". First receipt per goal wins.
   */
  goalLabels(goalIds: string[]): Map<string, { playName: string | null; prospect: string | null }> {
    const out = new Map<string, { playName: string | null; prospect: string | null }>();
    if (goalIds.length === 0) return out;
    const placeholders = goalIds.map(() => "?").join(",");
    const rows = this.db
      .query(
        `SELECT goal_id, play_name, decision_context FROM receipts WHERE goal_id IN (${placeholders})`,
      )
      .all(...goalIds) as Array<{
      goal_id: string;
      play_name: string;
      decision_context: string | null;
    }>;
    for (const r of rows) {
      if (out.has(r.goal_id)) continue;
      let prospect: string | null = null;
      if (r.decision_context) {
        try {
          const dc = JSON.parse(r.decision_context) as {
            prospectEmail?: string;
            customerName?: string;
          };
          prospect = dc.prospectEmail ?? dc.customerName ?? null;
        } catch {
          prospect = null;
        }
      }
      out.set(r.goal_id, { playName: r.play_name, prospect });
    }
    return out;
  }

  /**
   * True when a (prospect, play, step) already has a terminal-sent
   * sequence_event. Pre-dispatch guard: a crash between recordSequenceEvent
   * and advanceCadence leaves current_step lagging the sent step — this stops
   * the re-send on the next due tick.
   */
  hasSentSequenceEvent(prospectId: number, playName: string, stepIndex: number): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM sequence_events
           WHERE prospect_id = ? AND play_name = ? AND step_index = ?
             AND status IN ('sent','delivered','replied')
           LIMIT 1`,
        )
        .get(prospectId, playName, stepIndex) != null
    );
  }

  /**
   * Mark the latest sent step `replied` — a state transition of the existing
   * step, NOT a new event, so `sent` counts stay correct. Idempotent per
   * (prospect, play) via the NOT EXISTS guard; returns true on the one call
   * that flips a row.
   */
  markLatestStepReplied(input: { prospectId: number; playName: string }): boolean {
    const result = this.db
      .prepare(
        `UPDATE sequence_events SET status = 'replied'
         WHERE id = (
           SELECT id FROM sequence_events
           WHERE prospect_id = ? AND play_name = ? AND channel = 'email'
             AND status IN ('sent','delivered')
           ORDER BY created_at DESC, id DESC LIMIT 1
         )
         AND NOT EXISTS (
           SELECT 1 FROM sequence_events
           WHERE prospect_id = ? AND play_name = ? AND status = 'replied'
         )`,
      )
      .run(input.prospectId, input.playName, input.prospectId, input.playName);
    return result.changes > 0;
  }

  /**
   * Single source of truth for "a prospect replied to a cadence" — writes both
   * planes in one transaction so they can't drift. Control plane
   * (`cadence_state.status='replied'`) is conservative: only a live cadence
   * (`active`/`paused`) flips, so a terminal sequence is never resurrected.
   * Analytics plane (sequence_events) is unconditional: the event is recorded
   * for ANY status — gating the two together silently drops replies that
   * arrive after a sequence finishes. Count replies on `eventRecorded` (true
   * exactly once per (prospect, play)); `newlyReplied` marks the control
   * transition.
   */
  recordCadenceReply(input: { prospectId: number; playName: string }): {
    newlyReplied: boolean;
    eventRecorded: boolean;
  } {
    return this.db.transaction(() => {
      const cad = this.getCadence(input.prospectId, input.playName);
      const newlyReplied = cad?.status === "active" || cad?.status === "paused";
      if (newlyReplied) {
        this.setCadenceStatus({
          prospectId: input.prospectId,
          playName: input.playName,
          status: "replied",
        });
      }
      const eventRecorded = this.markLatestStepReplied({
        prospectId: input.prospectId,
        playName: input.playName,
      });
      return { newlyReplied, eventRecorded };
    })();
  }

  /**
   * Record a reply. Control: EVERY live cadence for the prospect stops —
   * nobody keeps getting follow-ups after answering. Analytics: the reply is
   * credited to exactly ONE play — the one whose sent subject it threads on
   * (`Re: …`), else the most recent play that emailed them. Returns one entry
   * per play touched.
   */
  recordProspectReply(
    prospectId: number,
    opts?: { subject?: string | null },
  ): Array<{ playName: string; newlyReplied: boolean; eventRecorded: boolean }> {
    return this.db.transaction(() => {
      const credited = this.latestSentPlayForProspect(prospectId, opts?.subject);
      const out = new Map<string, { newlyReplied: boolean; eventRecorded: boolean }>();
      for (const cad of this.listCadencesForProspect(prospectId)) {
        const live = cad.status === "active" || cad.status === "paused";
        if (live) {
          this.setCadenceStatus({ prospectId, playName: cad.play_name, status: "replied" });
        }
        out.set(cad.play_name, { newlyReplied: live, eventRecorded: false });
      }
      if (credited) {
        const eventRecorded = this.markLatestStepReplied({ prospectId, playName: credited });
        out.set(credited, {
          newlyReplied: out.get(credited)?.newlyReplied ?? false,
          eventRecorded,
        });
      }
      return [...out].map(([playName, r]) => ({
        playName,
        newlyReplied: r.newlyReplied,
        eventRecorded: r.eventRecorded,
      }));
    })();
  }

  /**
   * Which play an EMAIL reply belongs to. With a subject, the sent email whose
   * subject it threads on wins (reply prefixes in a few languages stripped, case
   * and whitespace ignored); otherwise, or when nothing matches, the prospect's
   * most recent sent email. Other channels (sms/voice/linkedin) are never
   * credited with an email reply. Null if never emailed.
   */
  latestSentPlayForProspect(prospectId: number, replySubject?: string | null): string | null {
    const wanted = normalizeSubject(replySubject);
    if (wanted) {
      const rows = this.db
        .query(
          `SELECT play_name, json_extract(metadata_json, '$.subject') AS subject
           FROM sequence_events
           WHERE prospect_id = ? AND channel = 'email'
             AND status IN ('sent','delivered','replied')
             AND json_extract(metadata_json, '$.subject') IS NOT NULL
           ORDER BY created_at DESC, id DESC`,
        )
        .all(prospectId) as Array<{ play_name: string; subject: string }>;
      const hit = rows.find((r) => normalizeSubject(r.subject) === wanted);
      if (hit) return hit.play_name;
    }
    const row = this.db
      .query(
        `SELECT play_name FROM sequence_events
         WHERE prospect_id = ? AND channel = 'email'
           AND status IN ('sent','delivered','replied')
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(prospectId) as { play_name: string } | null;
    return row?.play_name ?? null;
  }

  getPollWatermark(key: string): string | null {
    const row = this.db.query(`SELECT value FROM poll_state WHERE key = ?`).get(key) as {
      value: string;
    } | null;
    return row?.value ?? null;
  }

  setPollWatermark(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO poll_state(key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value);
  }

  listSequenceEventsForProspectPlay(prospectId: number, playName: string): SequenceEventRecord[] {
    return this.db
      .query(
        `SELECT * FROM sequence_events
         WHERE prospect_id = ? AND play_name = ?
           AND status IN ('sent','delivered','replied')
         ORDER BY step_index ASC, id ASC`,
      )
      .all(prospectId, playName) as SequenceEventRecord[];
  }

  /** Every sent step for a prospect across ALL plays — the outreach half of a conversation timeline. */
  listSequenceEventsForProspect(prospectId: number): SequenceEventRecord[] {
    return this.db
      .query(
        `SELECT * FROM sequence_events
         WHERE prospect_id = ?
           AND status IN ('sent','delivered','replied')
         ORDER BY created_at ASC, id ASC`,
      )
      .all(prospectId) as SequenceEventRecord[];
  }

  /**
   * Bulk variant of listSequenceEventsForProspectPlay: one round-trip, Map
   * keyed `${prospect_id}|${play_name}`, same (step_index ASC, id ASC)
   * ordering. Index-served by idx_sequence_events_prospect_play.
   */
  listSequenceEventsForCadences(
    pairs: ReadonlyArray<{ prospectId: number; playName: string }>,
  ): Map<string, SequenceEventRecord[]> {
    const map = new Map<string, SequenceEventRecord[]>();
    if (pairs.length === 0) return map;
    const conditions = pairs.map(() => "(prospect_id = ? AND play_name = ?)").join(" OR ");
    const args: unknown[] = [];
    for (const p of pairs) {
      args.push(p.prospectId, p.playName);
    }
    const rows = this.db
      .query(
        `SELECT * FROM sequence_events
         WHERE (${conditions})
           AND status IN ('sent','delivered','replied')
         ORDER BY prospect_id ASC, play_name ASC, step_index ASC, id ASC`,
      )
      .all(...(args as never[])) as SequenceEventRecord[];
    for (const r of rows) {
      const key = `${r.prospect_id}|${r.play_name}`;
      let list = map.get(key);
      if (!list) {
        list = [];
        map.set(key, list);
      }
      list.push(r);
    }
    return map;
  }

  recordInterview(input: Omit<InterviewRecord, "id" | "created_at">): number {
    const stmt = this.db.prepare(`
      INSERT INTO interviews(person, transcript_path, jtbd, pain_quotes_json)
      VALUES(?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.person,
      input.transcript_path,
      input.jtbd,
      input.pain_quotes_json,
    );
    return Number(result.lastInsertRowid);
  }

  countSends(opts: { playName?: string } = {}): number {
    const sql = opts.playName
      ? "SELECT COUNT(*) AS n FROM sequence_events WHERE play_name = ? AND status IN ('sent', 'delivered', 'replied')"
      : "SELECT COUNT(*) AS n FROM sequence_events WHERE status IN ('sent', 'delivered', 'replied')";
    const args = opts.playName ? [opts.playName] : [];
    return (this.db.query(sql).get(...(args as never[])) as { n: number } | null)?.n ?? 0;
  }

  spendByPlay(
    opts: { sinceIso?: string } = {},
  ): Array<{ play_name: string; calls: number; total_usd: number }> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.sinceIso) {
      where.push("created_at >= ?");
      args.push(opts.sinceIso);
    }
    const sql = `
      SELECT play_name, COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS total_usd
      FROM receipts
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY play_name
      ORDER BY total_usd DESC, calls DESC
    `;
    return this.db.query(sql).all(...(args as never[])) as Array<{
      play_name: string;
      calls: number;
      total_usd: number;
    }>;
  }

  eventsByPlay(opts: { sinceIso?: string } = {}): Array<{
    play_name: string;
    sent: number;
    delivered: number;
    replied: number;
    bounced: number;
  }> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.sinceIso) {
      where.push("created_at >= ?");
      args.push(opts.sinceIso);
    }
    const sql = `
      SELECT
        play_name,
        SUM(CASE WHEN status IN ('sent', 'delivered', 'replied') THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN status IN ('delivered', 'replied') THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) AS replied,
        SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) AS bounced
      FROM sequence_events
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY play_name
    `;
    return this.db.query(sql).all(...(args as never[])) as Array<{
      play_name: string;
      sent: number;
      delivered: number;
      replied: number;
      bounced: number;
    }>;
  }

  totalSpendUsd(opts: { sinceIso?: string; playName?: string } = {}): number {
    const where: string[] = ["cost_usd IS NOT NULL"];
    const args: unknown[] = [];
    if (opts.playName) {
      where.push("play_name = ?");
      args.push(opts.playName);
    }
    if (opts.sinceIso) {
      where.push("created_at >= ?");
      args.push(opts.sinceIso);
    }
    const sql = `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM receipts WHERE ${where.join(" AND ")}`;
    return (this.db.query(sql).get(...(args as never[])) as { total: number } | null)?.total ?? 0;
  }

  // ── target_queue ────────────────────────────────────────────────────────────

  /** Recent reviewed rows for few-shot ICP classification. */
  recentIcpDecisions(limit = 20): IcpDecisionExample[] {
    const rows = this.db
      .query(
        `SELECT payload_json, status, notes
         FROM target_queue
         WHERE reviewed_at IS NOT NULL
           AND json_valid(payload_json)
           AND status IN ('approved', 'rejected', 'sent')
           AND NOT (status = 'rejected' AND notes LIKE 'auto:%')
         ORDER BY reviewed_at DESC, id DESC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.floor(limit))) as Array<{
      payload_json: string;
      status: "approved" | "rejected" | "sent";
      notes: string | null;
    }>;

    return rows.flatMap((row) => {
      try {
        const payload = JSON.parse(row.payload_json) as unknown;
        return [
          {
            // Queue payloads grow as a prospect is enriched and can contain
            // email, phone and social-profile fields. Few-shot topic
            // classification only needs the original public source context.
            candidate: icpExampleCandidate(payload),
            decision: row.status !== "rejected",
            reason: row.notes,
          },
        ];
      } catch {
        return [];
      }
    });
  }

  /**
   * Insert a row into target_queue. Returns the new id, or null if a row with
   * the same (play_name, dedupe_key) already exists.
   */
  enqueueTarget(input: {
    playName: string;
    payload: unknown;
    dedupeKey: string;
    source: string;
    notes?: string;
    /**
     * Status to insert with. Defaults to "pending" (the normal review path).
     * Pass "rejected" to record an auto-drop (e.g. ICP filter said no) so the
     * founder can see what was filtered out and override if needed.
     */
    initialStatus?: QueueStatus;
  }): number | null {
    try {
      const status = input.initialStatus ?? "pending";
      const reviewedAt = status === "pending" ? null : new Date().toISOString();
      const result = this.db
        .prepare(
          `INSERT INTO target_queue(play_name, payload_json, dedupe_key, source, status, reviewed_at, notes)
           VALUES(?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.playName,
          JSON.stringify(input.payload),
          input.dedupeKey,
          input.source,
          status,
          reviewedAt,
          input.notes ?? null,
        );
      return Number(result.lastInsertRowid);
    } catch (err) {
      // Unique constraint violation = already queued; return null to signal dedupe.
      const msg = (err as Error).message ?? "";
      if (msg.includes("UNIQUE constraint failed")) return null;
      throw err;
    }
  }

  isQueueDuplicate(playName: string, dedupeKey: string): boolean {
    const row = this.db
      .query("SELECT 1 FROM target_queue WHERE play_name = ? AND dedupe_key = ?")
      .get(playName, dedupeKey);
    return row !== null && row !== undefined;
  }

  /**
   * Persist a candidate whose paid resolution hit a transient platform error,
   * so the retry pass can complete it later (and re-scan won't re-create it).
   * Idempotent: a re-discovered candidate keeps its original first_seen_at and
   * attempt count (the retry pass owns attempt bookkeeping).
   */
  upsertPendingResolution(input: {
    playName: string;
    dedupeKey: string;
    source: string;
    raw: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO pending_resolution(play_name, dedupe_key, source, raw_json)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(play_name, dedupe_key) DO UPDATE SET
           source = excluded.source,
           raw_json = excluded.raw_json`,
      )
      .run(input.playName, input.dedupeKey, input.source, JSON.stringify(input.raw));
  }

  /** True when (play, dedupeKey) is awaiting retry — finders OR this into their dedup. */
  isPendingResolution(playName: string, dedupeKey: string): boolean {
    const row = this.db
      .query("SELECT 1 FROM pending_resolution WHERE play_name = ? AND dedupe_key = ?")
      .get(playName, dedupeKey);
    return row !== null && row !== undefined;
  }

  /** Pending rows (optionally one play), oldest first, for the retry pass. */
  listPendingResolution(opts?: { playName?: string; limit?: number }): Array<{
    play_name: string;
    dedupe_key: string;
    source: string;
    raw_json: string;
    first_seen_at: string;
    last_attempt_at: string | null;
    attempts: number;
  }> {
    const where = opts?.playName ? "WHERE play_name = ?" : "";
    const limit = opts?.limit ? `LIMIT ${Math.max(1, Math.floor(opts.limit))}` : "";
    const sql = `SELECT * FROM pending_resolution ${where} ORDER BY first_seen_at ASC ${limit}`;
    const q = this.db.query(sql);
    return (opts?.playName ? q.all(opts.playName) : q.all()) as never;
  }

  /** Mark a pending row as just-attempted (bumps attempts + last_attempt_at). */
  markPendingResolutionAttempted(playName: string, dedupeKey: string): void {
    this.db
      .prepare(
        `UPDATE pending_resolution
         SET attempts = attempts + 1, last_attempt_at = datetime('now')
         WHERE play_name = ? AND dedupe_key = ?`,
      )
      .run(playName, dedupeKey);
  }

  deletePendingResolution(playName: string, dedupeKey: string): void {
    this.db
      .prepare("DELETE FROM pending_resolution WHERE play_name = ? AND dedupe_key = ?")
      .run(playName, dedupeKey);
  }

  /**
   * Purge pending rows older than maxAgeMs (permanently-unresolvable or an
   * aged-out time-windowed source) so their dedupe_key frees for future
   * re-discovery and the table doesn't silt. Returns the number removed.
   */
  sweepStalePendingResolution(maxAgeMs: number): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const res = this.db
      .prepare("DELETE FROM pending_resolution WHERE first_seen_at < ?")
      .run(cutoff);
    return Number(res.changes ?? 0);
  }

  /** Tweet ids the x-reposters finder paid for since `cutoffIso` — skipped on the next harvest. */
  recentXHarvestedTweetIds(cutoffIso: string): Set<string> {
    const rows = this.db
      .query("SELECT tweet_id FROM x_harvested_tweets WHERE harvested_at >= ?")
      .all(cutoffIso) as Array<{ tweet_id: string }>;
    return new Set(rows.map((r) => r.tweet_id));
  }

  /**
   * Record tweets just paid for and prune rows past the skip window in one
   * transaction, so the table can't silt. Re-recording an id refreshes its
   * timestamp (a re-buy inside the freshness window restarts its clock).
   */
  recordXHarvestedTweets(ids: string[], nowIso: string, pruneCutoffIso: string): void {
    const insert = this.db.prepare(
      `INSERT INTO x_harvested_tweets(tweet_id, harvested_at) VALUES(?, ?)
       ON CONFLICT(tweet_id) DO UPDATE SET harvested_at = excluded.harvested_at`,
    );
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM x_harvested_tweets WHERE harvested_at < ?").run(pruneCutoffIso);
      for (const id of ids) insert.run(id, nowIso);
    });
    tx();
  }

  /**
   * Cross-play dedup (finder side): is this email in a non-terminal queue row
   * under ANY play? Catches the window before either play has sent (no
   * prospect row exists yet). Matches both `email` and `founderEmail`.
   */
  isEmailPendingInQueue(email: string): boolean {
    // Case-insensitive to match findProspectByEmail/upsertProspect, which store
    // and look up the canonical (lowercased) email — otherwise a casing mismatch
    // between two finders would slip a dup through. LOWER() on the JSON side,
    // canonEmail() on the arg.
    const row = this.db
      .query(
        `SELECT 1 FROM target_queue
         WHERE status IN ('pending','approved')
           AND (LOWER(json_extract(payload_json, '$.email')) = ?1
                OR LOWER(json_extract(payload_json, '$.founderEmail')) = ?1)
         LIMIT 1`,
      )
      .get(canonEmail(email));
    return row !== null && row !== undefined;
  }

  /**
   * Cross-play dedup (send side): has this prospect already received an initial
   * (step-0) touch under ANY play? The authoritative guard against first-touching
   * the same person twice. Mirrors the step-0 existence check in
   * sweepStaleCadenceSends. Note: deliberate re-engagement (breakup-revive)
   * bypasses this via sendDraftedEmail's `allowRecontact`.
   */
  prospectHasFirstTouch(prospectId: number): boolean {
    const row = this.db
      .query(
        `SELECT 1 FROM sequence_events
         WHERE prospect_id = ? AND step_index = 0
           AND status IN ('sent','delivered','replied')
         LIMIT 1`,
      )
      .get(prospectId);
    return row !== null && row !== undefined;
  }

  /**
   * Look up a queue row by its (play_name, dedupe_key) — the unique pair.
   * Used by the SSE /run endpoint to map drafts back to the originating
   * row so we can persist `last_draft_json`. Returns null when absent.
   */
  getQueueRowByDedupe(playName: string, dedupeKey: string): QueueRow | null {
    return (
      (this.db
        .query("SELECT * FROM target_queue WHERE play_name = ? AND dedupe_key = ?")
        .get(playName, dedupeKey) as QueueRow) ?? null
    );
  }

  listQueue(
    opts: { playName?: string; status?: QueueStatus; limit?: number; ids?: number[] } = {},
  ): QueueRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.playName) {
      where.push("play_name = ?");
      args.push(opts.playName);
    }
    if (opts.status) {
      where.push("status = ?");
      args.push(opts.status);
    }
    // Explicit row picks (the /queue "drain selected" path). An empty array
    // would compile to `IN ()` — a syntax error in SQLite — and semantically
    // means "nothing selected", so return early rather than silently listing
    // every row.
    if (opts.ids) {
      if (opts.ids.length === 0) return [];
      where.push(`id IN (${opts.ids.map(() => "?").join(",")})`);
      args.push(...opts.ids);
    }
    const sql = `
      SELECT * FROM target_queue
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY found_at DESC
      LIMIT ?
    `;
    args.push(opts.limit ?? 200);
    return this.db.query(sql).all(...(args as never[])) as QueueRow[];
  }

  getQueueRow(id: number): QueueRow | null {
    return (this.db.query("SELECT * FROM target_queue WHERE id = ?").get(id) as QueueRow) ?? null;
  }

  /** Remove an unreviewed queue reservation, leaving reviewed rows untouched. */
  removePendingQueueTarget(id: number): boolean {
    const result = this.db
      .prepare("DELETE FROM target_queue WHERE id = ? AND status = 'pending'")
      .run(id);
    return result.changes > 0;
  }

  setQueueStatus(input: { id: number; status: QueueStatus; notes?: string }): void {
    const now = new Date().toISOString();
    // Every status transition clears `send_started_at` — a deliberate status
    // change means the previous "sending" attempt (if any) is settled. Terminal
    // states (sent/rejected/expired) clear naturally. Approved → approved
    // doesn't need to preserve a marker (caller re-claims on the next send).
    if (input.status === "sent") {
      this.db
        .prepare(
          `UPDATE target_queue SET status = ?, sent_at = ?, reviewed_at = COALESCE(reviewed_at, ?), send_started_at = NULL ${input.notes ? ", notes = ?" : ""} WHERE id = ?`,
        )
        .run(
          ...(input.notes
            ? [input.status, now, now, input.notes, input.id]
            : [input.status, now, now, input.id]),
        );
    } else if (input.status === "approved" || input.status === "rejected") {
      this.db
        .prepare(
          `UPDATE target_queue SET status = ?, reviewed_at = ?, send_started_at = NULL ${input.notes ? ", notes = ?" : ""} WHERE id = ?`,
        )
        .run(
          ...(input.notes
            ? [input.status, now, input.notes, input.id]
            : [input.status, now, input.id]),
        );
    } else if (input.status === "pending") {
      this.db
        .prepare(
          `UPDATE target_queue SET status = ?, reviewed_at = NULL, send_started_at = NULL ${input.notes !== undefined ? ", notes = ?" : ""} WHERE id = ?`,
        )
        .run(
          ...(input.notes !== undefined
            ? [input.status, input.notes, input.id]
            : [input.status, input.id]),
        );
    } else {
      this.db
        .prepare(`UPDATE target_queue SET status = ?, send_started_at = NULL WHERE id = ?`)
        .run(input.status, input.id);
    }
  }

  /**
   * Atomic claim of the queue-send marker on `target_queue.send_started_at`.
   * Mirrors `claimCadenceSendingMarker` semantics — survives server restart so
   * `/queue` Send-draft UI doesn't lose its spinner on `bun --watch` reloads.
   * Cleared on success via `setQueueStatus('sent', …)`, on failure via
   * `clearQueueSendingMarker`, on cold boot via `sweepStaleQueueSends`.
   */
  claimQueueSendingMarker(input: {
    id: number;
    startedAtIso: string;
    staleCutoffIso?: string;
  }): boolean {
    return this.claimMarker({
      table: "target_queue",
      pkeyWhere: "id = ?",
      column: "send_started_at",
      pkeyValues: [input.id],
      startedAtIso: input.startedAtIso,
      ...(input.staleCutoffIso ? { staleCutoffIso: input.staleCutoffIso } : {}),
    });
  }

  clearQueueSendingMarker(id: number): void {
    this.clearMarker({
      table: "target_queue",
      pkeyWhere: "id = ?",
      column: "send_started_at",
      pkeyValues: [id],
    });
  }

  /**
   * Sweep queue rows whose `send_started_at` is older than `maxAgeMs` (or any
   * non-null when 0 — cold-boot semantics). For each: classify by current
   * status. status='sent' means the SDK call landed before the kill (clear
   * the marker only); otherwise the send was stranded (clear the marker,
   * draft is still on the row for retry).
   */
  sweepStaleQueueSends(input: { now: Date; maxAgeMs: number }): Array<{
    id: number;
    startedAt: string;
    ageMs: number;
    actuallySent: boolean;
  }> {
    const cutoffMs = input.now.getTime() - input.maxAgeMs;
    const rows = this.db
      .query(
        `SELECT id, status, send_started_at FROM target_queue WHERE send_started_at IS NOT NULL`,
      )
      .all() as Array<{ id: number; status: string; send_started_at: string }>;
    const swept: Array<{
      id: number;
      startedAt: string;
      ageMs: number;
      actuallySent: boolean;
    }> = [];
    const clear = this.db.prepare(`UPDATE target_queue SET send_started_at = NULL WHERE id = ?`);
    for (const row of rows) {
      const startedMs = new Date(row.send_started_at).getTime();
      if (Number.isFinite(startedMs) && startedMs > cutoffMs) continue;
      const ageMs = Number.isFinite(startedMs) ? input.now.getTime() - startedMs : -1;
      clear.run(row.id);
      swept.push({
        id: row.id,
        startedAt: row.send_started_at,
        ageMs,
        actuallySent: row.status === "sent",
      });
    }
    return swept;
  }

  approveAllPending(opts: { playName?: string } = {}): number {
    const where: string[] = ["status = 'pending'"];
    const args: unknown[] = [];
    if (opts.playName) {
      where.push("play_name = ?");
      args.push(opts.playName);
    }
    const result = this.db
      .prepare(
        `UPDATE target_queue SET status = 'approved', reviewed_at = ? WHERE ${where.join(" AND ")}`,
      )
      .run(...([new Date().toISOString(), ...args] as never[]));
    return Number(result.changes);
  }

  /**
   * Atomic claim-and-return: SELECT + `drain_claimed_at` UPDATE in one
   * transaction so concurrent drains can't overlap. 15-min lease self-heals a
   * crashed drain; held/error rows back off for the lease duration.
   */
  dequeueApproved(opts: { playName: string; limit?: number; leaseSeconds?: number }): QueueRow[] {
    const leaseSeconds = opts.leaseSeconds ?? 900;
    const claimedAt = new Date().toISOString();
    const cutoff = new Date(Date.now() - leaseSeconds * 1000).toISOString();
    const limit = opts.limit ?? 50;
    const txn = this.db.transaction((): QueueRow[] => {
      const rows = this.db
        .query(
          `SELECT * FROM target_queue
           WHERE play_name = ? AND status = 'approved'
             AND (drain_claimed_at IS NULL OR drain_claimed_at < ?)
           ORDER BY found_at ASC
           LIMIT ?`,
        )
        .all(opts.playName, cutoff, limit) as QueueRow[];
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      this.db
        .prepare(`UPDATE target_queue SET drain_claimed_at = ? WHERE id IN (${placeholders})`)
        .run(...([claimedAt, ...ids] as never[]));
      return rows;
    });
    // BEGIN IMMEDIATE takes a RESERVED lock at the start of the transaction
    // instead of the default DEFERRED (which only locks on the first write).
    // In WAL mode with two processes, DEFERRED lets both transactions pass
    // the SELECT before either holds the write lock, then the second UPDATE
    // silently overwrites the first's claim — both drains would consider the
    // rows theirs. IMMEDIATE serializes the whole thing across connections.
    return txn.immediate();
  }

  expirePendingOlderThan(days: number): number {
    const sinceIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    const result = this.db
      .prepare(
        `UPDATE target_queue SET status = 'expired' WHERE status = 'pending' AND found_at < ?`,
      )
      .run(sinceIso);
    return Number(result.changes);
  }

  queueCounts(): Record<QueueStatus, number> {
    const rows = this.db
      .query("SELECT status, COUNT(*) AS n FROM target_queue GROUP BY status")
      .all() as Array<{ status: QueueStatus; n: number }>;
    const out: Record<QueueStatus, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
      sent: 0,
      expired: 0,
    };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  /**
   * Approved-row count per play, across the whole queue. Deliberately ignores
   * any status/play filter the caller is showing: /queue's drain button needs
   * to know a play has drainable rows even when the visible page is filtered
   * to `pending`. Plays with zero approved rows are absent from the map.
   */
  approvedCountsByPlay(): Record<string, number> {
    const rows = this.db
      .query(
        "SELECT play_name, COUNT(*) AS n FROM target_queue WHERE status = 'approved' GROUP BY play_name",
      )
      .all() as Array<{ play_name: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.play_name] = r.n;
    return out;
  }

  /** Reviewed queue outcomes for one finder inside a trailing time window. */
  finderApprovalStats(input: { finder: string; sinceIso: string }): {
    approved: number;
    reviewed: number;
    rate: number | null;
  } {
    // post-funding-auto predates the registry name and writes find:post-funding.
    const sourceName = input.finder === "post-funding-auto" ? "post-funding" : input.finder;
    const source = `find:${sourceName}`;
    const row = this.db
      .query(
        `SELECT
           SUM(CASE WHEN status IN ('approved','sent') THEN 1 ELSE 0 END) AS approved,
           COUNT(*) AS reviewed
         FROM target_queue
         WHERE (source = ? OR source LIKE ?)
           AND status IN ('approved','rejected','sent')
           AND reviewed_at >= ?`,
      )
      .get(source, `${source}:%`, input.sinceIso) as {
      approved: number | null;
      reviewed: number;
    };
    const approved = row.approved ?? 0;
    const reviewed = row.reviewed ?? 0;
    return { approved, reviewed, rate: reviewed > 0 ? approved / reviewed : null };
  }

  // ── runs (per-/run-page dispatch records) ──────────────────────────────────
  // One row per /run Execute click; the SSE endpoint persists events/counters,
  // the UI rebuilds progress from the row, and the cold-boot sweep flips
  // stranded `running` rows to `interrupted`.

  createRun(input: {
    playName: string;
    dryRun: boolean;
    targets: unknown[];
    dedupeKeys?: Array<string | null>;
  }): {
    runId: number;
    startedAt: string;
  } {
    const startedAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO runs(play_name, dry_run, status, started_at, target_count, targets_json, dedupe_keys_json)
         VALUES(?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(
        input.playName,
        input.dryRun ? 1 : 0,
        startedAt,
        input.targets.length,
        JSON.stringify(input.targets),
        JSON.stringify(input.dedupeKeys ?? []),
      );
    return { runId: Number(result.lastInsertRowid), startedAt };
  }

  /**
   * Append a single event to a run's events_json and bump the matching
   * counter. Cheap re-serialize is fine — events_json fits in a single row;
   * runs are bounded at ~25 targets typically.
   */
  appendRunEvent(input: { runId: number; event: unknown }): void {
    const row = this.db
      .query(
        `SELECT events_json, drafted_count, sent_count, error_count
         FROM runs WHERE id = ?`,
      )
      .get(input.runId) as {
      events_json: string;
      drafted_count: number;
      sent_count: number;
      error_count: number;
    } | null;
    if (!row) return;
    let events: unknown[];
    try {
      events = JSON.parse(row.events_json) as unknown[];
      if (!Array.isArray(events)) events = [];
    } catch {
      events = [];
    }
    events.push(input.event);
    // Counter bump driven by event.kind — keeps the writer side simple and
    // the read side stable. Unknown kinds are appended without counter change.
    const kind =
      input.event && typeof input.event === "object"
        ? ((input.event as { kind?: string }).kind ?? null)
        : null;
    let drafted = row.drafted_count;
    let sent = row.sent_count;
    let errors = row.error_count;
    if (kind === "draft") drafted++;
    else if (kind === "send") sent++;
    else if (kind === "error") errors++;
    this.db
      .prepare(
        `UPDATE runs
         SET events_json = ?, drafted_count = ?, sent_count = ?, error_count = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(events), drafted, sent, errors, input.runId);
  }

  /**
   * Terminal write for a run that finished on its own. Cancellation goes
   * through `cancelRun` instead — it is the only writer of 'cancelled', so a
   * cancelled row can never exist without the reason that explains it.
   */
  markRunComplete(input: {
    runId: number;
    status: "done" | "interrupted";
    sentEmails?: string[];
  }): void {
    const completedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE runs
         SET status = ?, completed_at = ?, prospect_emails_json = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(input.status, completedAt, JSON.stringify(input.sentEmails ?? []), input.runId);
  }

  /**
   * Overwrite the run's record of which prospects it actually emailed, in any
   * status. Deliberately not CASed on 'running': a cancelled run's last sends
   * land after the row went terminal (the play's workers finish one by one),
   * and the /cadences?sinceRun deep-link needs them.
   */
  setRunSentEmails(input: { runId: number; sentEmails: string[] }): void {
    this.db
      .prepare(`UPDATE runs SET prospect_emails_json = ? WHERE id = ?`)
      .run(JSON.stringify(input.sentEmails), input.runId);
  }

  /**
   * Flip a still-'running' row to the terminal 'cancelled' state with the
   * reason it ended. CAS on `status = 'running'` so this is a no-op — never an
   * error — against a run that already finished, and so it races safely with
   * the SSE handler's own completion write. `sentEmails` records what did go
   * out before the abort, keeping the /cadences?sinceRun deep-link honest.
   *
   * Returns whether this call was the one that cancelled it, plus the row's
   * status afterwards (null when there is no such run).
   */
  cancelRun(input: { runId: number; reason: string; sentEmails?: string[] }): {
    cancelled: boolean;
    status: "running" | "done" | "interrupted" | "cancelled" | null;
  } {
    // Sent-email bookkeeping is deliberately outside the CAS below: the cancel
    // route may have flipped the row already by the time the SSE handler
    // unwinds, and the emails it collected still belong on the record. Only
    // that handler passes `sentEmails`, so the two callers can't clobber
    // each other whichever order they land in.
    if (input.sentEmails)
      this.setRunSentEmails({ runId: input.runId, sentEmails: input.sentEmails });
    const completedAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE runs
         SET status = 'cancelled', completed_at = ?, cancel_reason = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(completedAt, input.reason, input.runId);
    const row = this.db.query(`SELECT status FROM runs WHERE id = ?`).get(input.runId) as {
      status: "running" | "done" | "interrupted" | "cancelled";
    } | null;
    return { cancelled: result.changes > 0, status: row?.status ?? null };
  }

  getRun(runId: number): {
    id: number;
    playName: string;
    dryRun: boolean;
    status: "running" | "done" | "interrupted" | "cancelled";
    startedAt: string;
    completedAt: string | null;
    targetCount: number;
    draftedCount: number;
    sentCount: number;
    errorCount: number;
    targets: unknown[];
    dedupeKeys: Array<string | null>;
    events: unknown[];
    prospectEmails: string[];
    cancelReason: string | null;
  } | null {
    const row = this.db.query(`SELECT * FROM runs WHERE id = ?`).get(runId) as {
      id: number;
      play_name: string;
      dry_run: number;
      status: "running" | "done" | "interrupted" | "cancelled";
      started_at: string;
      completed_at: string | null;
      target_count: number;
      drafted_count: number;
      sent_count: number;
      error_count: number;
      targets_json: string;
      dedupe_keys_json: string;
      events_json: string;
      prospect_emails_json: string;
      cancel_reason: string | null;
    } | null;
    if (!row) return null;
    return {
      id: row.id,
      playName: row.play_name,
      dryRun: row.dry_run === 1,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      targetCount: row.target_count,
      draftedCount: row.drafted_count,
      sentCount: row.sent_count,
      errorCount: row.error_count,
      targets: safeParseJsonArray(row.targets_json),
      dedupeKeys: safeParseJsonArray(row.dedupe_keys_json) as Array<string | null>,
      events: safeParseJsonArray(row.events_json),
      prospectEmails: safeParseJsonArray(row.prospect_emails_json) as string[],
      cancelReason: row.cancel_reason ?? null,
    };
  }

  /**
   * Compact run listing for dashboards. Returns lightweight columns only —
   * `events_json` + `targets_json` stay on the row but aren't read here so
   * `/api/home` doesn't pay to ship them on every 30s poll. Default order:
   * newest started_at first; capped at `limit` rows (default 5). When
   * `status` is set, filters via the existing `idx_runs_status` index.
   */
  listRuns(
    opts: { status?: "running" | "done" | "interrupted" | "cancelled"; limit?: number } = {},
  ): Array<{
    id: number;
    playName: string;
    status: "running" | "done" | "interrupted" | "cancelled";
    startedAt: string;
    completedAt: string | null;
    targetCount: number;
    draftedCount: number;
    sentCount: number;
    errorCount: number;
  }> {
    const limit = Math.max(1, Math.min(50, opts.limit ?? 5));
    const where = opts.status ? "WHERE status = ?" : "";
    const args = opts.status ? [opts.status, limit] : [limit];
    const rows = this.db
      .query(
        `SELECT id, play_name, status, started_at, completed_at,
                target_count, drafted_count, sent_count, error_count
         FROM runs
         ${where}
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(...(args as never[])) as Array<{
      id: number;
      play_name: string;
      status: "running" | "done" | "interrupted" | "cancelled";
      started_at: string;
      completed_at: string | null;
      target_count: number;
      drafted_count: number;
      sent_count: number;
      error_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      playName: r.play_name,
      status: r.status,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      targetCount: r.target_count,
      draftedCount: r.drafted_count,
      sentCount: r.sent_count,
      errorCount: r.error_count,
    }));
  }

  /**
   * Sweep run rows whose status is still 'running' but predate the cutoff
   * (or any non-null when 0 — cold-boot semantics). Marks them as
   * 'interrupted' so the UI shows a truthful banner instead of an eternal
   * spinner. Returns the swept rows so the caller can log them.
   *
   * Terminal rows — including 'cancelled' — are never touched: a run the user
   * cancelled must not be relabelled as a crash by the next cold boot.
   */
  sweepStaleRuns(input: { now: Date; maxAgeMs: number }): Array<{
    id: number;
    playName: string;
    startedAt: string;
    ageMs: number;
  }> {
    const cutoffMs = input.now.getTime() - input.maxAgeMs;
    const rows = this.db
      .query(`SELECT id, play_name, started_at FROM runs WHERE status = 'running'`)
      .all() as Array<{ id: number; play_name: string; started_at: string }>;
    const swept: Array<{
      id: number;
      playName: string;
      startedAt: string;
      ageMs: number;
    }> = [];
    const update = this.db.prepare(
      // Re-check the status in the write: it closes the window between the
      // SELECT above and here, where a concurrent cancel could land. A row
      // that moved on under us reports 0 changes and stays out of `swept`.
      `UPDATE runs SET status = 'interrupted', completed_at = ? WHERE id = ? AND status = 'running'`,
    );
    for (const row of rows) {
      const startedMs = new Date(row.started_at).getTime();
      if (Number.isFinite(startedMs) && startedMs > cutoffMs) continue;
      const ageMs = Number.isFinite(startedMs) ? input.now.getTime() - startedMs : -1;
      if (update.run(input.now.toISOString(), row.id).changes === 0) continue;
      swept.push({
        id: row.id,
        playName: row.play_name,
        startedAt: row.started_at,
        ageMs,
      });
    }
    return swept;
  }

  // ── triggers (find watch state) ────────────────────────────────────────────

  upsertTrigger(input: { name: string; configJson: string; enabled?: boolean }): void {
    this.db
      .prepare(
        `INSERT INTO triggers(name, enabled, config_json)
         VALUES(?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json`,
      )
      .run(input.name, input.enabled === false ? 0 : 1, input.configJson);
  }

  getTrigger(name: string): TriggerRow | null {
    return (this.db.query("SELECT * FROM triggers WHERE name = ?").get(name) as TriggerRow) ?? null;
  }

  listTriggers(): TriggerRow[] {
    return this.db.query("SELECT * FROM triggers ORDER BY name ASC").all() as TriggerRow[];
  }

  /**
   * Records the result of a finished run AND clears `running_started_at` in
   * the same statement. This is the only "completed" path — both success and
   * caught-finder-throw funnel through here, so clearing the in-flight flag
   * here is the right semantic.
   */
  updateTriggerLastPoll(input: { name: string; summary: unknown }): void {
    this.db
      .prepare(
        `UPDATE triggers
         SET last_polled_at = ?, last_run_summary = ?, running_started_at = NULL
         WHERE name = ?`,
      )
      .run(new Date().toISOString(), JSON.stringify(input.summary), input.name);
  }

  /**
   * Atomic claim: marks a trigger in-flight only if not already running — the
   * conditional UPDATE closes the TOCTOU race where two fireTriggerNow calls
   * both fire and double-spend. `staleCutoffIso` also lets the claim succeed
   * over a stale marker so a dead row doesn't 409 until the next cold boot.
   * Cleared by updateTriggerLastPoll or sweepStaleRunningTriggers.
   */
  markTriggerRunning(name: string, startedAtIso: string, staleCutoffIso?: string): boolean {
    return this.claimMarker({
      table: "triggers",
      pkeyWhere: "name = ?",
      column: "running_started_at",
      pkeyValues: [name],
      startedAtIso,
      ...(staleCutoffIso ? { staleCutoffIso } : {}),
    });
  }

  /**
   * Sweep stale `running_started_at` rows: write `{error:"killed_by_restart"}`
   * and clear the in-flight flag; returns swept rows. Takes `now` + `maxAgeMs`
   * as args so tests don't fake the clock.
   */
  sweepStaleRunningTriggers(input: {
    now: Date;
    maxAgeMs: number;
  }): Array<{ name: string; startedAt: string; ageMs: number }> {
    const cutoffMs = input.now.getTime() - input.maxAgeMs;
    const rows = this.db
      .query(`SELECT name, running_started_at FROM triggers WHERE running_started_at IS NOT NULL`)
      .all() as Array<{ name: string; running_started_at: string }>;
    const swept: Array<{ name: string; startedAt: string; ageMs: number }> = [];
    const update = this.db.prepare(
      `UPDATE triggers
       SET last_polled_at = ?, last_run_summary = ?, running_started_at = NULL
       WHERE name = ?`,
    );
    for (const row of rows) {
      const startedMs = new Date(row.running_started_at).getTime();
      if (!Number.isFinite(startedMs)) {
        // Garbage timestamp — clear it so it doesn't perpetually re-trip.
        update.run(
          input.now.toISOString(),
          JSON.stringify({
            error: "killed_by_restart",
            reason: "running_started_at unparseable",
            at: input.now.toISOString(),
          }),
          row.name,
        );
        continue;
      }
      if (startedMs > cutoffMs) continue; // still fresh
      const ageMs = input.now.getTime() - startedMs;
      update.run(
        input.now.toISOString(),
        JSON.stringify({
          error: "killed_by_restart",
          startedAt: row.running_started_at,
          ageMs,
          at: input.now.toISOString(),
        }),
        row.name,
      );
      swept.push({ name: row.name, startedAt: row.running_started_at, ageMs });
    }
    return swept;
  }

  setTriggerEnabled(name: string, enabled: boolean): void {
    this.db.prepare(`UPDATE triggers SET enabled = ? WHERE name = ?`).run(enabled ? 1 : 0, name);
  }

  setTriggerConfig(name: string, configJson: string): void {
    this.db.prepare(`UPDATE triggers SET config_json = ? WHERE name = ?`).run(configJson, name);
  }

  /**
   * Associate a queued target with a known prospect (so the queue page can
   * link back to the prospect record). Best-effort — the caller is expected
   * to swallow failures since the link is a convenience, not a correctness
   * invariant.
   */
  setQueueProspectId(id: number, prospectId: number): void {
    this.db.prepare(`UPDATE target_queue SET prospect_id = ? WHERE id = ?`).run(prospectId, id);
  }

  /**
   * Persist the most-recent draft for this queue row (the /run page is
   * ephemeral; /queue reviews from here). Most-recent-wins — re-runs
   * overwrite without history.
   */
  setQueueDraft(input: {
    id: number;
    draft: {
      subject: string;
      body: string;
      flags: string[];
      sent: boolean;
      receiptIds: number[];
      dryRun: boolean;
      enrichmentFailed?: boolean;
    };
  }): void {
    const draftedAtIso = new Date().toISOString();
    const json = JSON.stringify({ ...input.draft, draftedAt: draftedAtIso });
    this.db
      .prepare(`UPDATE target_queue SET last_draft_json = ?, last_drafted_at = ? WHERE id = ?`)
      .run(json, draftedAtIso, input.id);
  }

  /**
   * Overwrite a queue row's `payload_json`. Manual add-prospect flow: the row
   * is enqueued as a placeholder, then rewritten with the researched dossier
   * so regenerate re-drafts without paying for research again.
   */
  updateQueuePayload(input: { id: number; payload: unknown }): void {
    this.db
      .prepare(`UPDATE target_queue SET payload_json = ? WHERE id = ?`)
      .run(JSON.stringify(input.payload), input.id);
  }

  /**
   * Set a queue row's `notes` without touching its status. Used by the manual
   * add-prospect flow to update the transient "researching profile…" note to
   * a "no email found" flag (or a research-failed message) once the async job
   * settles. Pass an empty string to clear it.
   */
  setQueueNotes(input: { id: number; notes: string }): void {
    this.db
      .prepare(`UPDATE target_queue SET notes = ? WHERE id = ?`)
      .run(input.notes === "" ? null : input.notes, input.id);
  }

  close(): void {
    this.db.close();
  }
}

let singleton: Ledger | null = null;

export function getLedger(): Ledger {
  if (!singleton) singleton = new Ledger();
  return singleton;
}
