import type { Database } from "bun:sqlite";

/**
 * Ledger schema and migrations over a raw Database handle. Ledger.migrate calls
 * this once per connection after opening the database and setting PRAGMAs.
 *
 * SQL-stamped timestamps use YYYY-MM-DD HH:MM:SS, JS writes use toISOString(),
 * and provider timestamps retain their input format. String comparison is valid
 * only within a format: normalize cutoffs with toSqliteUtc and compare mixed
 * formats with julianday().
 *
 * Existing USD columns use REAL, with totals and caps compared in integer cents.
 * New money columns use INTEGER micro-dollars. Foreign keys are enforced: rows
 * referencing prospects(id) require an existing prospect.
 */
export interface LedgerMigration {
  version: number;
  name: string;
  up(db: Database): void;
}

/**
 * The ledger's schema history, oldest first; `PRAGMA user_version` records the
 * last one applied. To change the schema, append `{ version: N + 1, ... }` and
 * never edit a shipped step: an install on version N runs only what comes
 * after it, all in one transaction. A step may be non-idempotent (a table
 * rebuild, a data move) since it runs once per file.
 *
 * Version 1 is everything before versioning existed: `migrateLedgerSchema`,
 * which is idempotent, so it brings any older ledger (user_version 0) to the
 * same shape a fresh install gets.
 */
export const LEDGER_MIGRATIONS: ReadonlyArray<LedgerMigration> = [
  { version: 1, name: "baseline", up: (db) => migrateLedgerSchema(db) },
  {
    // Which first-touch format arm (`standard` / `brief`) a draft was written
    // in, NULL when its trigger never set one, so outcomes split by format
    // the way `voice_key` splits them by voice card.
    version: 2,
    name: "draft-versions-format-key",
    up: (db) => {
      addColumnIfMissing(db, "draft_versions", "format_key", "TEXT");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_draft_versions_format ON draft_versions(play_name, format_key)",
      );
    },
  },
  {
    // Monotonic per-trigger rotation counter for hiring-signal/job-change's
    // company batches: unlike last_polled_at (a wall-clock value whose modulo
    // can repeat across runs), it steps by exactly 1 per completed run, so
    // the starting batch visits every index before repeating.
    version: 3,
    name: "triggers-company-batch-seq",
    up: (db) => {
      addColumnIfMissing(db, "triggers", "company_batch_seq", "INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    // Outreach channel per queue row and per draft version (channels.ts).
    // Email is the default. X DMs were the only non-email first touch, and
    // the x-amplify-dm play is where they lived.
    version: 4,
    name: "outreach-channel",
    up: (db) => {
      for (const table of ["target_queue", "draft_versions"]) {
        const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (!cols.some((c) => c.name === "channel")) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN channel TEXT NOT NULL DEFAULT 'email'`);
        }
      }
      db.exec("UPDATE target_queue SET channel = 'x' WHERE play_name = 'x-amplify-dm'");
      db.exec("UPDATE draft_versions SET channel = 'x' WHERE play_name = 'x-amplify-dm'");
    },
  },
  {
    // The channel a cadence runs on. A LinkedIn first touch enrolls the
    // prospect in the LinkedIn sequence (message after the invite is
    // accepted), not in its play's email follow-ups.
    version: 5,
    name: "cadence-channel",
    up: (db) => {
      const cols = db.query("PRAGMA table_info(cadence_state)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "channel")) {
        db.exec("ALTER TABLE cadence_state ADD COLUMN channel TEXT NOT NULL DEFAULT 'email'");
      }
    },
  },
  {
    // Whether a draft's angle was assigned by the trigger's even split
    // (`angleAssignment: "arm"`) rather than chosen for fit, so an angle
    // comparison can read only the controlled arm drafts. NULL = fit.
    version: 6,
    name: "draft-versions-angle-assignment",
    up: (db) => {
      addColumnIfMissing(db, "draft_versions", "angle_assignment", "TEXT");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_draft_versions_assignment ON draft_versions(play_name, angle_assignment)",
      );
    },
  },
  {
    // Learning-loop v2 (issue #750): founder-approved ICP rewrite proposals.
    // `icp_proposal_state` is a single evaluation lease/cooldown row (mirrors
    // `reply_learning_state`'s token/until_ms shape); `icp_proposals` holds
    // the generated proposals themselves, reviewed on `/queue`.
    version: 7,
    name: "icp-proposals",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS icp_proposal_state (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          attempted_ms INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          token TEXT,
          until_ms INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS icp_proposals (
          id TEXT PRIMARY KEY,
          current_icp TEXT NOT NULL,
          proposed_icp TEXT NOT NULL,
          evidence_summary TEXT NOT NULL,
          created_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          decided_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_icp_proposals_status ON icp_proposals(status, created_at DESC);
      `);
    },
  },
  {
    // Delivery checks for email sends on transports with no idempotency key
    // (Smartlead mailboxes, Gmail): how many copies the sending mailbox's
    // Sent folder actually holds for one recorded send. One row per checked
    // receipt; a provider-side retry shows up as observed > expected.
    version: 8,
    name: "send-delivery-checks",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS send_delivery_checks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          receipt_id INTEGER NOT NULL UNIQUE,
          sequence_event_id INTEGER,
          queue_id INTEGER,
          prospect_id INTEGER,
          transport TEXT NOT NULL,
          identity TEXT NOT NULL,
          recipient TEXT NOT NULL,
          subject TEXT NOT NULL,
          sent_at TEXT NOT NULL,
          status TEXT NOT NULL,
          expected INTEGER NOT NULL DEFAULT 1,
          observed INTEGER,
          message_ids TEXT NOT NULL DEFAULT '[]',
          delivered_at TEXT NOT NULL DEFAULT '[]',
          checked_at TEXT NOT NULL,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_send_delivery_status ON send_delivery_checks(status, checked_at DESC);
        CREATE INDEX IF NOT EXISTS idx_send_delivery_queue ON send_delivery_checks(queue_id);
        CREATE INDEX IF NOT EXISTS idx_send_delivery_event ON send_delivery_checks(sequence_event_id);
      `);
    },
  },
  {
    // How each reply's intent was decided: the classifier's confidence and
    // per-label probabilities (the decisions engine returns both), which
    // engine/model produced it, its cost in micro-dollars, when, and whether
    // the confidence was under the workspace's review threshold.
    version: 9,
    name: "inbox-reply-intent-details",
    up: (db) => {
      addColumnIfMissing(db, "inbox_replies", "intent_confidence", "REAL");
      addColumnIfMissing(db, "inbox_replies", "intent_probs", "TEXT");
      addColumnIfMissing(db, "inbox_replies", "intent_classifier", "TEXT");
      addColumnIfMissing(db, "inbox_replies", "intent_cost_micros", "INTEGER");
      addColumnIfMissing(db, "inbox_replies", "intent_classified_at", "TEXT");
      addColumnIfMissing(db, "inbox_replies", "intent_review", "INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    // One row per INTENDED outbound email, keyed by a semantic idempotency key
    // the caller derives from what the email is (workspace, play, recipient or
    // prospect, step), never from its text. The key is the claim: a second
    // attempt for the same key is refused or replayed instead of sent, and a
    // retry after a definite failure reuses the same Message-ID. The confirm
    // sweep moves submitted/uncertain rows to confirmed, failed or not_found
    // by finding the send in the mailbox's Sent folder.
    version: 10,
    name: "outbound-sends",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS outbound_sends (
          key TEXT PRIMARY KEY,
          identity_id TEXT NOT NULL,
          transport TEXT NOT NULL,
          recipient TEXT NOT NULL,
          subject TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          message_id TEXT,
          status TEXT NOT NULL,
          sent_evidence INTEGER NOT NULL DEFAULT 0,
          exact_resend INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0,
          first_attempt_at TEXT NOT NULL,
          last_attempt_at TEXT NOT NULL,
          submitted_at TEXT,
          confirmed_at TEXT,
          checked_at TEXT,
          observed INTEGER,
          receipt_id INTEGER,
          queue_id INTEGER,
          prospect_id INTEGER,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_outbound_sends_status ON outbound_sends(status, last_attempt_at);
        CREATE INDEX IF NOT EXISTS idx_outbound_sends_receipt ON outbound_sends(receipt_id);
      `);
    },
  },
  {
    // Mailbox replies move onto outbound_sends: the reply's threading (inbound
    // message, thread, In-Reply-To, References, MIME Date) is stored with the
    // claim, and a partial unique index allows one reply in flight per inbound
    // message. Rows of the old mailbox_attempts table are copied in under the
    // key the reply path already used; the table itself is left, unread.
    version: 11,
    name: "replies-on-outbound-sends",
    up: (db) => migrateRepliesOntoOutboundSends(db),
  },
];

