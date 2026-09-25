import type { Database } from "bun:sqlite";

/**
 * Draft versions — every draft persisted for founder review, intro or
 * follow-up, kept as a row so the review loop leaves a record.
 *
 * Before this table, `target_queue.last_draft_json` and
 * `cadence_state.next_step_draft_json` were overwritten in place on every
 * regenerate, so a discarded draft vanished and nothing said which angle a
 * send was built on once the edge text was edited. The row's current draft is
 * the `open` version; a regenerate closes it as `discarded` with the reason
 * the caller knew (`regenerate` = same angle, text rejected; `rotate` = the
 * founder changed angle; `redraft` = a machine re-draft, not a judgment;
 * `abandoned` = the cadence stopped/replied/bounced with a draft open); a
 * send closes it as `sent` when a human reviewed it, `auto_sent` when the
 * drain shipped an approved row unseen.
 *
 * Angles are keyed by normalized text (`angleTextKey`), never by index —
 * indices drift as soon as `yourEdge` is edited.
 *
 * Pure wrapper around a raw `Database` handle like `ledger-queue.ts`; both
 * `QueueStore` (intro drafts) and `Ledger` (cadence drafts) own one.
 */

export type DraftVersionOutcome = "open" | "discarded" | "sent" | "auto_sent";
export type DraftDiscardReason = "regenerate" | "rotate" | "redraft" | "abandoned";
export type DraftAngleOrigin = "configured" | "generated";

export interface DraftVersionAngle {
  text: string;
  origin: DraftAngleOrigin;
}

export interface DraftVersionRow {
  id: number;
  play_name: string;
  prospect_key: string;
  step_index: number;
  queue_id: number | null;
  prospect_id: number | null;
  subject: string;
  body: string;
  flags_json: string | null;
  angle_key: string | null;
  angle_text: string | null;
  angle_origin: DraftAngleOrigin | null;
  outcome: DraftVersionOutcome;
  discard_reason: DraftDiscardReason | null;
  /** Hash of the founder voice card in the prompt; NULL when none was set. */
  voice_key: string | null;
  created_at: string;
  closed_at: string | null;
}

/** Which row's draft: an intro (queue row) or a follow-up (cadence step). */
export type DraftSlot =
  | { queueId: number }
  | { prospectId: number; playName: string; stepIndex: number };

export interface AngleUsageRow {
  angleKey: string;
  angleText: string;
  origin: DraftAngleOrigin;
  /** Distinct prospects who were shown a draft on this angle. */
  offered: number;
  /** Distinct prospects where the founder rotated away from it. */
  rotatedAway: number;
  /** Distinct prospects where the founder kept the angle but regenerated the text. */
  redrafted: number;
  /** Distinct prospects the founder sent it to after review. */
  sent: number;
  /** Distinct prospects it went to unattended (drain on an approved row). */
  autoSent: number;
  /** Distinct prospects who replied to the send built on it (reviewed or unattended). */
  replied: number;
  /** Distinct prospects it was sent to at all, reviewed or unattended — the reply-rate denominator. */
  reached: number;
}

export interface DraftUsage {
  open: number;
  regenerated: number;
  rotated: number;
  sent: number;
  autoSent: number;
  /** Sent or auto-sent versions whose send got a reply. */
  replied: number;
}

export interface DraftUsageByStep {
  intro: DraftUsage;
  followUp: DraftUsage;
}

