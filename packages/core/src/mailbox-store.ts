import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { ReplyKind } from "./reply-classify.ts";
import { addColumnIfMissing } from "./ledger-schema.ts";
import type { ParsedBounce } from "./gmail.ts";

export interface MailboxMessage {
  id: string;
  identityId: string;
  threadKey: string;
  messageId: string | null;
  references: string[];
  gmailThreadId: string | null;
  from: string;
  to: string[];
  replyTo: string | null;
  subject: string;
  body: string;
  at: string;
  direction: "inbound" | "outbound";
  kind: ReplyKind;
  autoSubmitted: string | null;
  prospectId: number | null;
  bounces?: ParsedBounce[];
}

export interface MailboxHealth {
  identityId: string;
  address: string;
  lastSyncAt: string | null;
  status: "syncing" | "connected" | "error" | "disconnected";
  error: string | null;
  backfillRemaining: boolean;
  messages: number;
}

export interface MailboxCheckpoint {
  uidValidity: string;
  lastUid: number;
  /** Initial scan includes the workspace's earliest email outreach. */
  since: string;
  complete: boolean;
}

export interface MailboxAttempt {
  id: string;
  inboundId: string;
  message: MailboxMessage;
  status: "sending" | "uncertain" | "sent" | "failed";
  error: string | null;
}

export const mailboxHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 32);