/** Legacy attempt status → outbound_sends status (see migration 11). */
const ATTEMPT_STATUS: Record<string, string> = {
  sending: "uncertain",
  uncertain: "uncertain",
  sent: "confirmed",
  failed: "failed",
};

/**
 * Migration 11. Idempotent: the columns and index are added only when
 * missing, and the copy upserts by key, so a second run leaves the same rows.
 * A copied row overwrites the outcome-only mirror row #765 wrote for the same
 * key (it had no body), keeping that row's receipt.
 */
export function migrateRepliesOntoOutboundSends(db: Database): void {
  const has = new Set(
    (db.query("PRAGMA table_info(outbound_sends)").all() as { name: string }[]).map((c) => c.name),
  );
  const columns: [string, string][] = [
    ["kind", "TEXT NOT NULL DEFAULT 'initial'"],
    ["inbound_id", "TEXT"],
    ["thread_key", "TEXT"],
    ["in_reply_to", "TEXT"],
    ["references_json", "TEXT"],
    ["date_header", "TEXT"],
  ];
  for (const [name, type] of columns) {
    if (!has.has(name)) db.exec(`ALTER TABLE outbound_sends ADD COLUMN ${name} ${type}`);
  }
  const tableExists = (name: string) =>
    db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
  // Rebuilt below, after the copy has settled any duplicate in-flight rows.
  db.exec("DROP INDEX IF EXISTS outbound_reply_inflight");
  if (tableExists("mailbox_attempts")) {
    // Same rule as currentWorkspaceName() (shared-db.ts), inlined to keep the
    // schema module free of imports: the key the reply path has always used.
    const workspace = process.env["ONESHOT_GTM_WORKSPACE"]?.trim() || "default";
    const inboundMessageId = tableExists("mailbox_messages")
      ? db.query<{ message_id: string | null }, [string]>(
          "SELECT message_id FROM mailbox_messages WHERE id=?",
        )
      : null;
    const upsert = db.query(
      `INSERT INTO outbound_sends
         (key, identity_id, transport, recipient, subject, body, message_id, status,
          sent_evidence, exact_resend, attempts, first_attempt_at, last_attempt_at,
          submitted_at, confirmed_at, error, kind, inbound_id, thread_key, in_reply_to,
          references_json, date_header)
       VALUES (?, ?, 'smtp', ?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?, ?, ?, 'reply', ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         identity_id = excluded.identity_id, transport = excluded.transport,
         recipient = excluded.recipient, subject = excluded.subject, body = excluded.body,
         message_id = excluded.message_id, status = excluded.status,
         sent_evidence = excluded.sent_evidence, exact_resend = excluded.exact_resend,
         attempts = excluded.attempts, first_attempt_at = excluded.first_attempt_at,
         last_attempt_at = excluded.last_attempt_at, submitted_at = excluded.submitted_at,
         confirmed_at = excluded.confirmed_at, error = excluded.error, kind = excluded.kind,
         inbound_id = excluded.inbound_id, thread_key = excluded.thread_key,
         in_reply_to = excluded.in_reply_to, references_json = excluded.references_json,
         date_header = excluded.date_header`,
    );
    const rows = db
      .query("SELECT id, inbound_id, status, data FROM mailbox_attempts ORDER BY rowid")
      .all() as { id: string; inbound_id: string; status: string; data: string }[];
    for (const row of rows) {
      let attempt: {
        error?: string | null;
        message?: {
          identityId?: string;
          to?: string[];
          subject?: string;
          body?: string;
          messageId?: string | null;
          references?: string[];
          threadKey?: string;
          at?: string;
        };
      };
      try {
        attempt = JSON.parse(row.data);
      } catch {
        continue;
      }
      const m = attempt.message;
      if (!m?.identityId || !m.at) continue;
      const status = ATTEMPT_STATUS[row.status] ?? "uncertain";
      const references = m.references ?? [];
      const inReplyTo =
        inboundMessageId?.get(row.inbound_id)?.message_id ?? references.at(-1) ?? null;
      const settledAt = status === "confirmed" ? m.at : null;
      upsert.run(
        `gtm:${workspace}:reply:${row.id}`,
        m.identityId,
        (m.to?.[0] ?? "").trim().toLowerCase(),
        m.subject ?? "",
        m.body ?? "",
        m.messageId ?? null,
        status,
        status === "uncertain" ? 1 : 0,
        m.at,
        m.at,
        settledAt,
        settledAt,
        attempt.error ?? null,
        row.inbound_id,
        m.threadKey ?? null,
        inReplyTo,
        JSON.stringify(references),
        m.at,
      );
    }
  }
  // The old store allowed one in-flight attempt per inbound message, so this
  // only guards an impossible state: keep the newest, settle the rest.
  db.exec(`
    UPDATE outbound_sends SET status = 'not_found',
           error = 'superseded by a later reply attempt to the same message'
     WHERE kind = 'reply' AND status IN ('pending', 'uncertain')
       AND EXISTS (
         SELECT 1 FROM outbound_sends o
          WHERE o.kind = 'reply' AND o.status IN ('pending', 'uncertain')
            AND o.inbound_id = outbound_sends.inbound_id
            AND (o.last_attempt_at > outbound_sends.last_attempt_at
                 OR (o.last_attempt_at = outbound_sends.last_attempt_at AND o.key > outbound_sends.key))
       );
    CREATE UNIQUE INDEX IF NOT EXISTS outbound_reply_inflight ON outbound_sends(inbound_id)
      WHERE kind = 'reply' AND status IN ('pending', 'uncertain');
  `);
}

