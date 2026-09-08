import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Ledger, workspaceNameForHome } from "@oneshot-gtm/core";
import { buildDemoDataset, type DemoDataset } from "./dataset.ts";

/** Written into every demo home. `demo reset` refuses to delete a dir without it. */
export const DEMO_MARKER = ".demo-home";

export const DEFAULT_DEMO_HOME = join(homedir(), ".oneshot-gtm-demo");

/** The real install. Seeding into it would overwrite a working config and ledger. */
function realHome(): string {
  return join(homedir(), ".oneshot-gtm");
}

/**
 * Resolve a path with symlinks followed, not just lexically — `resolve()`
 * alone would let a symlinked `--home` (or a symlinked parent) slip past the
 * guards below and write into the real install. Nonexistent paths canonicalize
 * via the nearest existing ancestor plus the remainder.
 */
export function canonicalize(p: string): string {
  let base = resolve(p);
  const tail: string[] = [];
  while (!existsSync(base)) {
    const parent = dirname(base);
    if (parent === base) break;
    tail.unshift(basename(base));
    base = parent;
  }
  const real = existsSync(base) ? realpathSync(base) : base;
  return tail.length > 0 ? join(real, ...tail) : real;
}

export class DemoSeedError extends Error {}

/**
 * Every table a seed touches, cleared before it writes. Includes the caches and
 * retry queues the demo never populates — leftovers there would let a stale
 * enrichment or a pending candidate from an earlier run surface on screen.
 */
const SEEDED_TABLES = [
  "receipts",
  "prospects",
  "sequence_events",
  "interviews",
  "cadence_state",
  "deal_outcomes",
  "target_queue",
  "triggers",
  "enrichment_cache",
  "linkedin_lookup_cache",
  "runs",
  "sender_assignments",
  "inbox_drafts",
  "inbox_sent",
  "pending_resolution",
  "bounces",
  "canary_results",
] as const;

export interface SeedResult {
  home: string;
  anchor: Date;
  counts: Record<string, number>;
}

/**
 * Build a complete, self-contained demo install at `home`. Deliberately avoids
 * `saveConfig()`/`getLedger()` — CONFIG_DIR is captured at module load and
 * points at the founder's REAL home, which the demo must never touch; all
 * writes go through explicit paths.
 */
export function seedDemoHome(opts: { home?: string; anchor?: Date; force?: boolean }): SeedResult {
  // Canonical (symlink-followed) on BOTH sides of every comparison, and used
  // for all writes below, so the guard and the writes refer to the same target.
  const home = canonicalize(opts.home ?? DEFAULT_DEMO_HOME);
  const anchor = opts.anchor ?? new Date();

  if (home === canonicalize(realHome())) {
    throw new DemoSeedError(
      `refusing to seed into your real install (${home}). Pass --home with a different directory.`,
    );
  }
  // Named workspaces are real installs too.
  const owner = workspaceNameForHome(home);
  if (owner) {
    throw new DemoSeedError(
      `refusing to seed into workspace '${owner}' (${home}). Pass --home with a different directory.`,
    );
  }
  if (process.env["ONESHOT_GTM_HOME"] && home === canonicalize(process.env["ONESHOT_GTM_HOME"])) {
    throw new DemoSeedError(
      `refusing to seed into the active ONESHOT_GTM_HOME (${home}). Pass --home with a different directory.`,
    );
  }

  const alreadySeeded = existsSync(join(home, DEMO_MARKER));
  if (existsSync(home) && readdirSync(home).length > 0 && !alreadySeeded && !opts.force) {
    throw new DemoSeedError(
      `${home} is not empty and has no ${DEMO_MARKER} marker. Re-run with --force to overwrite it.`,
    );
  }

  const data = buildDemoDataset(anchor);

  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, "demo"), { recursive: true });

  const dbPath = join(home, "ledger.sqlite");

  writeFileSync(join(home, "config.json"), `${JSON.stringify(data.config, null, 2)}\n`);

  const env = Object.entries(data.secrets)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  writeFileSync(
    join(home, ".env"),
    `# Demo install — these are placeholders and cannot authenticate.\n${env}\n`,
  );
  chmodSync(join(home, ".env"), 0o600);

  for (const [name, value] of Object.entries(data.fixtures)) {
    writeFileSync(join(home, "demo", name), `${JSON.stringify(value, null, 2)}\n`);
  }

  writeFileSync(
    join(home, DEMO_MARKER),
    `seeded by oneshot-gtm demo seed\nanchor=${anchor.toISOString()}\n`,
  );

  const counts = writeLedger(dbPath, data);

  return { home, anchor, counts };
}

