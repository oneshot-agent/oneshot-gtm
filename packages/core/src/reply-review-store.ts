import { Database } from "bun:sqlite";
import { openStateDatabase } from "./sqlite-open.ts";
import { createHash, randomUUID } from "node:crypto";

import { join } from "node:path";
import type {
  ReplyDraftSet,
  ReplySendState,
  ReplyStateRequest,
  ReplyThread,
} from "@oneshot-gtm/shared-types";
import { ReplyLearningStore } from "./reply-learning-store.ts";
import { sharedDir } from "./shared-db.ts";

type Row = {
  data: string;
  archived_at: string | null;
  snoozed_until: string | null;
  observed: string;
  through_at: string | null;
  drafts: string | null;
  send: string | null;
};
export const replyContextVersion = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const humanReplyIds = (t: ReplyThread): string[] =>
  t.messages.filter((m) => m.direction === "inbound" && m.human && !m.deleted).map((m) => m.id);

/** Durable review state shared by channels. Email keys include the workspace; LinkedIn keys include the wallet/account. */
export class ReplyReviewStore {
  readonly db: Database;
  readonly learning: ReplyLearningStore;
  constructor(path = join(sharedDir(), "reply-review.sqlite")) {
    this.db = openStateDatabase(path, { busyTimeoutMs: 10000 });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS review_threads(key TEXT PRIMARY KEY, scope TEXT NOT NULL, data TEXT NOT NULL,
        archived_at TEXT, snoozed_until TEXT, observed TEXT NOT NULL DEFAULT '[]', through_at TEXT, drafts TEXT, send TEXT);
      CREATE TABLE IF NOT EXISTS review_leases(key TEXT PRIMARY KEY, token TEXT NOT NULL, until_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS review_sends(id TEXT PRIMARY KEY, thread_key TEXT NOT NULL, data TEXT NOT NULL);
    `);
    this.learning = new ReplyLearningStore(this.db);
  }
  close() {
    this.db.close();
  }
  private row(key: string): Row | null {
    return this.db.query<Row, [string]>("SELECT * FROM review_threads WHERE key=?").get(key);
  }
  get(key: string, now = Date.now()): ReplyThread | null {
    const row = this.row(key);
    if (!row) return null;
    const t = JSON.parse(row.data) as ReplyThread;
    // A confirmed send is visible immediately, even before the provider's next capture.
    const sent = this.db
      .query<{ data: string }, [string]>("SELECT data FROM review_sends WHERE thread_key=?")
      .all(key)
      .map((r) => JSON.parse(r.data) as ReplySendState)
      .filter((s) => s.status === "sent" && s.sentAt);
    for (const s of sent) {
      if (
        !t.messages.some(
          (m) =>
            m.direction === "outbound" &&
            m.body.trim() === s.body.trim() &&
            Math.abs(Date.parse(m.at) - Date.parse(s.sentAt!)) < 60_000,
        )
      )
        t.messages.push({
          id: `sent:${s.id}`,
          direction: "outbound",
          human: true,
          body: s.body,
          at: s.sentAt!,
        });
    }
    t.messages.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    t.needsReply = t.messages.findLast((m) => m.human && !m.deleted)?.direction === "inbound";
    t.lastActivityAt = t.messages.at(-1)?.at ?? t.lastActivityAt;
    return {
      ...t,
      archivedAt: row.archived_at,
      snoozedUntil:
        row.snoozed_until && Date.parse(row.snoozed_until) > now ? row.snoozed_until : null,
      drafts: row.drafts ? JSON.parse(row.drafts) : null,
      send: row.send ? JSON.parse(row.send) : null,
    };
  }
  list(scope: string): ReplyThread[] {
    return this.db
      .query<{ key: string }, [string]>("SELECT key FROM review_threads WHERE scope=?")
      .all(scope)
      .map((r) => this.get(r.key)!);
  }
  upsert(scope: string, t: ReplyThread) {
    this.db
      .transaction(() => {
        const old = this.row(t.key);
        const inbound = t.messages.filter(
          (m) => m.direction === "inbound" && m.human && !m.deleted,
        );
        const observed: string[] = old ? JSON.parse(old.observed) : [];
        const wake =
          old?.through_at &&
          inbound.some(
            (m) => Date.parse(m.at) >= Date.parse(old.through_at!) && !observed.includes(m.id),
          );
        const { drafts: _drafts, send: _send, ...snapshot } = t;
        this.db
          .query(`INSERT INTO review_threads(key,scope,data,archived_at) VALUES(?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET scope=excluded.scope,data=excluded.data`)
          .run(t.key, scope, JSON.stringify(snapshot), t.archivedAt);
        if (wake)
          this.db
            .query(
              "UPDATE review_threads SET archived_at=NULL,snoozed_until=NULL,through_at=NULL,observed='[]' WHERE key=?",
            )
            .run(t.key);
        if (!old && t.archivedAt) this.setState(t.key, "archive", humanReplyIds(t));
      })
      .immediate();
  }
  setState(key: string, action: ReplyStateRequest["action"], observed: string[], now = Date.now()) {
    return this.db
      .transaction(() => {
        const t = this.get(key, now);
        if (!t) throw new Error("Conversation not found");
        const human = t.messages.filter((m) => m.direction === "inbound" && m.human && !m.deleted);
        if (
          (action === "archive" || action === "snooze") &&
          human.some((m) => !observed.includes(m.id))
        )
          throw new Error("A new reply arrived. Refresh before hiding this conversation.");
        if (action === "snooze" && t.archivedAt)
          throw new Error("Restore this conversation before snoozing it");
        const archived =
          action === "archive"
            ? new Date(now).toISOString()
            : action === "restore"
              ? null
              : t.archivedAt;
        const until = action === "snooze" ? new Date(now + 5 * 86400_000).toISOString() : null;
        const through =
          human
            .map((m) => m.at)
            .toSorted()
            .at(-1) ?? new Date(now).toISOString();
        this.db
          .query(
            "UPDATE review_threads SET archived_at=?,snoozed_until=?,observed=?,through_at=? WHERE key=?",
          )
          .run(
            archived,
            until,
            JSON.stringify(observed),
            action === "archive" || action === "snooze" ? through : null,
            key,
          );
        return this.get(key, now)!;
      })
      .immediate();
  }
  saveDrafts(key: string, next: ReplyDraftSet, expectedRevision: number | null): ReplyDraftSet {
    return this.db
      .transaction(() => {
        const t = this.get(key);
        if (!t) throw new Error("Conversation not found");
        if (t.send && ["pending", "uncertain"].includes(t.send.status))
          throw new Error("A reply is still being sent");
        if ((t.drafts?.revision ?? null) !== expectedRevision)
          throw new Error("Draft changed in another window. Reload before saving.");
        const saved = {
          ...this.learning.validateDraft(t, next),
          revision: (expectedRevision ?? 0) + 1,
        };
        this.db
          .query("UPDATE review_threads SET drafts=? WHERE key=?")
          .run(JSON.stringify(saved), key);
        return saved;
      })
      .immediate();
  }
  claim(key: string, duration = 240_000): string | null {
    const token = randomUUID();
    const r = this.db
      .query(
        `INSERT INTO review_leases VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET token=excluded.token,until_ms=excluded.until_ms WHERE until_ms<?`,
      )
      .run(key, token, Date.now() + duration, Date.now());
    return r.changes ? token : null;
  }
  release(key: string, token: string) {
    this.db.query("DELETE FROM review_leases WHERE key=? AND token=?").run(key, token);
  }
  beginSend(key: string, send: ReplySendState, revision: number): ReplySendState {
    return this.db
      .transaction(() => {
        const t = this.get(key);
        if (!t?.drafts) throw new Error("Save the draft before sending");
        if (t.send?.id === send.id) return t.send;
        if (t.send && ["pending", "uncertain"].includes(t.send.status))
          throw new Error("The previous send is still pending. Check its status first.");
        if (t.drafts.revision !== revision || t.drafts.id !== send.generationId)
          throw new Error("Draft changed. Review it before sending.");
        this.db
          .query("UPDATE review_threads SET send=? WHERE key=?")
          .run(JSON.stringify(send), key);
        this.db
          .query("INSERT INTO review_sends VALUES(?,?,?)")
          .run(send.id, key, JSON.stringify(send));
        this.learning.snapshot(t, send);
        return send;
      })
      .immediate();
  }
  updateSend(key: string, send: ReplySendState) {
    this.db
      .transaction(() => {
        const t = this.get(key);
        if (t?.send?.id !== send.id) return;
        this.db
          .query("UPDATE review_threads SET send=? WHERE key=?")
          .run(JSON.stringify(send), key);
        this.db
          .query("UPDATE review_sends SET data=? WHERE id=?")
          .run(JSON.stringify(send), send.id);
        this.learning.confirm(key, send);
        if (send.status === "sent" && t.drafts?.id === send.generationId) {
          const empty = {
            ...t.drafts,
            revision: t.drafts.revision + 1,
            edits: { direct: "", technical: "", warm: "" },
          };
          this.db
            .query("UPDATE review_threads SET drafts=? WHERE key=?")
            .run(JSON.stringify(empty), key);
        }
      })
      .immediate();
  }
}
let singleton: ReplyReviewStore | undefined;
export function getReplyReviewStore(): ReplyReviewStore {
  return (singleton ??= new ReplyReviewStore());
}
