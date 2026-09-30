import type { Database } from "bun:sqlite";

/** Parse a JSON array column defensively; malformed/non-array JSON reads as empty. */
function safeParseJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface RunRecord {
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
}

/**
 * `runs` table persistence over a raw Database handle: one row per /run
 * Execute click. The SSE endpoint persists events/counters, the UI rebuilds
 * progress from the row, and the cold-boot sweep flips stranded `running`
 * rows to `interrupted`. Extracted from `Ledger` (issue #751); `Ledger`
 * delegates every run method here unchanged.
 */

export function createRun(
  db: Database,
  input: {
    playName: string;
    dryRun: boolean;
    targets: unknown[];
    dedupeKeys?: Array<string | null>;
  },
): { runId: number; startedAt: string } {
  const startedAt = new Date().toISOString();
  const result = db
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
 * counter. Cheap re-serialize is fine: events_json fits in a single row;
 * runs are bounded at ~25 targets typically.
 */
export function appendRunEvent(db: Database, input: { runId: number; event: unknown }): void {
  const row = db
    .query(`SELECT events_json, drafted_count, sent_count, error_count FROM runs WHERE id = ?`)
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
  // Counter bump driven by event.kind: keeps the writer side simple and
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
  db.prepare(
    `UPDATE runs
     SET events_json = ?, drafted_count = ?, sent_count = ?, error_count = ?
     WHERE id = ?`,
  ).run(JSON.stringify(events), drafted, sent, errors, input.runId);
}

/**
 * Terminal write for a run that finished on its own. Cancellation goes
 * through `cancelRun` instead. It is the only writer of 'cancelled', so a
 * cancelled row can never exist without the reason that explains it.
 */
export function markRunComplete(
  db: Database,
  input: { runId: number; status: "done" | "interrupted"; sentEmails?: string[] },
): void {
  const completedAt = new Date().toISOString();
  db.prepare(
    `UPDATE runs
     SET status = ?, completed_at = ?, prospect_emails_json = ?
     WHERE id = ? AND status = 'running'`,
  ).run(input.status, completedAt, JSON.stringify(input.sentEmails ?? []), input.runId);
}

/**
 * Overwrite the run's record of which prospects it actually emailed, in any
 * status. Deliberately not CASed on 'running': a cancelled run's last sends
 * land after the row went terminal (the play's workers finish one by one),
 * and the /cadences?sinceRun deep-link needs them.
 */
export function setRunSentEmails(
  db: Database,
  input: { runId: number; sentEmails: string[] },
): void {
  db.prepare(`UPDATE runs SET prospect_emails_json = ? WHERE id = ?`).run(
    JSON.stringify(input.sentEmails),
    input.runId,
  );
}

/**
 * Flip a still-'running' row to the terminal 'cancelled' state with the
 * reason it ended. CAS on `status = 'running'` makes this a no-op for a run
 * that already finished, so it races safely with
 * the SSE handler's own completion write. `sentEmails` records what did go
 * out before the abort, keeping the /cadences?sinceRun deep-link honest.
 *
 * Returns whether this call was the one that cancelled it, plus the row's
 * status afterwards (null when there is no such run).
 */
export function cancelRun(
  db: Database,
  input: { runId: number; reason: string; sentEmails?: string[] },
): { cancelled: boolean; status: "running" | "done" | "interrupted" | "cancelled" | null } {
  // Sent-email bookkeeping is deliberately outside the CAS below: the cancel
  // route may have flipped the row already by the time the SSE handler
  // unwinds, and the emails it collected still belong on the record. Only
  // that handler passes `sentEmails`, so the two callers can't clobber
  // each other whichever order they land in.
  if (input.sentEmails) setRunSentEmails(db, { runId: input.runId, sentEmails: input.sentEmails });
  const completedAt = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE runs
       SET status = 'cancelled', completed_at = ?, cancel_reason = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(completedAt, input.reason, input.runId);
  const row = db.query(`SELECT status FROM runs WHERE id = ?`).get(input.runId) as {
    status: "running" | "done" | "interrupted" | "cancelled";
  } | null;
  return { cancelled: result.changes > 0, status: row?.status ?? null };
}

export function getRun(db: Database, runId: number): RunRecord | null {
  const row = db.query(`SELECT * FROM runs WHERE id = ?`).get(runId) as {
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
 * Compact run listing for dashboards. Returns lightweight columns only:
 * `events_json` + `targets_json` stay on the row but aren't read here so
 * `/api/home` doesn't pay to ship them on every 30s poll. Default order:
 * newest started_at first; capped at `limit` rows (default 5). When
 * `status` is set, filters via the existing `idx_runs_status` index.
 */
export function listRuns(
  db: Database,
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
  const rows = db
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
 * (or any non-null when 0, for cold-boot recovery). Marks them as
 * 'interrupted' so the UI shows a truthful banner instead of an eternal
 * spinner. Returns the swept rows so the caller can log them.
 *
 * Terminal rows (including 'cancelled') are never touched: a run the user
 * cancelled must not be relabelled as a crash by the next cold boot.
 */
export function sweepStaleRuns(
  db: Database,
  input: { now: Date; maxAgeMs: number },
): Array<{ id: number; playName: string; startedAt: string; ageMs: number }> {
  const cutoffMs = input.now.getTime() - input.maxAgeMs;
  const rows = db
    .query(`SELECT id, play_name, started_at FROM runs WHERE status = 'running'`)
    .all() as Array<{
    id: number;
    play_name: string;
    started_at: string;
  }>;
  const swept: Array<{ id: number; playName: string; startedAt: string; ageMs: number }> = [];
  const update = db.prepare(
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
    swept.push({ id: row.id, playName: row.play_name, startedAt: row.started_at, ageMs });
  }
  return swept;
}