/** Normalized identity of an angle's text: lower-cased, punctuation collapsed. */
export function angleTextKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Shape-check an `angle` value a draft envelope carries (`LastDraft.angle`, a cadence payload's `angle`). */
export function draftVersionAngle(value: unknown): DraftVersionAngle | null {
  if (!value || typeof value !== "object") return null;
  const a = value as { text?: unknown; origin?: unknown };
  if (typeof a.text !== "string" || !a.text.trim()) return null;
  const origin: DraftAngleOrigin = a.origin === "generated" ? "generated" : "configured";
  return { text: a.text.trim(), origin };
}

/**
 * The draft envelope a row stores (`target_queue.last_draft_json`, or a
 * cadence's `next_step_draft_json` whose `payload.angle` carries the angle),
 * shape-checked. Null when it is not a usable unsent draft: a sent envelope
 * has nothing left to discard, and an error stub was never a draft.
 */
export function storedDraftEnvelope(raw: unknown): {
  subject: string;
  body: string;
  flags: string[];
  angle: DraftVersionAngle | null;
  draftedAt: string | null;
  voiceKey: string | null;
} | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v["body"] !== "string" || !v["body"].trim()) return null;
  if (v["sent"] === true) return null;
  const subject = typeof v["subject"] === "string" ? v["subject"] : "";
  if (subject === "(error)") return null;
  const flags = Array.isArray(v["flags"])
    ? v["flags"].filter((f): f is string => typeof f === "string")
    : [];
  if (flags.some((f) => f.startsWith("error:"))) return null;
  const payload = v["payload"];
  const payloadAngle =
    payload && typeof payload === "object" ? (payload as { angle?: unknown }).angle : undefined;
  const payloadVoice =
    payload && typeof payload === "object"
      ? (payload as { voiceKey?: unknown }).voiceKey
      : undefined;
  const voice = v["voiceKey"] ?? payloadVoice;
  return {
    subject,
    body: v["body"],
    flags,
    angle: draftVersionAngle(v["angle"] ?? payloadAngle),
    draftedAt: typeof v["draftedAt"] === "string" ? v["draftedAt"] : null,
    voiceKey: typeof voice === "string" && voice ? voice : null,
  };
}

const EMPTY_USAGE = (): DraftUsage => ({
  open: 0,
  regenerated: 0,
  rotated: 0,
  sent: 0,
  autoSent: 0,
  replied: 0,
});

/**
 * SQL predicate, for a `draft_versions dv` row: the send this version became
 * (sent or auto_sent) was replied to. A reply flips the matching sent
 * `sequence_events` row to `replied` (`markLatestStepReplied`), keyed by
 * prospect, play and step. Intro versions may predate their prospect row, so
 * the prospect is found by `prospect_id` or, failing that, the prospect key
 * (the lower-cased email every version is keyed by). Should a slot ever
 * hold two sent versions, only the latest is credited, so one reply is never
 * counted twice.
 */
const DV_REPLIED = `dv.outcome IN ('sent', 'auto_sent')
  AND dv.id = (
    SELECT MAX(d2.id) FROM draft_versions d2
     WHERE d2.play_name = dv.play_name
       AND d2.prospect_key = dv.prospect_key
       AND d2.step_index = dv.step_index
       AND d2.outcome IN ('sent', 'auto_sent'))
  AND EXISTS (
    SELECT 1 FROM sequence_events se
     WHERE se.status = 'replied'
       AND se.play_name = dv.play_name
       AND se.step_index = dv.step_index
       AND se.prospect_id = COALESCE(
             dv.prospect_id,
             (SELECT p.id FROM prospects p WHERE lower(p.email) = dv.prospect_key LIMIT 1)))`;

function slotWhere(slot: DraftSlot): { sql: string; args: Array<number | string> } {
  if ("queueId" in slot) return { sql: "queue_id = ?", args: [slot.queueId] };
  return {
    sql: "prospect_id = ? AND play_name = ? AND step_index = ?",
    args: [slot.prospectId, slot.playName, slot.stepIndex],
  };
}

export class DraftVersionStore {
  constructor(private readonly db: Database) {}

  /**
   * Record a new draft for a slot: the slot's open version (if any) closes as
   * `discarded` with `discardReason`, then the new draft opens. Error stubs
   * and empty bodies are not versions — nothing was put in front of anyone.
   */
  open(input: {
    slot: DraftSlot;
    playName: string;
    prospectKey: string;
    stepIndex: number;
    subject: string;
    body: string;
    flags: string[];
    angle?: DraftVersionAngle | null;
    voiceKey?: string | null;
    discardReason?: DraftDiscardReason;
    /** When the draft was really written — a seeded pre-existing draft keeps its own time. */
    createdAt?: string;
  }): void {
    if (!input.body.trim() || input.subject === "(error)") return;
    if (input.flags.some((f) => f.startsWith("error:"))) return;
    this.close(input.slot, "discarded", input.discardReason ?? "redraft");
    this.insert({ ...input, outcome: "open" });
  }