/** Workspace-local storage. No credentials and no global/shared database. */
export class MailboxStore {
  constructor(private db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mailbox_messages (
        id TEXT PRIMARY KEY, identity_id TEXT NOT NULL, thread_key TEXT NOT NULL,
        message_id TEXT, prospect_id INTEGER, direction TEXT NOT NULL,
        at TEXT NOT NULL, data TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS mailbox_messages_thread ON mailbox_messages(thread_key, at);
      CREATE INDEX IF NOT EXISTS mailbox_messages_rfc ON mailbox_messages(identity_id, message_id);
      CREATE TABLE IF NOT EXISTS mailbox_references (
        identity_id TEXT NOT NULL, reference_id TEXT NOT NULL, message_id TEXT NOT NULL,
        PRIMARY KEY(identity_id, reference_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS mailbox_threads (
        thread_key TEXT PRIMARY KEY, archived_at TEXT, history_complete INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS mailbox_state (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mailbox_attempts (
        id TEXT PRIMARY KEY, inbound_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mailbox_attempts_inbound ON mailbox_attempts(inbound_id, status);
    `);
    addColumnIfMissing(db, "mailbox_threads", "last_read_at", "TEXT");
    addColumnIfMissing(db, "mailbox_messages", "needs_processing", "INTEGER NOT NULL DEFAULT 1");
  }

  get(id: string): MailboxMessage | null {
    const row = this.db.query("SELECT data FROM mailbox_messages WHERE id=?").get(id) as {
      data: string;
    } | null;
    return row ? JSON.parse(row.data) : null;
  }

  byMessageId(identityId: string, messageId: string): MailboxMessage | null {
    const row = this.db
      .query("SELECT data FROM mailbox_messages WHERE identity_id=? AND message_id=?")
      .get(identityId, messageId) as { data: string } | null;
    return row ? JSON.parse(row.data) : null;
  }

  referencing(identityId: string, messageId: string): MailboxMessage | null {
    const row = this.db
      .query(`SELECT m.data FROM mailbox_messages m JOIN mailbox_references r ON r.message_id=m.id
      WHERE r.identity_id=? AND r.reference_id=? ORDER BY m.at,m.id LIMIT 1`)
      .get(identityId, messageId) as { data: string } | null;
    return row ? JSON.parse(row.data) : null;
  }

  put(message: MailboxMessage): boolean {
    return this.db
      .transaction(() => {
        const existingMessage = this.get(message.id);
        if (existingMessage) {
          if (existingMessage.bounces == null && message.bounces != null) {
            this.db
              .query("UPDATE mailbox_messages SET data=? WHERE id=?")
              .run(JSON.stringify({ ...existingMessage, bounces: message.bounces }), message.id);
          }
          return false;
        }
        // Inherit an explicit thread association before looking at the latest sender.
        const linked = this.thread(message.threadKey).find((m) => m.prospectId != null);
        if (linked) message = { ...message, prospectId: linked.prospectId };
        const readState = this.db
          .query("SELECT last_read_at FROM mailbox_threads WHERE thread_key=?")
          .get(message.threadKey) as { last_read_at: string | null } | null;
        this.db
          .query(`INSERT INTO mailbox_messages
        (id,identity_id,thread_key,message_id,prospect_id,direction,at,data,is_read)
        VALUES(?,?,?,?,?,?,?,?,?)`)
          .run(
            message.id,
            message.identityId,
            message.threadKey,
            message.messageId,
            message.prospectId,
            message.direction,
            message.at,
            JSON.stringify(message),
            message.direction === "outbound" ||
              (readState?.last_read_at && message.at < readState.last_read_at)
              ? 1
              : 0,
          );
        for (const reference of message.references)
          this.db
            .query(
              "INSERT OR IGNORE INTO mailbox_references(identity_id,reference_id,message_id) VALUES(?,?,?)",
            )
            .run(message.identityId, reference, message.id);
        const existing = this.db
          .query("SELECT archived_at FROM mailbox_threads WHERE thread_key=?")
          .get(message.threadKey);
        if (!existing) {
          // Preserve a previous prospect archive only for messages older than it.
          const archive =
            message.prospectId == null
              ? null
              : (this.db
                  .query("SELECT archived_at FROM inbox_archives WHERE prospect_id=?")
                  .get(message.prospectId) as { archived_at: string } | null);
          this.db
            .query("INSERT INTO mailbox_threads(thread_key,archived_at) VALUES(?,?)")
            .run(
              message.threadKey,
              archive && message.at <= archive.archived_at ? archive.archived_at : null,
            );
        } else if (message.direction === "inbound") {
          // Historical backfill must not reopen a conversation already handled later.
          this.db
            .query(
              "UPDATE mailbox_threads SET archived_at=NULL WHERE thread_key=? AND archived_at < ?",
            )
            .run(message.threadKey, message.at);
        }
        return true;
      })
      .immediate();
  }

  thread(key: string): MailboxMessage[] {
    return (
      this.db
        .query("SELECT data FROM mailbox_messages WHERE thread_key=? ORDER BY at,id")
        .all(key) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }

  all(): MailboxMessage[] {
    return (
      this.db.query("SELECT data FROM mailbox_messages ORDER BY at DESC,id").all() as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data));
  }

  /** Includes unprocessed old matches even after a newer global poll watermark. */
  /** Read only potential delivery notices, including legacy rows awaiting classification. */
  bounceCandidates(since?: string): MailboxMessage[] {
    return (
      this.db
        .query(`SELECT data FROM mailbox_messages WHERE direction='inbound'
      AND (? IS NULL OR at >= ?) AND (json_extract(data, '$.bounces') IS NULL
      OR json_array_length(data, '$.bounces') > 0)`)
        .all(since ?? null, since ?? null) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }

  inbound(identityId: string, since?: string, until?: string): MailboxMessage[] {
    return (
      this.db
        .query(`SELECT m.data FROM mailbox_messages m
      LEFT JOIN inbox_replies r ON r.id=m.id
      WHERE m.identity_id=? AND m.direction='inbound'
      AND (? IS NULL OR m.at >= ? OR (m.prospect_id IS NOT NULL AND (r.id IS NULL OR m.needs_processing=1)))
      AND (? IS NULL OR m.at < ?) ORDER BY m.at DESC,m.id`)
        .all(identityId, since ?? null, since ?? null, until ?? null, until ?? null) as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data));
  }

  state<T>(key: string): T | null {
    const row = this.db.query("SELECT data FROM mailbox_state WHERE key=?").get(key) as {
      data: string;
    } | null;
    return row ? JSON.parse(row.data) : null;
  }

  setState(key: string, data: unknown): void {
    this.db
      .query(
        "INSERT INTO mailbox_state(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      )
      .run(key, JSON.stringify(data));
  }

  threadState(key: string): {
    unread: boolean;
    archivedAt: string | null;
    historyComplete: boolean;
  } {
    const row = this.db
      .query("SELECT archived_at,history_complete FROM mailbox_threads WHERE thread_key=?")
      .get(key) as { archived_at: string | null; history_complete: number } | null;
    const unread = this.db
      .query(
        "SELECT 1 FROM mailbox_messages WHERE thread_key=? AND direction='inbound' AND is_read=0 LIMIT 1",
      )
      .get(key);
    return {
      unread: Boolean(unread),
      archivedAt: row?.archived_at ?? null,
      historyComplete: Boolean(row?.history_complete),
    };
  }

  markHistoryComplete(key: string): void {
    this.db.query("UPDATE mailbox_threads SET history_complete=1 WHERE thread_key=?").run(key);
  }

  /** Snapshot-based mutations never hide or read a newly arrived message. */
  changeState(
    key: string,
    observedIds: string[],
    change: { read?: boolean; archived?: boolean },
  ): void {
    this.db
      .transaction(() => {
        const inbound = this.thread(key).filter((m) => m.direction === "inbound");
        if (!inbound.length) throw new Error("conversation not found");
        const observed = new Set(observedIds);
        if (change.archived && inbound.some((m) => !observed.has(m.id)))
          throw new Error("The conversation changed. Review the new reply before archiving.");
        if (change.read != null) {
          for (const m of inbound)
            if (observed.has(m.id))
              this.db
                .query("UPDATE mailbox_messages SET is_read=? WHERE id=?")
                .run(change.read ? 1 : 0, m.id);
          const cutoff = change.read
            ? (inbound
                .filter((m) => observed.has(m.id))
                .map((m) => m.at)
                .toSorted()
                .at(-1) ?? null)
            : null;
          this.db
            .query("UPDATE mailbox_threads SET last_read_at=? WHERE thread_key=?")
            .run(cutoff, key);
        }
        if (change.archived != null)
          this.db
            .query("UPDATE mailbox_threads SET archived_at=? WHERE thread_key=?")
            .run(change.archived ? new Date().toISOString() : null, key);
      })
      .immediate();
  }

  associate(key: string, prospectId: number): void {
    this.db
      .transaction(() => {
        for (const m of this.thread(key)) {
          m.prospectId = prospectId;
          this.db
            .query("UPDATE mailbox_messages SET prospect_id=?,data=?,needs_processing=1 WHERE id=?")
            .run(prospectId, JSON.stringify(m), m.id);
          this.db.query("UPDATE inbox_replies SET prospect_id=? WHERE id=?").run(prospectId, m.id);
        }
      })
      .immediate();
  }

  acknowledge(id: string, prospectId: number): void {
    this.db
      .query("UPDATE mailbox_messages SET needs_processing=0 WHERE id=? AND prospect_id=?")
      .run(id, prospectId);
  }

  reclassify(message: MailboxMessage, kind: ReplyKind, bounces?: ParsedBounce[]): void {
    if (message.kind === kind && message.bounces != null) return;
    this.db
      .transaction(() => {
        this.db
          .query(
            "UPDATE mailbox_messages SET data=?,needs_processing=CASE WHEN ? THEN 1 ELSE needs_processing END WHERE id=?",
          )
          .run(
            JSON.stringify({ ...message, kind, bounces: bounces ?? message.bounces }),
            message.kind !== kind ? 1 : 0,
            message.id,
          );
        this.db.query("UPDATE inbox_replies SET kind=? WHERE id=?").run(kind, message.id);
      })
      .immediate();
  }

  oldestOutreach(): string | null {
    const row = this.db
      .query(
        "SELECT min(created_at) AS at FROM sequence_events WHERE channel='email' AND status IN ('sent','delivered','replied')",
      )
      .get() as { at: string | null };
    return row.at
      ? new Date(row.at.replace(" ", "T") + (row.at.endsWith("Z") ? "" : "Z")).toISOString()
      : null;
  }

  attempt(id: string): MailboxAttempt | null {
    const row = this.db.query("SELECT data FROM mailbox_attempts WHERE id=?").get(id) as {
      data: string;
    } | null;
    return row ? JSON.parse(row.data) : null;
  }

  attempts(): MailboxAttempt[] {
    return (
      this.db
        .query("SELECT data FROM mailbox_attempts WHERE status IN ('sending','uncertain')")
        .all() as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }

  claimAttempt(attempt: MailboxAttempt): MailboxAttempt {
    return this.db
      .transaction(() => {
        const existing = this.attempt(attempt.id);
        if (existing) return existing;
        const pending = this.db
          .query(
            "SELECT data FROM mailbox_attempts WHERE inbound_id=? AND status IN ('sending','uncertain') LIMIT 1",
          )
          .get(attempt.inboundId) as { data: string } | null;
        if (pending)
          throw new Error(
            "A previous send is still being reconciled. Refresh the thread before retrying.",
          );
        this.saveAttempt(attempt);
        return attempt;
      })
      .immediate();
  }

  saveAttempt(attempt: MailboxAttempt): void {
    this.db
      .query(
        "INSERT INTO mailbox_attempts(id,inbound_id,status,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data",
      )
      .run(attempt.id, attempt.inboundId, attempt.status, JSON.stringify(attempt));
  }
}