export const LEDGER_SCHEMA_VERSION = LEDGER_MIGRATIONS[LEDGER_MIGRATIONS.length - 1]!.version;

function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/**
 * Bring a ledger to the latest schema. Up to date (the normal case): one
 * pragma read. Behind: every missing step, then the new user_version, in one
 * BEGIN IMMEDIATE, so a crash leaves the file on its old version rather than
 * half-migrated, and a second process waiting on the lock sees the new
 * version and does nothing. A file from a newer build is left alone.
 * `migrations` is for tests.
 */
export function runLedgerMigrations(
  db: Database,
  migrations: ReadonlyArray<LedgerMigration> = LEDGER_MIGRATIONS,
): void {
  const latest = migrations[migrations.length - 1]!.version;
  if (userVersion(db) >= latest) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = userVersion(db);
    if (current < latest) {
      for (const step of migrations) {
        if (step.version > current) step.up(db);
      }
      // PRAGMA values can't be bound; `latest` is a number from our own list.
      db.exec(`PRAGMA user_version = ${Math.trunc(latest)}`);
    }
    db.exec("COMMIT");
  } catch (err) {
    rollbackQuietly(db);
    throw err;
  }
}

/**
 * Roll back if a transaction is still open, never masking the error that got
 * us here: SQLite ends the transaction itself on some failures (SQLITE_FULL,
 * SQLITE_IOERR, SQLITE_NOMEM), and a bare ROLLBACK would then throw "no
 * transaction is active" in place of the real cause.
 */
function rollbackQuietly(db: Database): void {
  if (!db.inTransaction) return;
  try {
    db.exec("ROLLBACK");
  } catch {
    // The original error is the one worth reporting.
  }
}