/**
 * Open the ledger once through `Ledger` so `migrate()` builds the real schema,
 * then write rows with raw SQL — required because `datetime('now')` column
 * DEFAULTs can't be backdated through any public method. A re-seed truncates
 * tables rather than deleting the file, so a dashboard's open handle survives
 * and a mid-session re-seed only needs a browser refresh.
 */
function writeLedger(dbPath: string, data: DemoDataset): Record<string, number> {
  const migrator = new Ledger(dbPath);
  migrator.close();

  const db = new Database(dbPath);
  const counts: Record<string, number> = {};

  try {
    db.exec("BEGIN");

    for (const table of SEEDED_TABLES) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    // Reset AUTOINCREMENT counters so a re-seed reproduces the same row ids —
    // receipt #5 has to stay receipt #5 across takes.
    db.prepare(
      `DELETE FROM sqlite_sequence WHERE name IN (${SEEDED_TABLES.map(() => "?").join(", ")})`,
    ).run(...SEEDED_TABLES);

    // `title` is its own column and not only a dossier field: the cadence and
    // queue views read `prospects.title`, so omitting it here rendered every
    // seeded row as "Role unknown" while the dossier held the real one.
    const insertProspect = db.prepare(
      `INSERT INTO prospects (id, name, email, company, title, linkedin_url, dossier_json, source, source_profile_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of data.prospects) {
      insertProspect.run(
        p.id,
        p.name,
        p.email,
        p.company,
        p.title,
        p.linkedinUrl,
        p.dossierJson,
        p.source,
        p.sourceProfileUrl,
        p.createdAt,
      );
    }
    counts["prospects"] = data.prospects.length;

    const insertReceipt = db.prepare(
      `INSERT INTO receipts (id, play_name, call_type, cost_usd, signed_receipt, oneshot_request_id, sender_identity, memo, decision_context, value_tag, value_tagged_at, goal_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of data.receipts) {
      insertReceipt.run(
        r.id,
        r.playName,
        r.callType,
        r.costUsd,
        JSON.stringify(r.signedReceipt),
        r.oneshotRequestId,
        r.senderIdentity,
        r.memo,
        JSON.stringify(r.decisionContext),
        r.valueTag ? JSON.stringify(r.valueTag) : null,
        r.valueTag ? r.valueTaggedAt : null,
        r.goalId,
        r.createdAt,
      );
    }
    counts["receipts"] = data.receipts.length;

    const insertEvent = db.prepare(
      `INSERT INTO sequence_events (prospect_id, play_name, step_index, channel, status, metadata_json, receipt_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of data.sequenceEvents) {
      insertEvent.run(
        e.prospectId,
        e.playName,
        e.stepIndex,
        e.channel,
        e.status,
        e.metadataJson,
        e.receiptId,
        e.createdAt,
      );
    }
    counts["sequence_events"] = data.sequenceEvents.length;

    const insertCadence = db.prepare(
      `INSERT INTO cadence_state (prospect_id, play_name, current_step, status, enrolled_at, next_due_at, next_step_draft_json, next_step_drafted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of data.cadences) {
      insertCadence.run(
        c.prospectId,
        c.playName,
        c.currentStep,
        c.status,
        c.enrolledAt,
        c.nextDueAt,
        c.nextStepDraftJson,
        c.nextStepDraftedAt,
      );
    }
    counts["cadence_state"] = data.cadences.length;

    const insertOutcome = db.prepare(
      `INSERT INTO deal_outcomes (prospect_id, play_name, outcome, amount_usd, notes, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const o of data.outcomes) {
      insertOutcome.run(o.prospectId, o.playName, o.outcome, o.amountUsd, o.notes, o.recordedAt);
    }
    counts["deal_outcomes"] = data.outcomes.length;

    const insertQueue = db.prepare(
      `INSERT INTO target_queue (play_name, payload_json, dedupe_key, source, status, found_at, reviewed_at, sent_at, notes, prospect_id, last_draft_json, last_drafted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const q of data.queue) {
      insertQueue.run(
        q.playName,
        q.payloadJson,
        q.dedupeKey,
        q.source,
        q.status,
        q.foundAt,
        q.reviewedAt,
        q.sentAt,
        q.notes,
        q.prospectId,
        q.lastDraftJson,
        q.lastDraftedAt,
      );
    }
    counts["target_queue"] = data.queue.length;

    const insertTrigger = db.prepare(
      `INSERT INTO triggers (name, last_polled_at, last_run_summary, enabled, config_json, running_started_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    );
    for (const t of data.triggers) {
      insertTrigger.run(t.name, t.lastPolledAt, t.lastRunSummary, t.enabled, t.configJson);
    }
    counts["triggers"] = data.triggers.length;

    const insertRun = db.prepare(
      `INSERT INTO runs (play_name, dry_run, status, started_at, completed_at, target_count, drafted_count, sent_count, error_count, targets_json, events_json, prospect_emails_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of data.runs) {
      insertRun.run(
        r.playName,
        r.dryRun,
        r.status,
        r.startedAt,
        r.completedAt,
        r.targetCount,
        r.draftedCount,
        r.sentCount,
        r.errorCount,
        r.targetsJson,
        r.eventsJson,
        r.prospectEmailsJson,
      );
    }
    counts["runs"] = data.runs.length;

    const insertBounce = db.prepare(
      `INSERT INTO bounces (message_id, recipient, identity_id, kind, status_code, diagnostic, prospect_id, bounced_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const b of data.bounces) {
      insertBounce.run(
        b.messageId,
        b.recipient,
        b.identityId,
        b.kind,
        b.statusCode,
        b.diagnostic,
        b.prospectId,
        b.bouncedAt,
        b.createdAt,
      );
    }
    counts["bounces"] = data.bounces.length;

    const insertCanary = db.prepare(
      `INSERT INTO canary_results (from_identity, to_identity, placement, labels_json, spf, dkim, dmarc, subject, source_play, same_domain, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of data.canaries) {
      insertCanary.run(
        c.fromIdentity,
        c.toIdentity,
        c.placement,
        c.labelsJson,
        c.spf,
        c.dkim,
        c.dmarc,
        c.subject,
        c.sourcePlay,
        c.sameDomain,
        c.latencyMs,
        c.createdAt,
      );
    }
    counts["canary_results"] = data.canaries.length;

    const insertAssignment = db.prepare(
      `INSERT INTO sender_assignments (email, identity_id, assigned_at) VALUES (?, ?, ?)`,
    );
    for (const a of data.senderAssignments) {
      insertAssignment.run(a.email, a.identityId, a.assignedAt);
    }
    counts["sender_assignments"] = data.senderAssignments.length;

    const insertDraft = db.prepare(
      `INSERT INTO inbox_drafts (thread_key, inbound_email_id, to_email, subject, identity_id, body, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const d of data.inboxDrafts) {
      insertDraft.run(
        d.threadKey,
        d.inboundEmailId,
        d.toEmail,
        d.subject,
        d.identityId,
        d.body,
        d.updatedAt,
      );
    }
    counts["inbox_drafts"] = data.inboxDrafts.length;

    const insertSent = db.prepare(
      `INSERT INTO inbox_sent (thread_key, to_email, subject, body, identity_id, request_id, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of data.inboxSent) {
      insertSent.run(
        s.threadKey,
        s.toEmail,
        s.subject,
        s.body,
        s.identityId,
        s.requestId,
        s.sentAt,
      );
    }
    counts["inbox_sent"] = data.inboxSent.length;

    const insertInterview = db.prepare(
      `INSERT INTO interviews (person, transcript_path, jtbd, pain_quotes_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const iv of data.interviews) {
      insertInterview.run(iv.person, iv.transcriptPath, iv.jtbd, iv.painQuotesJson, iv.createdAt);
    }
    counts["interviews"] = data.interviews.length;

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.close();
  }

  return counts;
}

/** Remove a seeded demo home. Refuses anything without the marker file. */
export function resetDemoHome(home: string): void {
  const dir = canonicalize(home);
  if (!existsSync(dir)) return;
  if (!existsSync(join(dir, DEMO_MARKER))) {
    throw new DemoSeedError(
      `${dir} has no ${DEMO_MARKER} marker — refusing to delete a directory this command didn't create.`,
    );
  }
  rmSync(dir, { recursive: true, force: true });
}