  /**
   * A draft that was on the row BEFORE versioning existed (or that reached
   * the row through a path this store never saw) is still the draft the
   * founder is about to regenerate, rotate away from, or send. When the slot
   * has no open version, open one from the stored envelope first, so the
   * write that follows records it as discarded/sent instead of losing it.
   * Dated to the envelope's own `draftedAt` when it carries one.
   */
  seedFromStored(input: {
    slot: DraftSlot;
    playName: string;
    prospectKey: string;
    stepIndex: number;
    stored: unknown;
  }): void {
    // Only a slot this store has never seen: once any version exists, the
    // stored envelope IS a version (or was closed as one) — seeding again
    // would double-count a send.
    const where = slotWhere(input.slot);
    const seen = this.db
      .query(`SELECT 1 FROM draft_versions WHERE ${where.sql} LIMIT 1`)
      .get(...where.args);
    if (seen) return;
    const env = storedDraftEnvelope(input.stored);
    if (!env) return;
    this.open({
      slot: input.slot,
      playName: input.playName,
      prospectKey: input.prospectKey,
      stepIndex: input.stepIndex,
      subject: env.subject,
      body: env.body,
      flags: env.flags,
      angle: env.angle,
      voiceKey: env.voiceKey,
      ...(env.draftedAt ? { createdAt: env.draftedAt } : {}),
    });
  }

  /**
   * Close the slot's open version. Returns whether one was open. `sent` /
   * `auto_sent` are the terminal outcomes a send stamps; `discarded` carries
   * the reason.
   */
  close(
    slot: DraftSlot,
    outcome: Exclude<DraftVersionOutcome, "open">,
    reason?: DraftDiscardReason,
  ): boolean {
    const where = slotWhere(slot);
    const res = this.db
      .prepare(
        `UPDATE draft_versions
           SET outcome = ?, discard_reason = ?, closed_at = ?
         WHERE outcome = 'open' AND ${where.sql}`,
      )
      .run(
        outcome,
        outcome === "discarded" ? (reason ?? "redraft") : null,
        new Date().toISOString(),
        ...where.args,
      );
    return res.changes > 0;
  }

  /**
   * Close every open version a cadence holds (any step) — the row-level
   * clears (`stopCadence`, terminal statuses) do not know the step index.
   */
  closeAllForCadence(
    prospectId: number,
    playName: string,
    outcome: Exclude<DraftVersionOutcome, "open">,
    reason?: DraftDiscardReason,
  ): number {
    return this.db
      .prepare(
        `UPDATE draft_versions
           SET outcome = ?, discard_reason = ?, closed_at = ?
         WHERE outcome = 'open' AND prospect_id = ? AND play_name = ? AND step_index > 0`,
      )
      .run(
        outcome,
        outcome === "discarded" ? (reason ?? "abandoned") : null,
        new Date().toISOString(),
        prospectId,
        playName,
      ).changes;
  }

  /** Same, for every cadence a prospect has (the "prospect replied" sweep). */
  closeAllForProspect(
    prospectId: number,
    outcome: "discarded",
    reason: DraftDiscardReason,
  ): number {
    return this.db
      .prepare(
        `UPDATE draft_versions
           SET outcome = 'discarded', discard_reason = ?, closed_at = ?
         WHERE outcome = 'open' AND prospect_id = ? AND step_index > 0`,
      )
      .run(reason, new Date().toISOString(), prospectId).changes;
  }