export function migrateLedgerSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cadence_plans (
    prospect_id INTEGER NOT NULL, play_name TEXT NOT NULL, enrollment TEXT NOT NULL, steps TEXT NOT NULL,
    PRIMARY KEY(prospect_id, play_name, enrollment)
  );
  CREATE TABLE IF NOT EXISTS mail_address_metadata (key TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS mail_preparations (
    prospect_id INTEGER NOT NULL, play_name TEXT NOT NULL, enrollment TEXT NOT NULL, step_index INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY(prospect_id,play_name,enrollment,step_index)
  );
  CREATE TABLE IF NOT EXISTS direct_mail_drafts (
    id TEXT PRIMARY KEY, prospect_id INTEGER NOT NULL, play_name TEXT NOT NULL,
    enrollment TEXT NOT NULL, step_index INTEGER NOT NULL, data TEXT NOT NULL,
    UNIQUE(prospect_id,play_name,enrollment,step_index)
  );
  CREATE TABLE IF NOT EXISTS direct_mail_addresses (key TEXT PRIMARY KEY, address TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS direct_mail_receipts (receipt_id TEXT PRIMARY KEY, local_id INTEGER NOT NULL);`);

  db.exec(`
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

      CREATE TABLE IF NOT EXISTS product_research_cache (
        cache_key TEXT PRIMARY KEY,
        dossier_json TEXT NOT NULL,
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

      -- Legacy: never advanced past 6. PRAGMA user_version is the schema
      -- version (see LEDGER_MIGRATIONS); this table stays for old readers.
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
      INSERT OR IGNORE INTO schema_version(version) VALUES(6);
    `);

  // Lightweight migrations for installs that pre-date a column.
  addColumnIfMissing(db, "prospects", "phone", "TEXT");
  // v17: source profile URL (GitHub / X / Luma) as a re-enrichment key:
  // `linkedin_url` is polymorphic and can't serve that role.
  addColumnIfMissing(db, "prospects", "source_profile_url", "TEXT");
  // v18: job title at contact time (person-level ICP gate, _qualify.ts).
  // NULL on rows contacted before the gate existed.
  addColumnIfMissing(db, "prospects", "title", "TEXT");
  // v18: person-level ICP verdict ('pass' | 'reject', NULL = unjudged) +
  // reason. The cadence step runner refuses follow-ups to 'reject' rows:
  // the gate must be code-level, not prompt-level.
  addColumnIfMissing(db, "prospects", "icp_verdict", "TEXT");
  addColumnIfMissing(db, "prospects", "icp_verdict_reason", "TEXT");
  // v5: trigger run-state, so a restart doesn't strand fire-and-forget runs.
  // See sweepStaleRunningTriggers + fireTriggerNow.
  addColumnIfMissing(db, "triggers", "running_started_at", "TEXT");
  // v6: persisted per-row drafts (the /run SSE stream is ephemeral).
  addColumnIfMissing(db, "target_queue", "last_draft_json", "TEXT");
  addColumnIfMissing(db, "target_queue", "last_drafted_at", "TEXT");
  // v7: lease column: dequeueApproved flips it in a transaction so
  // concurrent drains claim disjoint slices; 15-min lease self-heals a
  // crashed drain.
  addColumnIfMissing(db, "target_queue", "drain_claimed_at", "TEXT");
  // v8: per-cadence next-step draft preview; cleared on cadence advance.
  addColumnIfMissing(db, "cadence_state", "next_step_draft_json", "TEXT");
  addColumnIfMissing(db, "cadence_state", "next_step_drafted_at", "TEXT");
  // v9: send-in-flight marker so a fire-and-forget cadence send survives a
  // restart. CAS-claimed (claimCadenceSendingMarker); cleared on success and
  // failure; sweepStaleCadenceSends treats cold-boot markers as stranded.
  addColumnIfMissing(db, "cadence_state", "sending_started_at", "TEXT");
  // Manual stops are distinct from natural completion and carry a durable
  // disposition used by Expandi and breakup-revive.
  addColumnIfMissing(db, "cadence_state", "stop_reason", "TEXT");
  addColumnIfMissing(db, "cadence_state", "stop_note", "TEXT");
  addColumnIfMissing(db, "cadence_state", "stopped_at", "TEXT");
  // v10: mirror of v9 for the queue Send-draft path (claimQueueSendingMarker
  // + sweepStaleQueueSends; cleared by setQueueStatus on terminal states).
  addColumnIfMissing(db, "target_queue", "send_started_at", "TEXT");
  // v11: sender rotation. sender_identity feeds the per-identity daily
  // counter + warm-up date; sender_assignments pins each prospect to their
  // first-touch identity so follow-ups never switch From address mid-thread.
  // Keyed by email, NOT prospect_id: some sends predate the prospect row.
  addColumnIfMissing(db, "receipts", "sender_identity", "TEXT");
  // v12: negative enrichment caching. NULL/"ok" = success, "failed" = skip
  // retries within ENRICH_FAILURE_TTL_MS instead of re-paying ~70s timeouts.
  addColumnIfMissing(db, "enrichment_cache", "status", "TEXT");
  db.exec(`
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
  db.exec(`
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
  addColumnIfMissing(db, "cadence_state", "last_send_error", "TEXT");
  addColumnIfMissing(db, "cadence_state", "last_send_error_at", "TEXT");
  // v15: candidates whose contact-resolution failed on a TRANSIENT platform
  // error. Time-windowed finders (luma, show-hn) can't re-discover an expired
  // source, so the scheduler retry pass drains this; the (play_name,
  // dedupe_key) PK doubles as the de-dup key against re-scan.
  db.exec(`
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
  // via request_id: no platform receipt-id backfill needed).
  addColumnIfMissing(db, "receipts", "memo", "TEXT");
  addColumnIfMissing(db, "receipts", "decision_context", "TEXT");
  addColumnIfMissing(db, "receipts", "value_tag", "TEXT");
  addColumnIfMissing(db, "receipts", "value_tagged_at", "TEXT");
  addColumnIfMissing(db, "sequence_events", "receipt_id", "INTEGER");
  db.exec(`
      -- value-tag filter on the /receipts page; partial (tagged rows only).
      CREATE INDEX IF NOT EXISTS idx_receipts_value_tag
        ON receipts(value_tag, created_at) WHERE value_tag IS NOT NULL;
    `);
  // v17: goal-level value attribution: goal_id mirrors decisionContext.goalId
  // so an outcome tags every receipt in the cadence at once.
  addColumnIfMissing(db, "receipts", "goal_id", "TEXT");
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_receipts_goal
        ON receipts(goal_id) WHERE goal_id IS NOT NULL;
    `);
  // v18: delivery failures parsed from DSNs. PK (message_id, recipient):
  // the provider's message id makes the every-tick re-sweep idempotent, and
  // recipient keeps multi-recipient reports from collapsing into one row.
  db.exec(`
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
  // v19: inbox-placement canary results: one row per manual A→B test.
  // Append-only so the reputation trend stays visible.
  db.exec(`
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
  // v20: reply-poll watermark: persisted high-water mark makes the inbox
  // poll "everything since last success"; a failed tick leaves the mark in
  // place so the next good poll re-covers the gap.
  db.exec(`
      CREATE TABLE IF NOT EXISTS poll_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  // Local, per-prospect inbox organization; independent of drafts and provider mailboxes.
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_archives (
    prospect_id INTEGER PRIMARY KEY,
    archived_at TEXT NOT NULL
  )`);
  // v21: inbound replies persisted at detection (body included). The ledger,
  // not the mailbox, is the store; a reply must never depend on a live fetch
  // window. PK is the provider email id so the poll's overlap re-sweeps and
  // the /inbox route's opportunistic captures are idempotent (mirrors
  // bounces). Only prospect-matched mail is stored.
  db.exec(`
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

      CREATE TABLE IF NOT EXISTS channel_events (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        source            TEXT NOT NULL,
        external_event_id TEXT NOT NULL,
        prospect_id       INTEGER NOT NULL,
        channel           TEXT NOT NULL,
        event_type        TEXT NOT NULL,
        occurred_at       TEXT NOT NULL,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(source, external_event_id),
        FOREIGN KEY(prospect_id) REFERENCES prospects(id)
      );
      CREATE INDEX IF NOT EXISTS idx_channel_events_prospect_time
        ON channel_events(prospect_id, occurred_at);
    `);
  // v23: reply classification ('human' | 'auto' | 'auto_permanent' |
  // 'unsubscribe', see reply-classify.ts). NULL = row predates the
  // classifier and reads as 'human' everywhere (coalesce). Must run after
  // the CREATE TABLE above: ALTER on a fresh install needs the table.
  addColumnIfMissing(db, "inbox_replies", "kind", "TEXT");
  // contactSuppressionFor, on the send pre-flight path: must be an index seek.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_inbox_replies_from_kind ON inbox_replies(from_email, kind)`,
  );
  // v22: tweets the x-reposters finder already paid to harvest. Both X data
  // providers bill per resource RETURNED, and the finder's freshness window
  // (48h) is wider than its daily cadence, without this ledger every fresh
  // tweet would be re-bought on two consecutive runs.
  db.exec(`
      CREATE TABLE IF NOT EXISTS x_harvested_tweets (
        tweet_id     TEXT PRIMARY KEY,
        harvested_at TEXT NOT NULL
      );
    `);
  // v24: 'cancelled'. The terminal state a run lands in when the SSE client
  // disconnects or POST /api/run/:runId/cancel fires, plus the reason that
  // got it there. The CREATE TABLE above already allows it on a fresh
  // install; older installs carry the narrower CHECK and need the rebuild.
  widenRunsStatusCheck(db);
  addColumnIfMissing(db, "runs", "cancel_reason", "TEXT");
  addColumnIfMissing(db, "runs", "dedupe_keys_json", "TEXT");
  db.exec(`UPDATE runs SET dedupe_keys_json = '[]' WHERE dedupe_keys_json IS NULL`);
  // v25: shadow-mode prospect priority (issue #410). Serialized
  // ProspectPriority computed at enqueue time from payload evidence; NULL on
  // manual/legacy rows, auto-rejections, and everything pre-v25. Read-only
  // metadata: nothing orders, gates, or drains by it in Phase 1.
  addColumnIfMissing(db, "target_queue", "priority_json", "TEXT");
  // v26: decision provenance (issue #410 Phase 3). `status` is a lossy
  // record of the decision HISTORY: expiry overwrites approvals (a reply
  // used to destroy the approval label on its own breakup-revive row),
  // re-open nulls reviewed_at, and bulk approves share one timestamp.
  // These columns record the decision itself and are never touched by
  // expiry or re-open.
  addColumnIfMissing(db, "target_queue", "decision", "TEXT"); // 'approve'|'reject'|'auto_reject'
  addColumnIfMissing(db, "target_queue", "decided_at", "TEXT");
  addColumnIfMissing(db, "target_queue", "decided_by", "TEXT"); // 'human'|'human_bulk'|'machine'
  // The text of an off-email message, when the channel gives us one. Without
  // it a recorded LinkedIn reply could stop a cadence but never feed the reply
  // composer, which needs a body to draft against.
  addColumnIfMissing(db, "channel_events", "body", "TEXT");
  backfillDecisionProvenance(db);
  // v27: signed webhook replay keys. Keeping these in the ledger makes replay
  // protection survive server restarts; expired rows are pruned when a new
  // valid delivery is consumed.
  db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_replays (
        replay_key TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_replays_expiry
        ON webhook_replays(expires_at);
    `);
  // v28 (issue #481): install-wide daily USD spend ceiling: reservations
  // held for the duration of an automated call (finder trigger run,
  // automatic drain) so two concurrent automated paths across processes
  // can't both slip under the ceiling before either one's spend has
  // posted to `receipts`. `created_at` uses the same SQLite UTC format
  // (and the same local-midnight boundary, via `todayStartSqliteUtc`) as
  // `receipts.created_at`, so the spend ceiling and the per-identity send
  // caps agree about when a new day starts. A row is deleted (not
  // soft-released) once the caller finishes; a crashed process's orphaned
  // reservation is swept by age (`SPEND_RESERVATION_STALE_MS`) so it can't
  // haunt the rest of the day.
  db.exec(`
      CREATE TABLE IF NOT EXISTS spend_reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amount_usd REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_spend_reservations_created ON spend_reservations(created_at);
    `);
  // v29: reply INTENT (issue #480): sentiment classification, distinct from
  // `kind` (deliverability triage, v23). Populated best-effort by
  // pollInboxReplies right after a reply classifies as `kind: 'human'`, via
  // the existing intel/triage.ts taxonomy (TriageCategory). NULL = not yet
  // triaged (a triage-call failure never blocks recording the reply itself).
  addColumnIfMissing(db, "inbox_replies", "intent", "TEXT");
  addColumnIfMissing(db, "inbox_replies", "intent_reason", "TEXT");
  // v30: founder steer + draft status (issue #480). `steer` is a short
  // standing instruction for the NEXT redraft of this thread ("docs listing
  // only, no exclusivity"), set from /inbox and read by draftInboxReply.
  // `status` is recomputed on every save from the draft body's own lint
  // state ('needs_decision' when the commits-terms flag survives, else
  // NULL). Never hand-set, so it can never drift from the text it
  // describes.
  addColumnIfMissing(db, "inbox_drafts", "steer", "TEXT");
  addColumnIfMissing(db, "inbox_drafts", "status", "TEXT");
  // v31: occurrence timestamp for a reply, separate from created_at.
  // markLatestStepReplied flips the ORIGINAL sent row's status in place, so
  // created_at stays pinned to the send time: eventsByPlay's sinceIso/
  // untilIso window (used by the Slack daily-summary aggregate) was
  // silently dropping any reply landing after the SENT step's created_at
  // window instead of the reply's own occurrence day. replied_at is stamped
  // at the moment of the flip and is what date-windowed rollups must filter
  // on for replies. (Bounces get the equivalent fix in v33: created_at
  // alone turned out NOT to be occurrence time for them either: see that
  // migration's comment.)
  addColumnIfMissing(db, "sequence_events", "replied_at", "TEXT");
  // v32: per-prospect angle (issue #355): LLM synthesis of dossier + live
  // public work + reply history, distinct from `dossier_json` (raw research
  // input) and from `yourEdge` (founder config stamped identically on every
  // target). `angle_synthesized_at` NULL = never synthesized; set alongside
  // `angle_json` by `setProspectAngle`, cleared together when passed null.
  addColumnIfMissing(db, "prospects", "angle_json", "TEXT");
  addColumnIfMissing(db, "prospects", "angle_synthesized_at", "TEXT");
  // v33: issue #71 round-2 review finding. A bounced sequence_events row IS
  // freshly inserted per occurrence (unlike the replied flip-in-place), so
  // created_at looked like occurrence time, but it's actually POLL/detection
  // time: pollInboxBounces only sees a DSN once the mailbox is next polled,
  // and a poll resuming after downtime (or a delayed bounce) can misattribute
  // the bounce to the wrong UTC calendar day in the Slack daily summary.
  // bounced_at carries the provider's own bounce timestamp (already captured
  // as `bouncedAt` from the message's internalDate: see gmail.ts) so
  // eventsByPlay can window bounces the same way it windows replies, via
  // COALESCE(bounced_at, created_at).
  addColumnIfMissing(db, "sequence_events", "bounced_at", "TEXT");
  // v34 (issue #577): past calendar meetings needing an outcome. Composite
  // PK because a Google Calendar event id is only unique WITHIN one
  // calendar. `singleEvents=true` derives a recurring instance's id from its
  // ORIGINAL start, so it survives a reschedule: recurring_event_id is kept
  // so a moved instance is never forked into a ghost row. `ical_uid` is
  // indexed (not unique) because the same meeting on two calendars produces
  // two distinct (calendar_id, event_id) rows sharing one iCalUID.
  //
  // Every write here MUST be an idempotent `ON CONFLICT DO UPDATE`, never
  // `INSERT OR REPLACE` (a cancellation stub carries almost no fields and
  // would wipe summary/prospect_id/outcome) and never `INSERT OR IGNORE`
  // (unlike an immutable inbox_replies row, an event mutates in place:
  // reschedules and cancellations are updates to the SAME row, not new
  // ones). See `upsertMeeting` in ledger.ts for the COALESCE(excluded.col,
  // meetings.col) pattern this requires.
  db.exec(`
      CREATE TABLE IF NOT EXISTS meetings (
        calendar_id                TEXT NOT NULL,
        event_id                   TEXT NOT NULL,
        ical_uid                   TEXT,
        recurring_event_id         TEXT,
        status                     TEXT NOT NULL DEFAULT 'confirmed',
        summary                    TEXT,
        all_day                    INTEGER NOT NULL DEFAULT 0,
        starts_at                  TEXT,
        ends_at                    TEXT,
        event_timezone             TEXT,
        organizer_email            TEXT,
        -- The founder's own (self:true) attendee responseStatus. Distinct
        -- from match_status (which is about PROSPECT identification, not
        -- the founder's RSVP) — a declined event is excluded from the
        -- pending-outcome nudge but the row is kept, never dropped.
        self_response              TEXT,
        external_attendee_count    INTEGER NOT NULL DEFAULT 0,
        -- Capped ~20 entries; sourced from attendees ∪ {organizer, creator}
        -- minus the founder's own addresses. Never the raw attendees[]
        -- payload — description/dial-in PINs must never land here either.
        external_attendees_json    TEXT,
        attendees_omitted          INTEGER NOT NULL DEFAULT 0,
        prospect_id                INTEGER,
        suggested_prospect_id      INTEGER,
        -- 'exact' | 'suggested' | 'ambiguous' | 'dismissed' | NULL (no
        -- candidate at all — a self-block or an unmatched event).
        match_status               TEXT,
        -- 'name_domain' | 'domain' | 'name' | 'description' | NULL for an
        -- 'exact' match (email-identity, no fuzzy method to name).
        match_method               TEXT,
        match_confidence           REAL,
        -- 'held' | 'no_show' | 'cancelled' | 'rescheduled', founder-set only.
        outcome                    TEXT,
        outcome_note               TEXT,
        outcome_recorded_at        TEXT,
        -- Cleared (not the outcome) when a reschedule changes starts_at —
        -- a stale nudge must withdraw, but a recorded outcome must survive.
        outcome_prompted_at        TEXT,
        -- The API's own 'updated' timestamp on this event — the
        -- idempotency guard: if this hasn't advanced since last_seen_at,
        -- the poll should touch only last_seen_at and skip re-deriving
        -- everything else.
        event_updated_at           TEXT,
        first_seen_at              TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at               TEXT NOT NULL DEFAULT (datetime('now')),
        -- Sorted, joined external emails. The fingerprint is what makes a
        -- founder's dismiss STICK: re-matching only runs when this value
        -- changes between polls, so a dismissed suggestion is never
        -- silently re-proposed on an unchanged attendee list.
        attendees_fingerprint      TEXT,
        PRIMARY KEY (calendar_id, event_id)
      );
      -- The pending-outcome nudge query's exact WHERE clause, as a partial
      -- index: only rows that could ever match it are indexed.
      CREATE INDEX IF NOT EXISTS idx_meetings_pending_outcome
        ON meetings(ends_at)
        WHERE outcome IS NULL AND status = 'confirmed' AND all_day = 0
          AND prospect_id IS NOT NULL;
      -- The founder-facing review list (unmatched/suggested/ambiguous rows).
      CREATE INDEX IF NOT EXISTS idx_meetings_match_status
        ON meetings(match_status, starts_at);
      -- Per-prospect meeting timeline.
      CREATE INDEX IF NOT EXISTS idx_meetings_prospect
        ON meetings(prospect_id, starts_at);
      -- Duplicate detection: the same meeting on two calendars has two ids
      -- and one iCalUID. Partial (most rows carry one) — indexing NULLs
      -- would cost space for a column that's never queried on for them.
      CREATE INDEX IF NOT EXISTS idx_meetings_ical_uid
        ON meetings(ical_uid) WHERE ical_uid IS NOT NULL;
    `);

  // v33: draft versions. Every draft put in front of the founder, intro or
  // follow-up, with what became of it (see ledger-drafts.ts). Before this,
  // `target_queue.last_draft_json` and `cadence_state.next_step_draft_json`
  // were overwritten in place, so a regenerate erased the draft it replaced
  // and no row said which angle a send was built on once the edge changed.
  db.exec(`
      CREATE TABLE IF NOT EXISTS draft_versions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        play_name      TEXT NOT NULL,
        -- lower-cased trimmed email, else the queue row's dedupe_key /
        -- 'prospect:<id>' — one value per person so DISTINCT counts people.
        prospect_key   TEXT NOT NULL,
        -- 0 = intro, n = follow-up step n (cadence current_step + 1).
        step_index     INTEGER NOT NULL,
        queue_id       INTEGER,
        prospect_id    INTEGER,
        subject        TEXT NOT NULL,
        body           TEXT NOT NULL,
        flags_json     TEXT,
        -- angleTextKey(angle_text); NULL when the draft carried no angle.
        angle_key      TEXT,
        angle_text     TEXT,
        angle_origin   TEXT,           -- 'configured' | 'generated'
        outcome        TEXT NOT NULL,  -- 'open' | 'discarded' | 'sent' | 'auto_sent'
        discard_reason TEXT,           -- 'regenerate' | 'rotate' | 'redraft' | 'abandoned'
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        closed_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_draft_versions_queue
        ON draft_versions(queue_id, outcome);
      CREATE INDEX IF NOT EXISTS idx_draft_versions_cadence
        ON draft_versions(prospect_id, play_name, step_index, outcome);
      CREATE INDEX IF NOT EXISTS idx_draft_versions_play
        ON draft_versions(play_name, angle_key);
    `);

  // v34: which founder voice card (a short hash of it) a draft was written
  // with, NULL when none was set, so approve/reject outcomes split by card
  // even if the card changes mid-review.
  addColumnIfMissing(db, "draft_versions", "voice_key", "TEXT");
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_draft_versions_voice
        ON draft_versions(play_name, voice_key);
    `);
}

/**
 * One-time (guard-idempotent, boot-run) inference of decision provenance
 * for pre-v26 rows, reproducing the status-based `isHumanDecision`
 * predicate exactly so every existing metric is unchanged by the migration.
 * Pending/expired rows stay NULL: labels machinery already destroyed are
 * not fabricated. Safe under concurrent boots: the `decision IS NULL`
 * guard makes the loser's UPDATE a no-op.
 */
export function backfillDecisionProvenance(db: Database): void {
  // Approvals. A human cannot hand-approve 20 rows in one millisecond, so
  // >=20 rows sharing (play_name, reviewed_at) is an approveAllPending
  // batch (the gauge measured a single 108-row millisecond) → human_bulk.
  db.exec(`
      UPDATE target_queue SET
        decision = 'approve',
        decided_at = reviewed_at,
        decided_by = CASE WHEN (
          SELECT COUNT(*) FROM target_queue t2
          WHERE t2.play_name = target_queue.play_name
            AND t2.reviewed_at = target_queue.reviewed_at
            AND t2.status IN ('approved','sent')
        ) >= 20 THEN 'human_bulk' ELSE 'human' END
      WHERE decision IS NULL
        AND status IN ('approved','sent')
        AND reviewed_at IS NOT NULL
    `);
  // Human rejections (COALESCE: NULL notes is a human rejection, the
  // three-valued-logic trap documented in labels.ts).
  db.exec(`
      UPDATE target_queue SET
        decision = 'reject', decided_at = reviewed_at, decided_by = 'human'
      WHERE decision IS NULL
        AND status = 'rejected'
        AND reviewed_at IS NOT NULL
        AND COALESCE(notes, '') NOT LIKE 'auto:%'
    `);
  // Machine rejections (ICP/role gates, import classifiers).
  db.exec(`
      UPDATE target_queue SET
        decision = 'auto_reject',
        -- decided_at is ISO (JS-written); found_at is SQLite-form.
        decided_at = COALESCE(reviewed_at, strftime('%Y-%m-%dT%H:%M:%fZ', found_at)),
        decided_by = 'machine'
      WHERE decision IS NULL
        AND status = 'rejected'
        AND COALESCE(notes, '') LIKE 'auto:%'
    `);
  // Earlier versions of the backfill above copied found_at verbatim, leaving
  // SQLite-form values in an otherwise-ISO column. Once converted, no row
  // matches, so re-running this on every boot is a no-op.
  db.exec(`
      UPDATE target_queue
      SET decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', decided_at)
      WHERE decided_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]'
    `);
}

/**
 * SQLite cannot ALTER a CHECK constraint, so admitting 'cancelled' into
 * `runs.status` means rebuilding the table. The sqlite_master probe makes
 * this a no-op on fresh installs and on every boot after the first. Only the
 * original columns are copied: `cancel_reason` is added by the ALTER that
 * follows, so this stays correct whichever order an install arrives in.
 * DROP TABLE takes the indexes with it, hence the recreate.
 */
function widenRunsStatusCheck(db: Database): void {
  // The schema probe must happen while holding the write lock, so concurrent
  // processes that see the old schema won't both migrate it and destroy each
  // other's cancel_reason data. Under runLedgerMigrations the caller already
  // holds it; a direct migrateLedgerSchema call takes it here.
  const own = !db.inTransaction;
  if (own) db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'`)
      .get() as { sql: string | null } | null;
    if (!row?.sql || row.sql.includes("'cancelled'")) {
      if (own) db.exec("ROLLBACK");
      return;
    }
    db.exec(`
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
    if (own) db.exec("COMMIT");
  } catch (err) {
    if (own) rollbackQuietly(db);
    throw err;
  }
}

export function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  type: string,
): void {
  // Defense-in-depth: SQLite has no parameter binding for table/column/type
  // names, so we must validate. Whitelist to bare ASCII identifiers only.
  const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (!ident.test(table) || !ident.test(column)) {
    throw new Error(`unsafe identifier in addColumnIfMissing: ${table}.${column}`);
  }
  if (!/^[A-Z][A-Z0-9_ ]*$/.test(type)) {
    throw new Error(`unsafe column type in addColumnIfMissing: ${type}`);
  }
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (err) {
    // Two connections can both see the column as missing (check-then-alter
    // is unlocked); the loser's ALTER must not abort Ledger construction.
    // Same tolerance as SharedDb.migrate.
    if (!/duplicate column/i.test((err as Error).message ?? "")) throw err;
  }
}
