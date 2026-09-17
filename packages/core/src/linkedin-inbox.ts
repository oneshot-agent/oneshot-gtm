import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  LinkedInAccount,
  LinkedInConversation,
  LinkedInMessage,
  LinkedInSyncStatus,
} from "@oneshot-agent/sdk";
import { sharedDir, currentWorkspaceName } from "./shared-db.ts";
import { listWorkspaces } from "./workspaces.ts";
import { configDir } from "./config.ts";
import { canonicalLinkedInProfileKey } from "./ledger-prospects.ts";
import { Ledger } from "./ledger.ts";
import { classifyReply } from "./reply-classify.ts";

export interface LinkedInAccountRecord {
  key: string;
  wallet: string;
  workspace: string;
  account: LinkedInAccount;
  sync: LinkedInSyncStatus | null;
  checkedAt: string | null;
  error: string | null;
}
export interface LinkedInOwner {
  workspace: string;
  prospectId: number;
  manual?: boolean;
}
export interface LinkedInThreadRecord {
  key: string;
  accountKey: string;
  conversation: LinkedInConversation;
  owner: LinkedInOwner | null;
}
export interface LinkedInMatch extends LinkedInOwner {
  name: string;
  profile: string;
  home: string;
}
export function replyWorkspaces() {
  const active = { name: currentWorkspaceName(), home: configDir() };
  return [active, ...listWorkspaces().map(([name, entry]) => ({ name, home: entry.home }))].filter(
    (w, i, all) =>
      existsSync(join(w.home, "ledger.sqlite")) &&
      all.findIndex((x) => x.name === w.name || resolve(x.home) === resolve(w.home)) === i,
  );
}
export function linkedInMatches(): LinkedInMatch[] {
  const matches: LinkedInMatch[] = [];
  for (const w of replyWorkspaces()) {
    const db = new Database(join(w.home, "ledger.sqlite"), { readonly: true });
    try {
      const rows = db
        .query<
          {
            id: number;
            name: string | null;
            linkedin_url: string | null;
            source_profile_url: string | null;
          },
          []
        >("SELECT id,name,linkedin_url,source_profile_url FROM prospects")
        .all();
      for (const p of rows) {
        const profile =
          canonicalLinkedInProfileKey(p.linkedin_url ?? "") ??
          canonicalLinkedInProfileKey(p.source_profile_url ?? "");
        if (profile)
          matches.push({
            workspace: w.name,
            home: w.home,
            prospectId: p.id,
            name: p.name ?? profile,
            profile,
          });
      }
    } finally {
      db.close();
    }
  }
  return matches;
}
export function conversationMatches(c: LinkedInConversation, matches: LinkedInMatch[]) {
  const peers = c.attendees.filter((a) => !a.is_self);
  if (peers.length !== 1) return [];
  const profile = canonicalLinkedInProfileKey(peers[0]!.profile_url ?? "");
  return profile ? matches.filter((m) => m.profile === profile) : [];
}

/** Reuse workspace connections within one delivery batch, then release them together. */
class LinkedInDeliveryHandles {
  private ledgers = new Map<string, Ledger>();
  private databases = new Map<string, Database>();
  ledger(home: string): Ledger {
    const key = resolve(home);
    let ledger = this.ledgers.get(key);
    if (!ledger) {
      ledger = new Ledger(join(key, "ledger.sqlite"));
      this.ledgers.set(key, ledger);
    }
    return ledger;
  }
  database(home: string): Database {
    const key = resolve(home);
    let db = this.databases.get(key);
    if (!db) {
      db = new Database(join(key, "ledger.sqlite"));
      this.databases.set(key, db);
    }
    return db;
  }
  close() {
    try {
      for (const db of this.databases.values()) db.close();
    } finally {
      for (const ledger of this.ledgers.values()) ledger.close();
    }
  }
}