  /** The open version's body for a slot, so a send can tell whether it shipped that draft. */
  openBody(slot: DraftSlot): string | null {
    const where = slotWhere(slot);
    const row = this.db
      .query(`SELECT body FROM draft_versions WHERE outcome = 'open' AND ${where.sql} LIMIT 1`)
      .get(...where.args) as { body: string } | null;
    return row?.body ?? null;
  }

  /**
   * A send that was never previewed as an open version (drain drafted and
   * sent in one pass): record it straight into its terminal outcome.
   */
  insertClosed(input: {
    slot: DraftSlot;
    playName: string;
    prospectKey: string;
    stepIndex: number;
    subject: string;
    body: string;
    flags: string[];
    angle?: DraftVersionAngle | null;
    voiceKey?: string | null;
    outcome: "sent" | "auto_sent";
  }): void {
    if (!input.body.trim()) return;
    this.insert(input);
  }

  private insert(input: {
    slot: DraftSlot;
    playName: string;
    prospectKey: string;
    stepIndex: number;
    subject: string;
    body: string;
    flags: string[];
    angle?: DraftVersionAngle | null;
    voiceKey?: string | null;
    outcome: DraftVersionOutcome;
    createdAt?: string;
  }): void {
    const now = new Date().toISOString();
    const angle = input.angle ?? null;
    this.db
      .prepare(
        `INSERT INTO draft_versions(
           play_name, prospect_key, step_index, queue_id, prospect_id,
           subject, body, flags_json, angle_key, angle_text, angle_origin,
           outcome, discard_reason, voice_key, created_at, closed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`,
      )
      .run(
        input.playName,
        input.prospectKey,
        input.stepIndex,
        "queueId" in input.slot ? input.slot.queueId : null,
        "prospectId" in input.slot ? input.slot.prospectId : null,
        input.subject,
        input.body,
        input.flags.length > 0 ? JSON.stringify(input.flags) : null,
        angle ? angleTextKey(angle.text) : null,
        angle ? angle.text : null,
        angle ? angle.origin : null,
        input.outcome,
        input.voiceKey ?? null,
        input.createdAt ?? now,
        input.outcome === "open" ? null : now,
      );
  }

  /** Every version for a slot, newest first. */
  versionsFor(slot: DraftSlot): DraftVersionRow[] {
    const where = slotWhere(slot);
    return this.db
      .query(`SELECT * FROM draft_versions WHERE ${where.sql} ORDER BY id DESC`)
      .all(...where.args) as DraftVersionRow[];
  }

  /**
   * Per play, per angle: how many distinct prospects were shown it, rotated
   * away from it, regenerated on it, sent it, or got it unattended. Intro and
   * follow-up steps are summed — the founder's judgment on an angle is the
   * same either way.
   */
  angleUsageByPlay(): Record<string, AngleUsageRow[]> {
    const rows = this.db
      .query(
        `SELECT play_name, angle_key,
                MAX(angle_text) AS angle_text,
                MAX(angle_origin) AS origin,
                COUNT(DISTINCT prospect_key) AS offered,
                COUNT(DISTINCT CASE WHEN outcome = 'discarded' AND discard_reason = 'rotate' THEN prospect_key END) AS rotated_away,
                COUNT(DISTINCT CASE WHEN outcome = 'discarded' AND discard_reason = 'regenerate' THEN prospect_key END) AS redrafted,
                COUNT(DISTINCT CASE WHEN outcome = 'sent' THEN prospect_key END) AS sent,
                COUNT(DISTINCT CASE WHEN outcome = 'auto_sent' THEN prospect_key END) AS auto_sent,
                COUNT(DISTINCT CASE WHEN ${DV_REPLIED} THEN prospect_key END) AS replied,
                COUNT(DISTINCT CASE WHEN outcome IN ('sent', 'auto_sent') THEN prospect_key END) AS reached
           FROM draft_versions dv
          WHERE angle_key IS NOT NULL
          GROUP BY play_name, angle_key
          ORDER BY play_name, sent DESC, offered DESC`,
      )
      .all() as Array<{
      play_name: string;
      angle_key: string;
      angle_text: string;
      origin: DraftAngleOrigin;
      offered: number;
      rotated_away: number;
      redrafted: number;
      sent: number;
      auto_sent: number;
      replied: number;
      reached: number;
    }>;
    const out: Record<string, AngleUsageRow[]> = {};
    for (const r of rows) {
      (out[r.play_name] ??= []).push({
        angleKey: r.angle_key,
        angleText: r.angle_text,
        origin: r.origin,
        offered: r.offered,
        rotatedAway: r.rotated_away,
        redrafted: r.redrafted,
        sent: r.sent,
        autoSent: r.auto_sent,
        replied: r.replied,
        reached: r.reached,
      });
    }
    return out;
  }

