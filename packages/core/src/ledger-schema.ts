import type { Database } from "bun:sqlite";

/**
 * Fresh-install schema construction + inline migrations for the ledger's
 * SQLite file. Extracted from `Ledger.migrate()` (see ledger.ts) as the
 * first slice of the ledger split tracked in ROADMAP.md — the highest-risk
 * inline DDL, isolated before the domain methods that follow it.
 *
 * Pure function of a raw `Database` handle: no dependency on the `Ledger`
 * class, so it can be exercised (and schema-snapshotted) without spinning up
 * the rest of the ledger's surface. `Ledger.migrate()` is the sole caller —
 * it runs this once per connection, immediately after opening the database
 * and setting its PRAGMAs.
 */
export function migrateLedgerSchema(db: Database): void {
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

      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
      INSERT OR IGNORE INTO schema_version(version) VALUES(6);
    `);

  // Lightweight migrations for installs that pre-date a column.
  addColumnIfMissing(db, "prospects", "phone", "TEXT");
  // v17: source profile URL (GitHub / X / Luma) as a re-enrichment key —
  // `linkedin_url` is polymorphic and can't serve that role.
  addColumnIfMissing(db, "prospects", "source_profile_url", "TEXT");
  // v18: job title at contact time (person-level ICP gate, _qualify.ts).
  // NULL on rows contacted before the gate existed.
  addColumnIfMissing(db, "prospects", "title", "TEXT");
  // v18: person-level ICP verdict ('pass' | 'reject', NULL = unjudged) +
  // reason. The cadence step runner refuses follow-ups to 'reject' rows —
  // the gate must be code-level, not prompt-level.
  addColumnIfMissing(db, "prospects", "icp_verdict", "TEXT");
  addColumnIfMissing(db, "prospects", "icp_verdict_reason", "TEXT");
  // v5: trigger run-state, so a restart doesn't strand fire-and-forget runs.
  // See sweepStaleRunningTriggers + fireTriggerNow.
  addColumnIfMissing(db, "triggers", "running_started_at", "TEXT");
  // v6: persisted per-row drafts (the /run SSE stream is ephemeral).
  addColumnIfMissing(db, "target_queue", "last_draft_json", "TEXT");
  addColumnIfMissing(db, "target_queue", "last_drafted_at", "TEXT");
  // v7: lease column — dequeueApproved flips it in a transaction so
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
  // Keyed by email, NOT prospect_id — some sends predate the prospect row.
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
  // via request_id — no platform receipt-id backfill needed).
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
  // v17: goal-level value attribution — goal_id mirrors decisionContext.goalId
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
  // v19: inbox-placement canary results — one row per manual A→B test.
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
  // v20: reply-poll watermark — persisted high-water mark makes the inbox
  // poll "everything since last success"; a failed tick leaves the mark in
  // place so the next good poll re-covers the gap.
  db.exec(`
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
  // the CREATE TABLE above — ALTER on a fresh install needs the table.
  addColumnIfMissing(db, "inbox_replies", "kind", "TEXT");
  // contactSuppressionFor, on the send pre-flight path — must be an index seek.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_inbox_replies_from_kind ON inbox_replies(from_email, kind)`,
  );
  // v22: tweets the x-reposters finder already paid to harvest. Both X data
  // providers bill per resource RETURNED, and the finder's freshness window
  // (48h) is wider than its daily cadence — without this ledger every fresh
  // tweet would be re-bought on two consecutive runs.
  db.exec(`
      CREATE TABLE IF NOT EXISTS x_harvested_tweets (
        tweet_id     TEXT PRIMARY KEY,
        harvested_at TEXT NOT NULL
      );
    `);
  // v24: 'cancelled' — the terminal state a run lands in when the SSE client
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
  // metadata — nothing orders, gates, or drains by it in Phase 1.
  addColumnIfMissing(db, "target_queue", "priority_json", "TEXT");
  // v26: decision provenance (issue #410 Phase 3). `status` is a lossy
  // record of the decision HISTORY — expiry overwrites approvals (a reply
  // used to destroy the approval label on its own breakup-revive row),
  // re-open nulls reviewed_at, and bulk approves share one timestamp.
  // These columns record the decision itself and are never touched by
  // expiry or re-open.
  addColumnIfMissing(db, "target_queue", "decision", "TEXT"); // 'approve'|'reject'|'auto_reject'
  addColumnIfMissing(db, "target_queue", "decided_at", "TEXT");
  addColumnIfMissing(db, "target_queue", "decided_by", "TEXT"); // 'human'|'human_bulk'|'machine'
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
}

/**
 * One-time (guard-idempotent, boot-run) inference of decision provenance
 * for pre-v26 rows, reproducing the status-based `isHumanDecision`
 * predicate exactly so every existing metric is unchanged by the migration.
 * Pending/expired rows stay NULL — labels machinery already destroyed are
 * not fabricated. Safe under concurrent boots: the `decision IS NULL`
 * guard makes the loser's UPDATE a no-op.
 */
function backfillDecisionProvenance(db: Database): void {
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
        decided_at = COALESCE(reviewed_at, found_at),
        decided_by = 'machine'
      WHERE decision IS NULL
        AND status = 'rejected'
        AND COALESCE(notes, '') LIKE 'auto:%'
    `);
}

/**
 * SQLite cannot ALTER a CHECK constraint, so admitting 'cancelled' into
 * `runs.status` means rebuilding the table. The sqlite_master probe makes
 * this a no-op on fresh installs and on every boot after the first. Only the
 * original columns are copied — `cancel_reason` is added by the ALTER that
 * follows, so this stays correct whichever order an install arrives in.
 * DROP TABLE takes the indexes with it, hence the recreate.
 */
function widenRunsStatusCheck(db: Database): void {
  // Use explicit BEGIN IMMEDIATE so the schema probe happens while holding
  // the write lock — concurrent processes that see the old schema won't both
  // migrate it and destroy each other's cancel_reason data.
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'`)
      .get() as { sql: string | null } | null;
    if (!row?.sql || row.sql.includes("'cancelled'")) {
      db.exec("ROLLBACK");
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
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
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