export class LinkedInInboxStore {
  readonly db: Database;
  constructor(path = join(sharedDir(), "linkedin-inbox.sqlite")) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;
      CREATE TABLE IF NOT EXISTS accounts(key TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(key TEXT PRIMARY KEY,account_key TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(account_key TEXT NOT NULL,id TEXT NOT NULL,conversation_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(account_key,id));
      CREATE TABLE IF NOT EXISTS progress(key TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(account_key TEXT,message_id TEXT,workspace TEXT,prospect_id INTEGER,PRIMARY KEY(account_key,message_id,workspace,prospect_id));
      CREATE TABLE IF NOT EXISTS assignments(id INTEGER PRIMARY KEY,thread_key TEXT,old_owner TEXT,new_owner TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    `);
  }
  close() {
    this.db.close();
  }
  accounts(): LinkedInAccountRecord[] {
    return this.db
      .query<{ data: string }, []>("SELECT data FROM accounts")
      .all()
      .map((r) => JSON.parse(r.data));
  }
  account(key: string) {
    return this.accounts().find((a) => a.key === key) ?? null;
  }
  saveAccount(a: LinkedInAccountRecord) {
    this.db
      .query("INSERT INTO accounts VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data")
      .run(a.key, JSON.stringify(a));
  }
  progress<T>(key: string): T | null {
    const r = this.db
      .query<{ data: string }, [string]>("SELECT data FROM progress WHERE key=?")
      .get(key);
    return r ? JSON.parse(r.data) : null;
  }
  saveProgress(key: string, data: unknown) {
    this.db
      .query("INSERT INTO progress VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data")
      .run(key, JSON.stringify(data));
  }
  threads(accountKey?: string): LinkedInThreadRecord[] {
    return (
      accountKey
        ? this.db
            .query<{ data: string }, [string]>("SELECT data FROM conversations WHERE account_key=?")
            .all(accountKey)
        : this.db.query<{ data: string }, []>("SELECT data FROM conversations").all()
    ).map((r) => JSON.parse(r.data));
  }
  thread(key: string): LinkedInThreadRecord | null {
    const r = this.db
      .query<{ data: string }, [string]>("SELECT data FROM conversations WHERE key=?")
      .get(key);
    return r ? JSON.parse(r.data) : null;
  }
  saveConversation(
    accountKey: string,
    conversation: LinkedInConversation,
    matches: LinkedInMatch[],
  ) {
    const key = `linkedin:${accountKey}:${conversation.id}`;
    const previous = this.thread(key);
    const found = conversationMatches(conversation, matches);
    const owner = previous?.owner?.manual
      ? previous.owner
      : found.length === 1
        ? { workspace: found[0]!.workspace, prospectId: found[0]!.prospectId }
        : null;
    const row: LinkedInThreadRecord = { key, accountKey, conversation, owner };
    this.db
      .query(
        "INSERT INTO conversations VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      )
      .run(key, accountKey, JSON.stringify(row));
  }
  assign(key: string, owner: LinkedInOwner) {
    this.db
      .transaction(() => {
        const t = this.thread(key);
        if (!t) throw new Error("Conversation not found");
        this.db
          .query("INSERT INTO assignments(thread_key,old_owner,new_owner) VALUES(?,?,?)")
          .run(key, JSON.stringify(t.owner), JSON.stringify(owner));
        t.owner = { ...owner, manual: true };
        this.db.query("UPDATE conversations SET data=? WHERE key=?").run(JSON.stringify(t), key);
      })
      .immediate();
  }
  saveMessages(accountKey: string, messages: LinkedInMessage[]) {
    this.db.transaction(() => {
      for (const m of messages)
        this.db
          .query(
            "INSERT INTO messages VALUES(?,?,?,?) ON CONFLICT(account_key,id) DO UPDATE SET data=excluded.data,conversation_id=excluded.conversation_id",
          )
          .run(accountKey, m.id, m.conversation_id, JSON.stringify(m));
    })();
  }
  messages(accountKey: string, conversationId: string): LinkedInMessage[] {
    return this.db
      .query<{ data: string }, [string, string]>(
        "SELECT data FROM messages WHERE account_key=? AND conversation_id=?",
      )
      .all(accountKey, conversationId)
      .map((r) => JSON.parse(r.data) as LinkedInMessage)
      .toSorted((a, b) => a.sent_at.localeCompare(b.sent_at) || a.id.localeCompare(b.id));
  }
  /** One attribution per message; sibling matches only stop outreach. Existing Expandi history remains intact. */
  deliver(t: LinkedInThreadRecord, matches: LinkedInMatch[]) {
    this.deliverAll([t], matches);
  }
  /** Attribute a capture batch without repeating workspace initialization for every thread. */
  deliverAll(threads: LinkedInThreadRecord[], matches: LinkedInMatch[]) {
    const handles = new LinkedInDeliveryHandles();
    try {
      for (const t of threads) this.deliverWithHandles(t, matches, handles);
    } finally {
      handles.close();
    }
  }
  private deliverWithHandles(
    t: LinkedInThreadRecord,
    matches: LinkedInMatch[],
    handles: LinkedInDeliveryHandles,
  ) {
    const inbound = this.messages(t.accountKey, t.conversation.id).filter(
      (m) =>
        m.direction === "inbound" &&
        !m.deleted &&
        classifyReply({ subject: "", body: m.text ?? "" }) === "human",
    );
    if (!inbound.length) return;
    const candidates = conversationMatches(t.conversation, matches);
    const targets = [...candidates];
    if (
      t.owner &&
      !targets.some(
        (m) => m.workspace === t.owner!.workspace && m.prospectId === t.owner!.prospectId,
      )
    ) {
      const home = replyWorkspaces().find((w) => w.name === t.owner!.workspace)?.home;
      if (home) targets.push({ ...t.owner, home, name: "", profile: "" });
    }
    // Deliver the new owner's attribution before removing obsolete SDK attribution.
    targets.sort(
      (a, b) =>
        Number(b.workspace === t.owner?.workspace && b.prospectId === t.owner?.prospectId) -
        Number(a.workspace === t.owner?.workspace && a.prospectId === t.owner?.prospectId),
    );
    for (const match of targets) {
      const ledger = handles.ledger(match.home);
      const db = handles.database(match.home);
      if (!ledger.getProspectById(match.prospectId)) continue;
      if (match.workspace !== t.owner?.workspace || match.prospectId !== t.owner?.prospectId) {
        db.query(
          "UPDATE cadence_state SET status='stopped',stop_reason='other',stop_note='LinkedIn reply in another workspace',stopped_at=datetime('now'),next_due_at=NULL,next_step_draft_json=NULL,next_step_drafted_at=NULL WHERE prospect_id=? AND status IN ('active','paused')",
        ).run(match.prospectId);
        continue;
      }
      for (const m of inbound) {
        const eventId = `${t.accountKey}:${m.id}`;
        if (
          this.db
            .query(
              "SELECT 1 FROM deliveries WHERE account_key=? AND message_id=? AND workspace=? AND prospect_id=?",
            )
            .get(t.accountKey, m.id, match.workspace, match.prospectId)
        )
          continue;
        const legacy = ledger
          .listChannelEventsForProspect(match.prospectId)
          .some(
            (e) =>
              e.source === "expandi" &&
              Date.parse(e.occurred_at) === Date.parse(m.sent_at) &&
              (e.body ?? "").trim() === (m.text ?? "").trim(),
          );
        if (!legacy) {
          db.query(
            "DELETE FROM channel_events WHERE source='oneshot-linkedin' AND external_event_id=? AND prospect_id<>?",
          ).run(eventId, match.prospectId);
          ledger.recordLinkedInReply({
            prospectId: match.prospectId,
            source: "oneshot-linkedin",
            externalEventId: eventId,
            occurredAt: m.sent_at,
            body: m.text,
          });
        }
        this.db
          .query("INSERT OR IGNORE INTO deliveries VALUES(?,?,?,?)")
          .run(t.accountKey, m.id, match.workspace, match.prospectId);
        this.db
          .query(
            "DELETE FROM deliveries WHERE account_key=? AND message_id=? AND (workspace<>? OR prospect_id<>?)",
          )
          .run(t.accountKey, m.id, match.workspace, match.prospectId);
        for (const w of replyWorkspaces().filter((w) => w.name !== match.workspace)) {
          const other = handles.database(w.home);
          other
            .query(
              "DELETE FROM channel_events WHERE source='oneshot-linkedin' AND external_event_id=?",
            )
            .run(eventId);
        }
      }
    }
  }
}
let singleton: LinkedInInboxStore | undefined;
export function getLinkedInInboxStore() {
  return (singleton ??= new LinkedInInboxStore());
}