  /**
   * Per play: version counts by outcome, split by whether a founder voice
   * card was in the prompt (`voice_key` set) — the on/off comparison the
   * /setup voice card is judged by. Plays with no versions are absent.
   */
  draftUsageByVoice(): Record<string, { voiced: DraftUsage; plain: DraftUsage }> {
    const rows = this.db
      .query(
        `SELECT play_name,
                CASE WHEN voice_key IS NULL THEN 'plain' ELSE 'voiced' END AS scope,
                SUM(outcome = 'open') AS open,
                SUM(outcome = 'discarded' AND discard_reason = 'regenerate') AS regenerated,
                SUM(outcome = 'discarded' AND discard_reason = 'rotate') AS rotated,
                SUM(outcome = 'sent') AS sent,
                SUM(outcome = 'auto_sent') AS auto_sent,
                SUM(${DV_REPLIED}) AS replied
           FROM draft_versions dv
          GROUP BY play_name, scope`,
      )
      .all() as Array<{
      play_name: string;
      scope: "voiced" | "plain";
      open: number;
      regenerated: number;
      rotated: number;
      sent: number;
      auto_sent: number;
      replied: number;
    }>;
    const out: Record<string, { voiced: DraftUsage; plain: DraftUsage }> = {};
    for (const r of rows) {
      const entry = (out[r.play_name] ??= { voiced: EMPTY_USAGE(), plain: EMPTY_USAGE() });
      const target = r.scope === "voiced" ? entry.voiced : entry.plain;
      target.open = r.open;
      target.regenerated = r.regenerated;
      target.rotated = r.rotated;
      target.sent = r.sent;
      target.autoSent = r.auto_sent;
      target.replied = r.replied ?? 0;
    }
    return out;
  }

  /** Per play: version counts by outcome, intro (step 0) and follow-up apart. Plays with no versions are absent. */
  draftUsageByPlay(): Record<string, DraftUsageByStep> {
    const rows = this.db
      .query(
        `SELECT play_name,
                CASE WHEN step_index = 0 THEN 'intro' ELSE 'follow_up' END AS scope,
                SUM(outcome = 'open') AS open,
                SUM(outcome = 'discarded' AND discard_reason = 'regenerate') AS regenerated,
                SUM(outcome = 'discarded' AND discard_reason = 'rotate') AS rotated,
                SUM(outcome = 'sent') AS sent,
                SUM(outcome = 'auto_sent') AS auto_sent,
                SUM(${DV_REPLIED}) AS replied
           FROM draft_versions dv
          GROUP BY play_name, scope`,
      )
      .all() as Array<{
      play_name: string;
      scope: "intro" | "follow_up";
      open: number;
      regenerated: number;
      rotated: number;
      sent: number;
      auto_sent: number;
      replied: number;
    }>;
    const out: Record<string, DraftUsageByStep> = {};
    for (const r of rows) {
      const entry = (out[r.play_name] ??= { intro: EMPTY_USAGE(), followUp: EMPTY_USAGE() });
      const target = r.scope === "intro" ? entry.intro : entry.followUp;
      target.open = r.open;
      target.regenerated = r.regenerated;
      target.rotated = r.rotated;
      target.sent = r.sent;
      target.autoSent = r.auto_sent;
      target.replied = r.replied ?? 0;
    }
    return out;
  }
}
