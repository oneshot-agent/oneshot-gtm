import type { Database } from "bun:sqlite";
import type { TriggerRow } from "./types.ts";
import { claimMarker } from "./ledger-markers.ts";

/**
 * `triggers` table persistence over a raw Database handle: finder config,
 * enable state, poll bookkeeping, and the in-flight running-claim marker.
 * Extracted from `Ledger` (issue #751); `Ledger` delegates every trigger
 * method here unchanged.
 */

export function upsertTrigger(
  db: Database,
  input: { name: string; configJson: string; enabled?: boolean },
): void {
  db.prepare(
    `INSERT INTO triggers(name, enabled, config_json)
     VALUES(?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       enabled = excluded.enabled,
       config_json = excluded.config_json`,
  ).run(input.name, input.enabled === false ? 0 : 1, input.configJson);
}

export function getTrigger(db: Database, name: string): TriggerRow | null {
  return (db.query("SELECT * FROM triggers WHERE name = ?").get(name) as TriggerRow) ?? null;
}

export function listTriggers(db: Database): TriggerRow[] {
  return db.query("SELECT * FROM triggers ORDER BY name ASC").all() as TriggerRow[];
}

/**
 * Records the result of a finished run AND clears `running_started_at` in
 * the same statement. This is the only "completed" path. Both success and
 * caught-finder-throw funnel through here, so clearing the in-flight flag
 * here is the right semantic. Also steps `company_batch_seq` by 1 (issue
 * #708 correction). The rotation cursor `companyBatchCursorFor` reads,
 * so the starting company batch advances by exactly one index every
 * completed run, unlike `last_polled_at`'s wall-clock value whose modulo
 * can repeat.
 */
export function updateTriggerLastPoll(
  db: Database,
  input: { name: string; summary: unknown },
): void {
  db.prepare(
    `UPDATE triggers
     SET last_polled_at = ?, last_run_summary = ?, running_started_at = NULL,
         company_batch_seq = company_batch_seq + 1
     WHERE name = ?`,
  ).run(new Date().toISOString(), JSON.stringify(input.summary), input.name);
}

/**
 * Release a trigger's in-flight claim WITHOUT stamping `last_polled_at`
 * (issue #481 review finding). Used only when the finder never actually
 * ran: currently the daily spend ceiling refusal branches in
 * `registry.ts`. `updateTriggerLastPoll` would treat the refusal as a
 * completed poll and push `dueAt` a full interval into the future, so a
 * trigger blocked by the ceiling would sit unpolled long after headroom
 * (or a new day) opens back up. `last_run_summary` still records the
 * refusal reason so the dashboard/doctor surface it, same as before.
 */
export function clearTriggerClaim(db: Database, input: { name: string; summary: unknown }): void {
  db.prepare(
    `UPDATE triggers
     SET last_run_summary = ?, running_started_at = NULL
     WHERE name = ?`,
  ).run(JSON.stringify(input.summary), input.name);
}

/**
 * Atomic claim: marks a trigger in-flight only if not already running. The
 * conditional UPDATE closes the TOCTOU race where two fireTriggerNow calls
 * both fire and double-spend. `staleCutoffIso` also lets the claim succeed
 * over a stale marker so a dead row doesn't 409 until the next cold boot.
 * Cleared by updateTriggerLastPoll or sweepStaleRunningTriggers.
 */
export function markTriggerRunning(
  db: Database,
  name: string,
  startedAtIso: string,
  staleCutoffIso?: string,
): boolean {
  return claimMarker(db, {
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
export function sweepStaleRunningTriggers(
  db: Database,
  input: { now: Date; maxAgeMs: number },
): Array<{ name: string; startedAt: string; ageMs: number }> {
  const cutoffMs = input.now.getTime() - input.maxAgeMs;
  const rows = db
    .query(`SELECT name, running_started_at FROM triggers WHERE running_started_at IS NOT NULL`)
    .all() as Array<{ name: string; running_started_at: string }>;
  const swept: Array<{ name: string; startedAt: string; ageMs: number }> = [];
  const update = db.prepare(
    `UPDATE triggers
     SET last_polled_at = ?, last_run_summary = ?, running_started_at = NULL
     WHERE name = ?`,
  );
  for (const row of rows) {
    const startedMs = new Date(row.running_started_at).getTime();
    if (!Number.isFinite(startedMs)) {
      // Garbage timestamp: clear it so it doesn't perpetually re-trip.
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

export function setTriggerEnabled(db: Database, name: string, enabled: boolean): void {
  db.prepare(`UPDATE triggers SET enabled = ? WHERE name = ?`).run(enabled ? 1 : 0, name);
}

export function setTriggerConfig(db: Database, name: string, configJson: string): void {
  db.prepare(`UPDATE triggers SET config_json = ? WHERE name = ?`).run(configJson, name);
}

/**
 * Apply a batch of trigger config writes atomically: insert a fresh
 * enabled row for a trigger with no stored config, or update an existing
 * row's config and enable it, for every entry in ONE transaction. Used by
 * the packs apply route: `applyPackRoute` previously ran each trigger's
 * upsert/update pair outside a transaction, so a later write throwing left
 * earlier writes in the batch persisted and the route returned a 500 with
 * a half-applied pack (finding PRRT_kwDOSKzrBs6fCBct). A throw here rolls
 * back every write in the batch, not just the failing one.
 */
export function applyTriggerConfigs(
  db: Database,
  entries: Array<{ name: string; configJson: string }>,
): void {
  const upsert = db.prepare(
    `INSERT INTO triggers(name, enabled, config_json)
     VALUES(?, 1, ?)
     ON CONFLICT(name) DO UPDATE SET
       enabled = 1,
       config_json = excluded.config_json`,
  );
  const tx = db.transaction(() => {
    for (const entry of entries) upsert.run(entry.name, entry.configJson);
  });
  tx();
}
