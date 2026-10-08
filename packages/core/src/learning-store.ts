import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type {
  LearningChannel,
  LearningEvidence,
  LearningGuidanceStatus,
  LearningGuidanceView,
  LearningKind,
  LearningProposalStatus,
  LearningProposalView,
  LearningScope,
  LearningStage,
} from "@oneshot-gtm/shared-types";

/**
 * Unified learning proposals (issue #813). One ledger-resident store for
 * every learned change the founder must approve — writing preferences,
 * prospect angles, campaign angle sets and the ICP one-liner — plus the
 * guidance rows that approved preferences become, and the lease/cooldown
 * state of the background jobs that generate proposals.
 *
 * Active values keep living where they always did (config.icpOneLiner, a
 * trigger's `yourEdge`, `prospects.angle_json`, `learning_guidance`): a
 * proposal only holds the before (`current`, for rollback) and the after
 * (`proposed`), and a `baseline_key` fingerprint of the before so an
 * approval against a value that has since moved is refused. Tables are
 * created by `ledger-schema.ts` migration v13.
 */

interface ProposalRow {
  id: string;
  kind: LearningKind;
  scope_json: string;
  scope_key: string;
  current_json: string | null;
  proposed_json: string;
  evidence_json: string;
  evidence_summary: string;
  baseline_key: string;
  dedupe_key: string;
  status: LearningProposalStatus;
  legacy: number;
  source_version: number | null;
  created_at: string;
  decided_at: string | null;
  decided_json: string | null;
  applied_at: string | null;
  rolled_back_at: string | null;
}

interface GuidanceRow {
  id: string;
  instruction: string;
  source: LearningGuidanceView["source"];
  channel: LearningChannel | null;
  stage: LearningStage | null;
  proposal_id: string | null;
  evidence_json: string;
  status: LearningGuidanceStatus;
  approved_at: string;
  updated_at: string;
}

export interface LearningJobState {
  kind: string;
  attempted_ms: number;
  token: string | null;
  until_ms: number;
  watermark: number;
  refreshed_at: string | null;
  error: string | null;
}

/** A human-sent draft and the machine drafts the founder rejected for the same slot. */
export interface DraftObservation {
  id: number;
  playName: string;
  prospectKey: string;
  prospectId: number | null;
  stepIndex: number;
  stage: Extract<LearningStage, "first_touch" | "follow_up">;
  channel: string;
  subject: string;
  body: string;
  /** Earlier versions of the same slot discarded with reason `regenerate` (text rejected, angle kept). */
  rejected: Array<{ id: number; subject: string; body: string }>;
  closedAt: string | null;
}

/** Active guidance per workspace, mirroring v1's twelve-preference ceiling. */
export const MAX_ENABLED_GUIDANCE = 12;

