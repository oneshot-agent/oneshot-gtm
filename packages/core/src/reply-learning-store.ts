import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  ReplyDraftSet,
  ReplyThread,
  ReplySendState,
  ReplyVariant,
  ReplyLearningEvidence,
  ReplyLearningStatus,
  ReplyPreference,
} from "@oneshot-gtm/shared-types";

export interface LearningObservation extends ReplyLearningEvidence {
  seq: number;
  channel: "linkedin";
  workspace: string;
  move: string | null;
  learningVersion: number;
  context?: Array<{ direction: "inbound" | "outbound"; body: string }>;
}
export interface PreferenceCandidate {
  key: string;
  instruction: string;
  source: ReplyPreference["source"];
  evidenceIds: string[];
}
interface State {
  enabled: number;
  version: number;
  watermark: number;
  imported: number;
  attempted_ms: number;
  refreshed_at: string | null;
  error: string | null;
  token: string | null;
  until_ms: number;
}
interface PreferenceRow {
  id: string;
  instruction: string;
  source: ReplyPreference["source"];
  enabled: number;
  evidence_ids: string;
}
interface Generation {
  drafts: ReplyDraftSet;
  context: unknown;
}
interface Improvement {
  generationId: string;
  variant: ReplyVariant;
  input: string;
  text: string;
  feedback: string;
}
const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const eligible = (t: ReplyThread) => t.channel === "linkedin" && !!t.workspace;
const conversationContext = (t: ReplyThread, before = Infinity) =>
  t.messages
    .filter((m) => m.human && !m.deleted && Date.parse(m.at) < before)
    .slice(-4)
    .map((m) => ({ direction: m.direction, body: m.body.slice(0, 500) }));

/** Shares the review database/transactions; all learning is explicitly workspace scoped. */
export class ReplyLearningStore {
  constructor(readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reply_learning_state (
        workspace TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 0, watermark INTEGER NOT NULL DEFAULT 0,
        imported INTEGER NOT NULL DEFAULT 0, attempted_ms INTEGER NOT NULL DEFAULT 0,
        refreshed_at TEXT, error TEXT, token TEXT, until_ms INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS reply_learning_artifacts (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, thread_key TEXT NOT NULL,
        kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS reply_learning_artifacts_thread ON reply_learning_artifacts(thread_key);
      CREATE TABLE IF NOT EXISTS reply_learning_observations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        workspace TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS reply_learning_observations_scope ON reply_learning_observations(workspace,seq);
      CREATE TABLE IF NOT EXISTS reply_learning_preferences (
        workspace TEXT NOT NULL, id TEXT NOT NULL, instruction TEXT NOT NULL,
        source TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, evidence_ids TEXT NOT NULL,
        PRIMARY KEY(workspace,id));
    `);
  }
  private state(workspace: string): State {
    this.db.query("INSERT OR IGNORE INTO reply_learning_state(workspace) VALUES(?)").run(workspace);
    return this.db
      .query<State, [string]>("SELECT * FROM reply_learning_state WHERE workspace=?")
      .get(workspace)!;
  }
  private artifact<T>(id: string, workspace: string, threadKey: string, kind: string): T | null {
    const row = this.db
      .query<{ data: string }, [string, string, string, string]>(
        "SELECT data FROM reply_learning_artifacts WHERE id=? AND workspace=? AND thread_key=? AND kind=?",
      )
      .get(id, workspace, threadKey, kind);
    return row ? (JSON.parse(row.data) as T) : null;
  }
  private put(id: string, t: ReplyThread, kind: string, data: Record<string, unknown>) {
    if (!eligible(t)) return;
    this.db
      .query("INSERT OR IGNORE INTO reply_learning_artifacts VALUES(?,?,?,?,?)")
      .run(id, t.workspace!, t.key, kind, JSON.stringify({ ...data, channel: "linkedin" }));
  }
  recordGeneration(t: ReplyThread, drafts: ReplyDraftSet, context: unknown) {
    this.put(`generation:${drafts.id}`, t, "generation", { drafts, context });
  }
  recordImprovement(
    t: ReplyThread,
    variant: ReplyVariant,
    input: string,
    text: string,
    feedback: string,
  ): string | undefined {
    if (!eligible(t) || !t.drafts) return;
    const id = randomUUID();
    this.put(id, t, "improvement", { generationId: t.drafts.id, variant, input, text, feedback });
    return id;
  }
  /** Do not trust client-supplied originals, versions, or improvement references. */
  validateDraft(t: ReplyThread, next: ReplyDraftSet): ReplyDraftSet {
    if (!eligible(t)) return next;
    const generation = this.artifact<Generation>(
      `generation:${next.id}`,
      t.workspace!,
      t.key,
      "generation",
    );
    const improvementIds: ReplyDraftSet["improvementIds"] = {};
    for (const variant of ["direct", "technical", "warm"] as const) {
      const ids = next.improvementIds?.[variant];
      if (!Array.isArray(ids)) continue;
      const previous = t.drafts?.id === next.id ? (t.drafts.improvementIds?.[variant] ?? []) : [];
      improvementIds[variant] = [
        ...new Set(ids.filter((id): id is string => typeof id === "string")),
      ]
        .slice(-20)
        .filter((id) => {
          const item = this.artifact<Improvement>(id, t.workspace!, t.key, "improvement");
          return (
            item?.generationId === next.id &&
            item.variant === variant &&
            (previous.includes(id) || item.text === next.edits[variant])
          );
        });
      // Resetting an option to the original explicitly abandons its improvements.
      if (generation && next.edits[variant] === generation.drafts.originals[variant])
        improvementIds[variant] = [];
    }
    if (t.drafts && t.drafts.id !== next.id)
      this.put(`replacement:${randomUUID()}`, t, "replacement", {
        previous: t.drafts,
        nextGenerationId: next.id,
      });
    return {
      ...next,
      improvementIds,
      learningVersion: generation?.drafts.learningVersion ?? 0,
      ...(generation
        ? { originals: generation.drafts.originals, moves: generation.drafts.moves }
        : {}),
    };
  }
  /** Immutable snapshot captured before edits are cleared, eligible only after confirmation. */
  snapshot(t: ReplyThread, send: ReplySendState) {
    if (!eligible(t) || !t.drafts) return;
    const d = t.drafts;
    const g = this.artifact<Generation>(`generation:${d.id}`, t.workspace!, t.key, "generation");
    const feedback = (d.improvementIds?.[send.variant] ?? []).flatMap((id) => {
      const item = this.artifact<Improvement>(id, t.workspace!, t.key, "improvement");
      return item?.generationId === d.id && item.variant === send.variant && item.feedback.trim()
        ? [item.feedback]
        : [];
    });
    this.put(`send:${send.id}`, t, "send", {
      id: send.id,
      threadKey: t.key,
      name: t.name,
      body: send.body,
      original: g?.drafts.originals[send.variant] || null,
      feedback,
      move: g?.drafts.moves[send.variant] ?? null,
      learningVersion: g?.drafts.learningVersion ?? 0,
      historical: false,
      context: conversationContext(t),
      at: new Date().toISOString(),
      workspace: t.workspace,
    });
  }
  confirm(threadKey: string, send: ReplySendState) {
    if (send.status !== "sent") return;
    const row = this.db
      .query<{ data: string }, [string, string]>(
        "SELECT data FROM reply_learning_artifacts WHERE id=? AND thread_key=? AND kind='send'",
      )
      .get(`send:${send.id}`, threadKey);
    if (!row) return;
    const observation = JSON.parse(row.data) as LearningObservation;
    this.insertObservation({ ...observation, at: send.sentAt ?? observation.at });
  }
  private insertObservation(o: Omit<LearningObservation, "seq">) {
    this.db
      .query("INSERT OR IGNORE INTO reply_learning_observations(id,workspace,data) VALUES(?,?,?)")
      .run(o.id, o.workspace, JSON.stringify(o));
    this.state(o.workspace);
  }
  /** Import only app-confirmed sends; attribution must also be verified against the inbox owner. */
  importHistory(workspace: string, owns: (t: ReplyThread) => boolean): number {
    if (this.state(workspace).imported) return 0;
    return this.db
      .transaction(() => {
        let imported = 0;
        const rows = this.db
          .query<{ data: string; thread: string; drafts: string | null }, [string]>(`
        SELECT s.data, t.data AS thread, t.drafts FROM review_sends s JOIN review_threads t ON t.key=s.thread_key
        WHERE json_extract(s.data,'$.status')='sent' AND json_extract(t.data,'$.channel')='linkedin'
          AND json_extract(t.data,'$.workspace')=?
        ORDER BY json_extract(s.data,'$.sentAt') DESC LIMIT 100`)
          .all(workspace);
        for (const row of rows) {
          const t = JSON.parse(row.thread) as ReplyThread;
          const send = JSON.parse(row.data) as ReplySendState;
          if (!send.sentAt || !send.body.trim() || !owns(t)) continue;
          // New sends retain their immutable workspace even after reassignment.
          if (
            this.db
              .query("SELECT 1 FROM reply_learning_artifacts WHERE id=?")
              .get(`send:${send.id}`)
          )
            continue;
          const drafts = row.drafts ? (JSON.parse(row.drafts) as ReplyDraftSet) : null;
          const result = this.db
            .query("SELECT 1 FROM reply_learning_observations WHERE id=?")
            .get(send.id);
          if (result) continue;
          this.insertObservation({
            id: send.id,
            channel: "linkedin",
            workspace,
            threadKey: t.key,
            name: t.name,
            body: send.body,
            original:
              drafts?.id === send.generationId ? drafts.originals[send.variant] || null : null,
            feedback: [],
            move: drafts?.id === send.generationId ? (drafts.moves[send.variant] ?? null) : null,
            learningVersion: 0,
            historical: true,
            context: conversationContext(t, Date.parse(send.sentAt)),
            at: send.sentAt,
          });
          imported++;
        }
        this.db
          .query("UPDATE reply_learning_state SET imported=1 WHERE workspace=?")
          .run(workspace);
        return imported;
      })
      .immediate();
  }
  private preferences(workspace: string): PreferenceRow[] {
    return this.db
      .query<PreferenceRow, [string]>(
        "SELECT * FROM reply_learning_preferences WHERE workspace=? ORDER BY id",
      )
      .all(workspace);
  }
  private observation(id: string, workspace: string): LearningObservation | null {
    const row = this.db
      .query<{ seq: number; data: string }, [string, string]>(
        "SELECT seq,data FROM reply_learning_observations WHERE id=? AND workspace=?",
      )
      .get(id, workspace);
    return row ? { ...JSON.parse(row.data), seq: row.seq } : null;
  }
  status(workspace: string): ReplyLearningStatus {
    const s = this.state(workspace);
    const pending = !!this.db
      .query("SELECT 1 FROM reply_learning_observations WHERE workspace=? AND seq>? LIMIT 1")
      .get(workspace, s.watermark);
    return {
      enabled: !!s.enabled,
      version: s.version,
      imported: !!s.imported,
      pending,
      lastRefreshedAt: s.refreshed_at,
      error: s.error,
      preferences: this.preferences(workspace).map((p) => ({
        id: p.id,
        instruction: p.instruction,
        source: p.source,
        enabled: !!p.enabled,
        evidence: (JSON.parse(p.evidence_ids) as string[]).flatMap((id) => {
          const o = this.observation(id, workspace);
          return o
            ? [
                {
                  id: o.id,
                  threadKey: o.threadKey,
                  name: o.name,
                  body: o.body,
                  original: o.original,
                  feedback: o.feedback,
                  historical: o.historical,
                  at: o.at,
                },
              ]
            : [];
        }),
      })),
    };
  }
  guidance(workspace: string): { version: number; instructions: string[] } {
    const s = this.state(workspace);
    return {
      version: s.version,
      instructions: s.enabled
        ? this.preferences(workspace)
            .filter((p) => p.enabled)
            .slice(0, 12)
            .map((p) => p.instruction)
        : [],
    };
  }
  setEnabled(workspace: string, enabled: boolean, preferenceId?: string) {
    this.db
      .transaction(() => {
        this.state(workspace);
        if (preferenceId) {
          const p = this.preferences(workspace).find((p) => p.id === preferenceId);
          if (!p) throw new Error("Reply preference not found");
          if (
            enabled &&
            !p.enabled &&
            this.preferences(workspace).filter((p) => p.enabled).length >= 12
          )
            throw new Error("Disable another preference first (12 active maximum)");
          this.db
            .query("UPDATE reply_learning_preferences SET enabled=? WHERE workspace=? AND id=?")
            .run(+enabled, workspace, preferenceId);
        } else
          this.db
            .query("UPDATE reply_learning_state SET enabled=? WHERE workspace=?")
            .run(+enabled, workspace);
        this.db
          .query(
            "UPDATE reply_learning_state SET version=version+1,token=NULL,until_ms=0 WHERE workspace=?",
          )
          .run(workspace);
      })
      .immediate();
  }
  /** Persisted lease and cooldown protect multiple processes and restarts. */
  claim(
    workspace: string,
    now = Date.now(),
  ): {
    token: string;
    through: number;
    observations: LearningObservation[];
    preferences: ReplyPreference[];
  } | null {
    return this.db
      .transaction(() => {
        const s = this.state(workspace);
        if (!s.enabled || s.until_ms > now || (s.attempted_ms && now - s.attempted_ms < 300_000))
          return null;
        const pending = this.db
          .query<{ seq: number }, [string, number]>(
            "SELECT seq FROM reply_learning_observations WHERE workspace=? AND seq>? ORDER BY seq LIMIT 100",
          )
          .all(workspace, s.watermark);
        const through = pending.at(-1)?.seq;
        if (!through) return null;
        const rows = this.db
          .query<{ seq: number; data: string }, [string, number]>(
            "SELECT seq,data FROM reply_learning_observations WHERE workspace=? AND seq<=? ORDER BY seq DESC LIMIT 100",
          )
          .all(workspace, through);
        const token = randomUUID();
        this.db
          .query(
            "UPDATE reply_learning_state SET token=?,until_ms=?,attempted_ms=? WHERE workspace=?",
          )
          .run(token, now + 240_000, now, workspace);
        return {
          token,
          through,
          observations: rows
            .toReversed()
            .map((r) => Object.assign(JSON.parse(r.data), { seq: r.seq })),
          preferences: this.status(workspace).preferences,
        };
      })
      .immediate();
  }
  /** Keep a live provider retry sequence exclusive without reviving an expired/fenced lease. */
  renew(workspace: string, token: string, now = Date.now()): boolean {
    return (
      this.db
        .query(
          "UPDATE reply_learning_state SET until_ms=? WHERE workspace=? AND token=? AND until_ms>?",
        )
        .run(now + 240_000, workspace, token, now).changes > 0
    );
  }
  finish(
    workspace: string,
    token: string,
    through: number,
    candidates: PreferenceCandidate[],
    evidence: LearningObservation[],
    now = Date.now(),
  ): boolean {
    return this.db
      .transaction(() => {
        const s = this.state(workspace);
        if (!s.enabled || s.token !== token || s.until_ms <= now) return false;
        const existing = this.preferences(workspace);
        let active = existing.filter((p) => p.enabled).length;
        let changed = false;
        for (const c of candidates.slice(0, 24)) {
          if (
            !c ||
            typeof c.key !== "string" ||
            !/^[a-z0-9][a-z0-9-]{0,79}$/.test(c.key) ||
            typeof c.instruction !== "string" ||
            !c.instruction.trim() ||
            c.instruction.length > 500 ||
            !["explicit", "edits", "style"].includes(c.source) ||
            !Array.isArray(c.evidenceIds)
          )
            continue;
          const cited = [...new Set(c.evidenceIds)].flatMap((id) => {
            const o = evidence.find(
              (o) => o.id === id && o.workspace === workspace && o.seq <= through,
            );
            return o ? [o] : [];
          });
          // A fabricated citation invalidates the candidate, not just that citation.
          if (!cited.length || cited.length !== new Set(c.evidenceIds).size) continue;
          const qualifying = cited.filter((o) =>
            c.source === "explicit"
              ? !o.historical && o.feedback.length > 0
              : c.source === "edits"
                ? !o.historical && !!o.original && o.original.trim() !== o.body.trim()
                : true,
          );
          const threshold = c.source === "explicit" ? 1 : c.source === "edits" ? 3 : 5;
          if (new Set(qualifying.map((o) => o.threadKey)).size < threshold) continue;
          const old = existing.find(
            (p) => p.id === c.key || normalize(p.instruction) === normalize(c.instruction),
          );
          if (old && (!old.enabled || normalize(old.instruction) !== normalize(c.instruction)))
            continue;
          if (!old && active >= 12) continue;
          const ids = [
            ...new Set([
              ...(old ? (JSON.parse(old.evidence_ids) as string[]) : []),
              ...qualifying.map((o) => o.id),
            ]),
          ].slice(-20);
          this.db
            .query(`INSERT INTO reply_learning_preferences(workspace,id,instruction,source,evidence_ids) VALUES(?,?,?,?,?)
          ON CONFLICT(workspace,id) DO UPDATE SET evidence_ids=excluded.evidence_ids`)
            .run(
              workspace,
              old?.id ?? c.key,
              c.instruction.trim(),
              old?.source ?? c.source,
              JSON.stringify(ids),
            );
          if (!old) {
            active++;
            existing.push({
              id: c.key,
              instruction: c.instruction.trim(),
              source: c.source,
              enabled: 1,
              evidence_ids: JSON.stringify(ids),
            });
          }
          changed = true;
        }
        this.db
          .query(
            `UPDATE reply_learning_state SET watermark=?,version=version+?,refreshed_at=?,error=NULL,token=NULL,until_ms=0 WHERE workspace=?`,
          )
          .run(through, +changed, new Date(now).toISOString(), workspace);
        return true;
      })
      .immediate();
  }
  fail(workspace: string, token: string, reason: string) {
    this.db
      .query(
        "UPDATE reply_learning_state SET error=?,token=NULL,until_ms=0 WHERE workspace=? AND token=?",
      )
      .run(reason, workspace, token);
  }
}