/** Lower-cased, punctuation collapsed: the identity of a learned text. */
export function normalizeLearnedText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Short stable fingerprint of a value, for baseline and guidance keys. */
export function learningKeyOf(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

/** The scope a proposal competes within for staleness: one prospect, one play, one ICP. */
export function learningScopeKey(kind: LearningKind, scope: LearningScope): string {
  switch (kind) {
    case "prospect_angle":
      return scope.prospectId != null ? `prospect:${scope.prospectId}` : "";
    case "campaign_angle":
      return scope.playName ? `play:${scope.playName}` : "";
    case "preference":
      return `pref:${scope.channel ?? "any"}:${scope.stage ?? "any"}`;
    case "icp":
      return "";
  }
}

const parse = <T>(raw: string | null, fallback: T): T => {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

function toProposalView(row: ProposalRow): LearningProposalView {
  return {
    id: row.id,
    kind: row.kind,
    scope: parse<LearningScope>(row.scope_json, {}),
    current: parse<unknown>(row.current_json, null),
    proposed: parse<unknown>(row.proposed_json, null),
    evidence: parse<LearningEvidence>(row.evidence_json, { refs: [] }),
    evidenceSummary: row.evidence_summary,
    baselineKey: row.baseline_key,
    dedupeKey: row.dedupe_key,
    status: row.status,
    legacy: row.legacy === 1,
    sourceVersion: row.source_version,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decided: parse<unknown>(row.decided_json, null),
    appliedAt: row.applied_at,
    rolledBackAt: row.rolled_back_at,
  };
}

function toGuidanceView(row: GuidanceRow): LearningGuidanceView {
  return {
    id: row.id,
    instruction: row.instruction,
    source: row.source,
    channel: row.channel,
    stage: row.stage,
    proposalId: row.proposal_id,
    evidence: parse<LearningEvidence>(row.evidence_json, { refs: [] }),
    status: row.status,
    approvedAt: row.approved_at,
    updatedAt: row.updated_at,
  };
}

export class LearningStore {
  constructor(readonly db: Database) {}

  // ---- proposals --------------------------------------------------------

  /**
   * Record a proposal. Returns null when an identical pending proposal
   * (same kind and dedupe key) already exists: the partial unique index on
   * pending rows makes a retried generation idempotent.
   */
  insert(input: {
    kind: LearningKind;
    scope?: LearningScope;
    current: unknown;
    proposed: unknown;
    evidence: LearningEvidence;
    evidenceSummary: string;
    baselineKey: string;
    dedupeKey: string;
    legacy?: boolean;
    sourceVersion?: number;
    createdAt?: string;
  }): LearningProposalView | null {
    const id = randomUUID();
    const scope = input.scope ?? {};
    try {
      this.db
        .query(
          `INSERT INTO learning_proposals(
             id, kind, scope_json, scope_key, current_json, proposed_json, evidence_json,
             evidence_summary, baseline_key, dedupe_key, status, legacy, source_version, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`,
        )
        .run(
          id,
          input.kind,
          JSON.stringify(scope),
          learningScopeKey(input.kind, scope),
          input.current === undefined ? null : JSON.stringify(input.current),
          JSON.stringify(input.proposed),
          JSON.stringify(input.evidence),
          input.evidenceSummary,
          input.baselineKey,
          input.dedupeKey,
          input.legacy ? 1 : 0,
          input.sourceVersion ?? null,
          input.createdAt ?? new Date().toISOString(),
        );
    } catch (err) {
      if (/UNIQUE constraint failed/i.test((err as Error).message ?? "")) return null;
      throw err;
    }
    return toProposalView(this.row(id)!);
  }

  private row(id: string): ProposalRow | null {
    return this.db
      .query<ProposalRow, [string]>("SELECT * FROM learning_proposals WHERE id=?")
      .get(id);
  }

  get(id: string): LearningProposalView | null {
    const row = this.row(id);
    return row ? toProposalView(row) : null;
  }

  list(
    filter: {
      kind?: LearningKind;
      status?: LearningProposalStatus | "all";
      prospectId?: number;
      playName?: string;
      limit?: number;
    } = {},
  ): LearningProposalView[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filter.kind) {
      where.push("kind=?");
      args.push(filter.kind);
    }
    if (filter.status && filter.status !== "all") {
      where.push("status=?");
      args.push(filter.status);
    }
    if (filter.prospectId != null) {
      where.push("json_extract(scope_json,'$.prospectId')=?");
      args.push(filter.prospectId);
    }
    if (filter.playName) {
      where.push("json_extract(scope_json,'$.playName')=?");
      args.push(filter.playName);
    }
    const sql = `SELECT * FROM learning_proposals${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, rowid DESC${filter.limit ? ` LIMIT ${Math.max(1, Math.floor(filter.limit))}` : ""}`;
    return this.db
      .query<ProposalRow, Array<string | number>>(sql)
      .all(...args)
      .map(toProposalView);
  }

  hasPendingDuplicate(kind: LearningKind, dedupeKey: string): boolean {
    return !!this.db
      .query("SELECT 1 FROM learning_proposals WHERE kind=? AND dedupe_key=? AND status='pending'")
      .get(kind, dedupeKey);
  }

  /**
   * True when the most recently decided proposal of this kind (and scope,
   * when given) — of ANY text — was a dismissal of this dedupe key. A
   * dismissal is a decision, not silence: the same text must not recur on
   * the very next tick, but the ban lifts once any later decision lands, so
   * evidence that has moved on can bring the text back. Filtering by text
   * first would make the ban permanent (see v1's `wasJustDismissed`).
   */
  wasJustDismissed(kind: LearningKind, dedupeKey: string, scopeKey?: string): boolean {
    const latest = this.db
      .query<{ dedupe_key: string; status: LearningProposalStatus }, Array<string>>(
        `SELECT dedupe_key, status FROM learning_proposals
          WHERE kind=? AND decided_at IS NOT NULL${scopeKey !== undefined ? " AND scope_key=?" : ""}
          ORDER BY decided_at DESC, rowid DESC LIMIT 1`,
      )
      .get(...(scopeKey !== undefined ? [kind, scopeKey] : [kind]));
    if (!latest || (latest.status !== "dismissed" && latest.status !== "stale")) return false;
    return latest.dedupe_key === dedupeKey;
  }

  /**
   * Flip a PENDING proposal to approved or dismissed. The UPDATE's own
   * `WHERE status='pending'` runs under the write lock, so a racing second
   * decision loses. `decided` is the founder's edited value on an
   * edit-and-approve; it is what the apply step writes, never `proposed`.
   */
  decide(
    id: string,
    status: "approved" | "dismissed",
    now: string,
    decided?: unknown,
  ): { view: LearningProposalView } | { error: string } {
    const existing = this.row(id);
    if (!existing) return { error: `proposal '${id}' not found` };
    const changes = this.db
      .query(
        "UPDATE learning_proposals SET status=?, decided_at=?, decided_json=? WHERE id=? AND status='pending'",
      )
      .run(status, now, decided === undefined ? null : JSON.stringify(decided), id).changes;
    if (changes === 0) return { error: `proposal '${id}' was already ${existing.status}` };
    return { view: toProposalView(this.row(id)!) };
  }

  /** Compensation when applying an approval failed: the decision never took effect. */
  revertToPending(id: string): void {
    this.db
      .query(
        "UPDATE learning_proposals SET status='pending', decided_at=NULL, decided_json=NULL, applied_at=NULL WHERE id=?",
      )
      .run(id);
  }

  markApplied(id: string, now: string): void {
    this.db.query("UPDATE learning_proposals SET applied_at=? WHERE id=?").run(now, id);
  }

  /**
   * After an approval changes the active value of a scope, every other
   * pending proposal in that scope was computed against the baseline just
   * replaced and can no longer be approved as-is. Marking them `stale`
   * (rather than deleting) keeps the record and lets `wasJustDismissed`
   * treat them like a dismissal. Returns the number of rows marked.
   */
  markStale(kind: LearningKind, scopeKey: string, now: string, exceptId?: string): number {
    return this.db
      .query(
        `UPDATE learning_proposals SET status='stale', decided_at=?
          WHERE kind=? AND scope_key=? AND status='pending'${exceptId ? " AND id<>?" : ""}`,
      )
      .run(...(exceptId ? [now, kind, scopeKey, exceptId] : [now, kind, scopeKey])).changes;
  }

  /** An approved proposal the founder reverted; the caller restores `current`. */
  rollback(id: string, now: string): { view: LearningProposalView } | { error: string } {
    const existing = this.row(id);
    if (!existing) return { error: `proposal '${id}' not found` };
    const changes = this.db
      .query(
        "UPDATE learning_proposals SET status='rolled_back', rolled_back_at=? WHERE id=? AND status='approved'",
      )
      .run(now, id).changes;
    if (changes === 0) return { error: `proposal '${id}' is ${existing.status}, not approved` };
    return { view: toProposalView(this.row(id)!) };
  }

  // ---- guidance (approved writing preferences) -----------------------------

  private guidanceRows(includeInactive: boolean): GuidanceRow[] {
    return this.db
      .query<GuidanceRow, []>(
        `SELECT * FROM learning_guidance${includeInactive ? "" : " WHERE status='enabled'"} ORDER BY approved_at, rowid`,
      )
      .all();
  }

  private enabledGuidanceCount(): number {
    return (
      this.db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM learning_guidance WHERE status='enabled'",
        )
        .get()?.n ?? 0
    );
  }

  guidanceVersion(): number {
    this.db.query("INSERT OR IGNORE INTO learning_state(id) VALUES(1)").run();
    return (
      this.db
        .query<{ guidance_version: number }, []>(
          "SELECT guidance_version FROM learning_state WHERE id=1",
        )
        .get()?.guidance_version ?? 0
    );
  }

  private bumpGuidanceVersion(): void {
    this.db.query("INSERT OR IGNORE INTO learning_state(id) VALUES(1)").run();
    this.db.query("UPDATE learning_state SET guidance_version=guidance_version+1 WHERE id=1").run();
  }

  /**
   * The enabled instructions that apply to a draft on this channel and
   * stage: rows scoped to it plus rows with no scope. A filter left out
   * matches every row. At most `MAX_ENABLED_GUIDANCE`, oldest approval
   * first. `key` fingerprints the exact set a draft was written with.
   */
  guidance(filter: { channel?: LearningChannel; stage?: LearningStage } = {}): {
    version: number;
    key: string | null;
    instructions: Array<{ id: string; instruction: string }>;
  } {
    const rows = this.guidanceRows(false).filter(
      (r) =>
        (filter.channel === undefined || r.channel === null || r.channel === filter.channel) &&
        (filter.stage === undefined || r.stage === null || r.stage === filter.stage),
    );
    const instructions = rows
      .slice(0, MAX_ENABLED_GUIDANCE)
      .map((r) => ({ id: r.id, instruction: r.instruction }));
    const version = this.guidanceVersion();
    return {
      version,
      key: instructions.length
        ? learningKeyOf(`${version}:${instructions.map((i) => i.id).join(",")}`)
        : null,
      instructions,
    };
  }

  listGuidance(includeInactive = false): LearningGuidanceView[] {
    return this.guidanceRows(includeInactive).map(toGuidanceView);
  }

  getGuidance(id: string): LearningGuidanceView | null {
    const row = this.db
      .query<GuidanceRow, [string]>("SELECT * FROM learning_guidance WHERE id=?")
      .get(id);
    return row ? toGuidanceView(row) : null;
  }

  /** Approved preference → active guidance. Throws at the enabled ceiling. */
  addGuidance(input: {
    id?: string;
    instruction: string;
    source: LearningGuidanceView["source"];
    channel?: LearningChannel | null;
    stage?: LearningStage | null;
    proposalId?: string | null;
    evidence?: LearningEvidence;
    now?: string;
  }): LearningGuidanceView {
    return this.db
      .transaction(() => {
        if (this.enabledGuidanceCount() >= MAX_ENABLED_GUIDANCE)
          throw new Error(
            `Disable another preference first (${MAX_ENABLED_GUIDANCE} active maximum)`,
          );
        const id = input.id ?? randomUUID();
        const now = input.now ?? new Date().toISOString();
        this.db
          .query(
            `INSERT INTO learning_guidance(id, instruction, source, channel, stage, proposal_id, evidence_json, status, approved_at, updated_at)
             VALUES (?,?,?,?,?,?,?,'enabled',?,?)`,
          )
          .run(
            id,
            input.instruction.trim(),
            input.source,
            input.channel ?? null,
            input.stage ?? null,
            input.proposalId ?? null,
            JSON.stringify(input.evidence ?? { refs: [] }),
            now,
            now,
          );
        this.bumpGuidanceVersion();
        return this.getGuidance(id)!;
      })
      .immediate();
  }

  /** Founder toggle. Re-enabling counts against the ceiling like a new row. */
  setGuidanceEnabled(id: string, enabled: boolean, now = new Date().toISOString()): void {
    this.db
      .transaction(() => {
        const row = this.db
          .query<GuidanceRow, [string]>("SELECT * FROM learning_guidance WHERE id=?")
          .get(id);
        if (!row) throw new Error("Learned preference not found");
        if (row.status === "rolled_back")
          throw new Error("A rolled-back preference cannot be re-enabled");
        if (
          enabled &&
          row.status !== "enabled" &&
          this.enabledGuidanceCount() >= MAX_ENABLED_GUIDANCE
        )
          throw new Error(
            `Disable another preference first (${MAX_ENABLED_GUIDANCE} active maximum)`,
          );
        this.db
          .query("UPDATE learning_guidance SET status=?, updated_at=? WHERE id=?")
          .run(enabled ? "enabled" : "disabled", now, id);
        this.bumpGuidanceVersion();
      })
      .immediate();
  }

  /** Revert an approved preference: it stops applying and cannot be re-enabled. */
  rollbackGuidance(id: string, now = new Date().toISOString()): boolean {
    return this.db
      .transaction(() => {
        const changes = this.db
          .query(
            "UPDATE learning_guidance SET status='rolled_back', updated_at=? WHERE id=? AND status<>'rolled_back'",
          )
          .run(now, id).changes;
        if (changes > 0) this.bumpGuidanceVersion();
        return changes > 0;
      })
      .immediate();
  }

  /** Normalized instruction texts the founder said no to (dismissed/stale/rolled back): never re-propose them. */
  excludedPreferenceTexts(limit = 50): string[] {
    const rows = this.db
      .query<{ proposed_json: string }, [number]>(
        `SELECT proposed_json FROM learning_proposals
          WHERE kind='preference' AND status IN ('dismissed','stale')
          ORDER BY decided_at DESC, rowid DESC LIMIT ?`,
      )
      .all(limit);
    const rolled = this.db
      .query<{ instruction: string }, [number]>(
        "SELECT instruction FROM learning_guidance WHERE status IN ('rolled_back','disabled') ORDER BY updated_at DESC LIMIT ?",
      )
      .all(limit);
    const texts = rows
      .map((r) => parse<{ instruction?: unknown }>(r.proposed_json, {}).instruction)
      .filter((t): t is string => typeof t === "string")
      .concat(rolled.map((r) => r.instruction));
    return [...new Set(texts.map(normalizeLearnedText))].filter(Boolean);
  }

  // ---- background job leases -----------------------------------------------

  jobState(kind: string): LearningJobState {
    this.db.query("INSERT OR IGNORE INTO learning_jobs(kind) VALUES(?)").run(kind);
    return this.db
      .query<LearningJobState, [string]>("SELECT * FROM learning_jobs WHERE kind=?")
      .get(kind)!;
  }

  /**
   * Take a job's lease, gated by an in-progress lease and a cooldown since
   * the last attempt (successful or not). Taking the lease stamps
   * `attempted_ms`, so the cooldown is spent whether or not a proposal is
   * produced — callers check their evidence floor first. Returns the token,
   * or null when another process holds the lease or the cooldown is live.
   */
  claimJob(
    kind: string,
    now: number,
    opts: { cooldownMs: number; leaseMs: number },
  ): string | null {
    const s = this.jobState(kind);
    if (s.until_ms > now) return null;
    if (s.attempted_ms && now - s.attempted_ms < opts.cooldownMs) return null;
    const token = randomUUID();
    this.db
      .query(
        `UPDATE learning_jobs SET token=?, until_ms=?, attempted_ms=?
          WHERE kind=? AND until_ms<=? AND (attempted_ms=0 OR ?-attempted_ms>=?)`,
      )
      .run(token, now + opts.leaseMs, now, kind, now, now, opts.cooldownMs);
    // Re-read: the guarded UPDATE is a no-op if another connection raced
    // this one; only re-reading tells us who actually won.
    return this.jobState(kind).token === token ? token : null;
  }

  /** Extend a live lease (a provider retry sequence) without reviving an expired one. */
  renewJob(kind: string, token: string, now: number, leaseMs: number): boolean {
    return (
      this.db
        .query("UPDATE learning_jobs SET until_ms=? WHERE kind=? AND token=? AND until_ms>?")
        .run(now + leaseMs, kind, token, now).changes > 0
    );
  }

  /** A completed run, successful or a deliberate no-op: release the lease, advance the watermark. */
  finishJob(
    kind: string,
    token: string,
    input: { watermark?: number; now?: string } = {},
  ): boolean {
    const refreshedAt = input.now ?? new Date().toISOString();
    return (
      this.db
        .query(
          `UPDATE learning_jobs SET token=NULL, until_ms=0, error=NULL, refreshed_at=?,
             watermark=COALESCE(?, watermark) WHERE kind=? AND token=?`,
        )
        .run(refreshedAt, input.watermark ?? null, kind, token).changes > 0
    );
  }

  /** A live lease clears without producing a proposal: retried after the cooldown. */
  failJob(kind: string, token: string, reason: string): void {
    this.db
      .query("UPDATE learning_jobs SET token=NULL, until_ms=0, error=? WHERE kind=? AND token=?")
      .run(reason, kind, token);
  }

  // ---- draft-derived evidence ---------------------------------------------------

  /**
   * Human-reviewed sends after `watermark` (a `draft_versions.id`), each with
   * the machine drafts the founder regenerated away from in the same slot.
   * Only `sent` counts: a drain send (`auto_sent`) was never judged, and a
   * `rotate` sibling rejected the angle rather than the text, so neither is
   * writing-style evidence.
   */
  draftObservationsSince(watermark: number, limit = 100): DraftObservation[] {
    const sent = this.db
      .query<
        {
          id: number;
          play_name: string;
          prospect_key: string;
          prospect_id: number | null;
          step_index: number;
          queue_id: number | null;
          channel: string;
          subject: string;
          body: string;
          closed_at: string | null;
        },
        [number, number]
      >(
        `SELECT id, play_name, prospect_key, prospect_id, step_index, queue_id, channel, subject, body, closed_at
           FROM draft_versions WHERE outcome='sent' AND id>? ORDER BY id LIMIT ?`,
      )
      .all(watermark, Math.max(1, Math.floor(limit)));
    const byQueue = this.db.query<{ id: number; subject: string; body: string }, [number, number]>(
      `SELECT id, subject, body FROM draft_versions
        WHERE queue_id=? AND id<? AND outcome='discarded' AND discard_reason='regenerate' ORDER BY id`,
    );
    const bySlot = this.db.query<
      { id: number; subject: string; body: string },
      [string, string, number, number]
    >(
      `SELECT id, subject, body FROM draft_versions
        WHERE prospect_key=? AND play_name=? AND step_index=? AND id<? AND queue_id IS NULL
          AND outcome='discarded' AND discard_reason='regenerate' ORDER BY id`,
    );
    return sent.map((row) => ({
      id: row.id,
      playName: row.play_name,
      prospectKey: row.prospect_key,
      prospectId: row.prospect_id,
      stepIndex: row.step_index,
      stage: row.step_index === 0 ? "first_touch" : "follow_up",
      channel: row.channel,
      subject: row.subject,
      body: row.body,
      rejected:
        row.queue_id != null
          ? byQueue.all(row.queue_id, row.id)
          : bySlot.all(row.prospect_key, row.play_name, row.step_index, row.id),
      closedAt: row.closed_at,
    }));
  }
}
