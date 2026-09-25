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
import { Ledger, openLedgerDatabase } from "./ledger.ts";
import { classifyReply } from "./reply-classify.ts";

export function isHumanLinkedInReply(m: LinkedInMessage): boolean {
  const kind = classifyReply({ subject: "", body: m.text ?? "" });
  return m.direction === "inbound" && !m.deleted && (kind === "human" || kind === "unsubscribe");
}
export interface LinkedInIdentity {
  providerId: string;
  profile: string | null;
  name: string | null;
  resolvedAt: string;
  requestId?: string;
  failure?: { code: string; message: string };
}
export interface LinkedInWorkspaceCounts {
  imported: number;
  matched: number;
  unresolved: number;
  noProspect: number;
  stoppedCadences: number;
}
export interface LinkedInAccountRecord {
  key: string;
  wallet: string;
  workspace: string;
  account: LinkedInAccount;
  sync: LinkedInSyncStatus | null;
  checkedAt: string | null;
  error: string | null;
  /** Local removal tombstone: retain history, prevent discovery from restoring access. */
  removedAt?: string;
  permissionUpgradeError?: string;
  previousAccountIds?: string[];
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
  sourceAccountId?: string;
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
    const db = openLedgerDatabase(join(w.home, "ledger.sqlite"), { readonly: true });
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
/** Provider IDs sometimes arrive disguised as /in/ URLs; those are not public identity evidence. */
export function verifiedLinkedInProfileKey(
  value: string,
  providerId?: string | null,
): string | null {
  const key = canonicalLinkedInProfileKey(value);
  if (!key) return null;
  const slug = key.slice("linkedin.com/in/".length);
  if (
    (providerId && slug === providerId.toLowerCase()) ||
    /^(?:aco|acw)[a-z0-9_-]{12,}$/i.test(slug) ||
    slug.startsWith("urn:")
  )
    return null;
  return key;
}
export function conversationMatches(c: LinkedInConversation, matches: LinkedInMatch[]) {
  const peers = c.attendees.filter((a) => !a.is_self);
  if (peers.length !== 1) return [];
  const profile = verifiedLinkedInProfileKey(peers[0]!.profile_url ?? "", peers[0]!.provider_id);
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
      db = openLedgerDatabase(join(key, "ledger.sqlite"));
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
      CREATE TABLE IF NOT EXISTS identities(account_key TEXT,provider_id TEXT,data TEXT NOT NULL,PRIMARY KEY(account_key,provider_id));
      CREATE TABLE IF NOT EXISTS accounts(key TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(key TEXT PRIMARY KEY,account_key TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(account_key TEXT NOT NULL,id TEXT NOT NULL,conversation_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(account_key,id));
      CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(account_key,conversation_id);
      CREATE INDEX IF NOT EXISTS messages_by_provider ON messages(account_key,json_extract(data,'$.provider_message_id'));
      CREATE INDEX IF NOT EXISTS conversations_by_provider ON conversations(account_key,json_extract(data,'$.conversation.provider_chat_id'));
      CREATE INDEX IF NOT EXISTS conversations_by_id ON conversations(account_key,json_extract(data,'$.conversation.id'));
      CREATE TABLE IF NOT EXISTS progress(key TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(account_key TEXT,message_id TEXT,workspace TEXT,prospect_id INTEGER,PRIMARY KEY(account_key,message_id,workspace,prospect_id));
      CREATE TABLE IF NOT EXISTS conversation_aliases(account_key TEXT,conversation_id TEXT,thread_key TEXT,PRIMARY KEY(account_key,conversation_id));
      CREATE TABLE IF NOT EXISTS message_redirects(account_key TEXT,duplicate_id TEXT,canonical_id TEXT,PRIMARY KEY(account_key,duplicate_id));
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
    const removedAt = this.account(a.key)?.removedAt ?? a.removedAt;
    if (removedAt)
      a = { ...a, removedAt, account: { ...a.account, status: "revoked", allowed_actions: [] } };
    this.db
      .query("INSERT INTO accounts VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data")
      .run(a.key, JSON.stringify(a));
  }
  /** Verified replacement keeps the local account/thread/message keys used by review and replay. */
  replaceAccount(accountKey: string, account: LinkedInAccount, matches: LinkedInMatch[]) {
    this.db
      .transaction(() => {
        const previous = this.account(accountKey);
        if (!previous) throw new Error("Original LinkedIn account not found");
        if (previous.removedAt) throw new Error("This LinkedIn connection has been removed.");
        if (!previous.account.member_urn || previous.account.member_urn !== account.member_urn)
          throw new Error("Replacement LinkedIn identity does not match the original account");
        if (account.status !== "connected")
          throw new Error("Replacement LinkedIn account is not connected");
        if (previous.account.id === account.id) return;
        const discoveredKey = `${previous.wallet}:${account.id}`;
        const imported = this.threads(discoveredKey);
        if (imported.some((t) => t.owner?.manual))
          throw new Error(
            "Replacement already has manual assignments; review before merging accounts",
          );
        const replacementJob = this.progress<{ pending?: unknown }>(`backfill:${discoveredKey}`);
        if (replacementJob?.pending)
          throw new Error("Replacement has pending provider work; wait before merging");
        this.saveAccount({
          ...previous,
          account,
          sync: null,
          checkedAt: null,
          error: null,
          permissionUpgradeError: undefined,
          previousAccountIds: [
            ...new Set([...(previous.previousAccountIds ?? []), previous.account.id]),
          ],
        });
        for (const t of imported)
          this.saveConversation(accountKey, t.conversation, matches, account.id);
        this.saveMessages(accountKey, this.allMessages(discoveredKey));
        // The source copies have now been merged by stable provider IDs in this same transaction.
        this.db.query("DELETE FROM conversations WHERE account_key=?").run(discoveredKey);
        this.db.query("DELETE FROM messages WHERE account_key=?").run(discoveredKey);
        this.db.query("DELETE FROM accounts WHERE key=?").run(discoveredKey);
        for (const resource of ["active", "archived", "messages"])
          this.saveProgress(`${accountKey}:${resource}`, { started: new Date().toISOString() });
        const job = this.progress<Record<string, unknown>>(`backfill:${accountKey}`);
        if (job)
          this.saveProgress(`backfill:${accountKey}`, {
            ...job,
            stage: "capture",
            error: undefined,
            resumeStage: undefined,
          });
      })
      .immediate();
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
  threadForConversation(accountKey: string, conversationId: string): LinkedInThreadRecord | null {
    const row = this.db
      .query<{ data: string }, [string, string]>(
        "SELECT data FROM conversations WHERE account_key=? AND json_extract(data,'$.conversation.id')=?",
      )
      .get(accountKey, conversationId);
    if (row) return JSON.parse(row.data);
    const alias = this.db
      .query<{ thread_key: string }, [string, string]>(
        "SELECT thread_key FROM conversation_aliases WHERE account_key=? AND conversation_id=?",
      )
      .get(accountKey, conversationId);
    return alias ? this.thread(alias.thread_key) : null;
  }
  saveConversation(
    accountKey: string,
    conversation: LinkedInConversation,
    matches: LinkedInMatch[],
    sourceAccountId?: string,
  ) {
    for (const attendee of conversation.attendees) {
      const profile = verifiedLinkedInProfileKey(attendee.profile_url ?? "", attendee.provider_id);
      if (
        !attendee.is_self &&
        attendee.provider_id &&
        profile &&
        !this.identity(accountKey, attendee.provider_id)
      )
        this.saveIdentity(accountKey, {
          providerId: attendee.provider_id,
          profile,
          name: attendee.name,
          resolvedAt: conversation.updated_at ?? new Date().toISOString(),
        });
    }
    return this.db
      .transaction(() => {
        let previous = this.threadForConversation(accountKey, conversation.id);
        if (!previous && conversation.provider_chat_id) {
          const row = this.db
            .query<{ data: string }, [string, string]>(
              "SELECT data FROM conversations WHERE account_key=? AND json_extract(data,'$.conversation.provider_chat_id')=?",
            )
            .get(accountKey, conversation.provider_chat_id);
          if (row) previous = JSON.parse(row.data);
        }
        // A local ownership replay must not restore pre-replacement provider IDs.
        if (
          !sourceAccountId &&
          previous?.sourceAccountId &&
          previous.conversation.id !== conversation.id
        )
          conversation = previous.conversation;
        const key = previous?.key ?? `linkedin:${accountKey}:${conversation.id}`;
        if (previous && previous.conversation.id !== conversation.id) {
          this.db
            .query(
              "UPDATE messages SET conversation_id=?,data=json_set(data,'$.conversation_id',?) WHERE account_key=? AND conversation_id=?",
            )
            .run(conversation.id, conversation.id, accountKey, previous.conversation.id);
        }
        const found = this.threadMatches(accountKey, conversation, matches);
        const owner = previous?.owner?.manual
          ? previous.owner
          : found.length === 1
            ? { workspace: found[0]!.workspace, prospectId: found[0]!.prospectId }
            : null;
        const row: LinkedInThreadRecord = {
          key,
          accountKey,
          conversation,
          owner,
          sourceAccountId: sourceAccountId ?? previous?.sourceAccountId,
        };
        this.db
          .query(
            "INSERT INTO conversations VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
          )
          .run(key, accountKey, JSON.stringify(row));
      })
      .immediate();
  }
  identity(accountKey: string, providerId: string): LinkedInIdentity | null {
    const row = this.db
      .query<{ data: string }, [string, string]>(
        "SELECT data FROM identities WHERE account_key=? AND provider_id=?",
      )
      .get(accountKey, providerId);
    return row ? JSON.parse(row.data) : null;
  }
  saveIdentity(accountKey: string, identity: LinkedInIdentity) {
    this.db
      .query(
        "INSERT INTO identities VALUES(?,?,?) ON CONFLICT(account_key,provider_id) DO UPDATE SET data=excluded.data",
      )
      .run(accountKey, identity.providerId, JSON.stringify(identity));
  }
  allMessages(accountKey: string): LinkedInMessage[] {
    return this.db
      .query<{ data: string }, [string]>("SELECT data FROM messages WHERE account_key=?")
      .all(accountKey)
      .map((r) => JSON.parse(r.data));
  }
  senderProfile(accountKey: string, c: LinkedInConversation, m: LinkedInMessage): string | null {
    if (m.sender_provider_id) {
      const cached = this.identity(accountKey, m.sender_provider_id)?.profile;
      if (cached) return cached;
      const attendee = c.attendees.find(
        (a) => !a.is_self && a.provider_id === m.sender_provider_id,
      );
      if (attendee)
        return verifiedLinkedInProfileKey(attendee.profile_url ?? "", attendee.provider_id);
      // A sender ID that disagrees with the attendee must never inherit their identity.
      if (c.attendees.some((a) => a.provider_id)) return null;
    }
    const peers = c.attendees.filter((a) => !a.is_self);
    return peers.length === 1
      ? verifiedLinkedInProfileKey(
          peers[0]!.profile_url ?? "",
          peers[0]!.provider_id ?? m.sender_provider_id,
        )
      : null;
  }
  messageMatches(
    accountKey: string,
    c: LinkedInConversation,
    m: LinkedInMessage,
    matches: LinkedInMatch[],
  ) {
    const profile = this.senderProfile(accountKey, c, m);
    return profile ? matches.filter((match) => match.profile === profile) : [];
  }
  threadMatches(accountKey: string, c: LinkedInConversation, matches: LinkedInMatch[]) {
    const direct = conversationMatches(c, matches);
    if (direct.length) return direct;
    const inbound = this.messages(accountKey, c.id).filter(
      (m) => m.direction === "inbound" && !m.deleted,
    );
    const profiles = new Set(inbound.map((m) => this.senderProfile(accountKey, c, m)));
    if (profiles.size !== 1 || profiles.has(null)) return [];
    return matches.filter((m) => profiles.has(m.profile));
  }
  counts(accountKey: string, matches: LinkedInMatch[]): Record<string, LinkedInWorkspaceCounts> {
    const messages = this.allMessages(accountKey);
    const conversations = new Map(
      this.threads(accountKey).map((t) => [t.conversation.id, t.conversation]),
    );
    const counts: Record<string, LinkedInWorkspaceCounts> = {};
    for (const w of replyWorkspaces()) {
      const c = (counts[w.name] = {
        imported: messages.length,
        matched: 0,
        unresolved: 0,
        noProspect: 0,
        stoppedCadences: 0,
      });
      const ledgerDb = openLedgerDatabase(join(w.home, "ledger.sqlite"), { readonly: true });
      try {
        if (ledgerDb.query("SELECT 1 FROM sqlite_master WHERE name='linkedin_cadence_stops'").get())
          c.stoppedCadences = (
            ledgerDb
              .query("SELECT COUNT(*) n FROM linkedin_cadence_stops WHERE account_key=?")
              .get(accountKey) as { n: number }
          ).n;
      } finally {
        ledgerDb.close();
      }
      for (const m of messages.filter(isHumanLinkedInReply)) {
        const conversation = conversations.get(m.conversation_id);
        const profile = conversation
          ? this.senderProfile(accountKey, conversation, m)
          : m.sender_provider_id
            ? this.identity(accountKey, m.sender_provider_id)?.profile
            : null;
        if (!profile) c.unresolved++;
        else if (matches.some((match) => match.workspace === w.name && match.profile === profile))
          c.matched++;
        else c.noProspect++;
      }
    }
    return counts;
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
  saveMessages(accountKey: string, messages: LinkedInMessage[], sourceAccountId?: string) {
    this.db.transaction(() => {
      for (const incoming of messages) {
        const existing = incoming.provider_message_id
          ? this.db
              .query<{ id: string }, [string, string]>(
                "SELECT id FROM messages WHERE account_key=? AND json_extract(data,'$.provider_message_id')=?",
              )
              .get(accountKey, incoming.provider_message_id)
          : null;
        const m = {
          ...incoming,
          id: existing?.id ?? incoming.id,
          ...(sourceAccountId ? { connectionId: sourceAccountId } : {}),
        };
        if (!this.threadForConversation(accountKey, m.conversation_id))
          this.saveConversation(
            accountKey,
            {
              id: m.conversation_id,
              provider_chat_id: "",
              name: m.sender_name,
              subject: null,
              type: null,
              attendees: [],
              attendees_synced: false,
              unread_count: 0,
              archived: false,
              read_only: 1,
              muted_until: null,
              last_message_at: m.sent_at,
              updated_at: m.updated_at,
            },
            [],
          );
        this.db
          .query(
            "INSERT INTO messages VALUES(?,?,?,?) ON CONFLICT(account_key,id) DO UPDATE SET data=excluded.data,conversation_id=excluded.conversation_id",
          )
          .run(accountKey, m.id, m.conversation_id, JSON.stringify(m));
      }
    })();
  }
  /** Upstream reconnects can change even provider IDs. Only unique exact cross-connection
   * message evidence may bridge chats; names and same-connection lookalikes never do. */
  reconcileReplacementHistory(accountKey: string) {
    const account = this.account(accountKey);
    if (!account?.previousAccountIds?.length) return;
    this.db
      .transaction(() => {
        type StoredMessage = LinkedInMessage & { connectionId?: string };
        const threads = new Map(this.threads(accountKey).map((t) => [t.conversation.id, t]));
        const grouped = new Map<string, StoredMessage[]>();
        for (const m of this.allMessages(accountKey) as StoredMessage[]) {
          if (!m.connectionId) {
            m.connectionId =
              threads.get(m.conversation_id)?.sourceAccountId ?? account.previousAccountIds![0];
            this.db
              .query("UPDATE messages SET data=? WHERE account_key=? AND id=?")
              .run(JSON.stringify(m), accountKey, m.id);
          }
          if (!m.sender_provider_id || !m.sent_at || !m.text?.trim()) continue;
          const fingerprint = JSON.stringify([
            m.sender_provider_id,
            m.direction,
            m.sent_at,
            m.text,
            (m.attachments ?? []).map((a) => [a.type, a.mimetype, a.size, a.file_name]),
          ]);
          const rows = grouped.get(fingerprint) ?? [];
          rows.push(m);
          grouped.set(fingerprint, rows);
        }
        const pairs: Array<{ old: StoredMessage; fresh: StoredMessage }> = [];
        const oldTargets = new Map<string, Set<string>>();
        const newSources = new Map<string, Set<string>>();
        for (const rows of grouped.values()) {
          const old = rows.filter((m) => m.connectionId !== account.account.id);
          const fresh = rows.filter((m) => m.connectionId === account.account.id);
          if (old.length !== 1 || fresh.length !== 1) continue;
          pairs.push({ old: old[0]!, fresh: fresh[0]! });
          const targets = oldTargets.get(old[0]!.conversation_id) ?? new Set<string>();
          targets.add(fresh[0]!.conversation_id);
          oldTargets.set(old[0]!.conversation_id, targets);
          const sources = newSources.get(fresh[0]!.conversation_id) ?? new Set<string>();
          sources.add(old[0]!.conversation_id);
          newSources.set(fresh[0]!.conversation_id, sources);
        }
        const merged = new Set<string>();
        for (const pair of pairs) {
          if (
            oldTargets.get(pair.old.conversation_id)?.size !== 1 ||
            newSources.get(pair.fresh.conversation_id)?.size !== 1
          )
            continue;
          const old = threads.get(pair.old.conversation_id),
            fresh = threads.get(pair.fresh.conversation_id);
          if (!old || !fresh || (fresh.key !== old.key && fresh.owner?.manual)) continue;
          if (!merged.has(old.key)) {
            const row = {
              ...old,
              conversation: fresh.conversation,
              sourceAccountId: account.account.id,
              owner: old.owner?.manual ? old.owner : (fresh.owner ?? old.owner),
            };
            this.db
              .query("UPDATE conversations SET data=? WHERE key=?")
              .run(JSON.stringify(row), old.key);
            if (old.key !== fresh.key)
              this.db.query("DELETE FROM conversations WHERE key=?").run(fresh.key);
            this.db
              .query(
                "UPDATE messages SET conversation_id=?,data=json_set(data,'$.conversation_id',?) WHERE account_key=? AND conversation_id=?",
              )
              .run(fresh.conversation.id, fresh.conversation.id, accountKey, old.conversation.id);
            for (const id of [old.conversation.id, fresh.conversation.id])
              this.db
                .query(
                  "INSERT INTO conversation_aliases VALUES(?,?,?) ON CONFLICT(account_key,conversation_id) DO UPDATE SET thread_key=excluded.thread_key",
                )
                .run(accountKey, id, old.key);
            merged.add(old.key);
          }
          this.db
            .query("UPDATE messages SET data=?,conversation_id=? WHERE account_key=? AND id=?")
            .run(
              JSON.stringify({ ...pair.fresh, id: pair.old.id }),
              pair.fresh.conversation_id,
              accountKey,
              pair.old.id,
            );
          this.db
            .query("DELETE FROM messages WHERE account_key=? AND id=?")
            .run(accountKey, pair.fresh.id);
          this.db
            .query("INSERT OR IGNORE INTO message_redirects VALUES(?,?,?)")
            .run(accountKey, pair.fresh.id, pair.old.id);
          this.db
            .query(
              "INSERT OR IGNORE INTO deliveries SELECT account_key,?,workspace,prospect_id FROM deliveries WHERE account_key=? AND message_id=?",
            )
            .run(pair.old.id, accountKey, pair.fresh.id);
          this.db
            .query("DELETE FROM deliveries WHERE account_key=? AND message_id=?")
            .run(accountKey, pair.fresh.id);
        }
      })
      .immediate();
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
      // Correct only the duplicate events introduced by reimport. Original attribution stays intact.
      const redirects = this.db
        .query<{ account_key: string; duplicate_id: string; canonical_id: string }, []>(
          "SELECT * FROM message_redirects",
        )
        .all();
      if (redirects.length)
        for (const home of new Set([
          ...replyWorkspaces().map((w) => w.home),
          ...matches.map((m) => m.home),
        ])) {
          const db = handles.database(home);
          db.transaction(() => {
            for (const r of redirects) {
              const oldId = `${r.account_key}:${r.canonical_id}`,
                duplicateId = `${r.account_key}:${r.duplicate_id}`;
              const original = db
                .query(
                  "SELECT prospect_id,occurred_at,body FROM channel_events WHERE source='oneshot-linkedin' AND external_event_id=?",
                )
                .get(oldId) as {
                prospect_id: number;
                occurred_at: string;
                body: string | null;
              } | null;
              if (!original)
                db.query(
                  "UPDATE channel_events SET external_event_id=? WHERE source='oneshot-linkedin' AND external_event_id=?",
                ).run(oldId, duplicateId);
              else
                db.query(
                  "DELETE FROM channel_events WHERE source='oneshot-linkedin' AND external_event_id=? AND prospect_id=? AND occurred_at=? AND body IS ?",
                ).run(duplicateId, original.prospect_id, original.occurred_at, original.body);
            }
          }).immediate();
        }
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
    const inbound = this.messages(t.accountKey, t.conversation.id).filter(isHumanLinkedInReply);
    if (!inbound.length) return;
    for (const m of inbound) {
      const targets = this.messageMatches(t.accountKey, t.conversation, m, matches);
      // Manual ownership remains authoritative for attribution. It does not hide other verified matches.
      if (
        t.owner?.manual &&
        !targets.some(
          (x) => x.workspace === t.owner!.workspace && x.prospectId === t.owner!.prospectId,
        )
      ) {
        const home = replyWorkspaces().find((w) => w.name === t.owner!.workspace)?.home;
        if (home) targets.push({ ...t.owner, home, name: "", profile: "" });
      }
      for (const match of targets) {
        const ledger = handles.ledger(match.home);
        if (!ledger.getProspectById(match.prospectId)) continue;
        const isOwner =
          match.workspace === t.owner?.workspace && match.prospectId === t.owner?.prospectId;
        const legacy =
          isOwner &&
          ledger
            .listChannelEventsForProspect(match.prospectId)
            .some(
              (e) =>
                e.source === "expandi" &&
                Date.parse(e.occurred_at) === Date.parse(m.sent_at) &&
                (e.body ?? "").trim() === (m.text ?? "").trim(),
            );
        // Always replay suppression. Delivery markers deduplicate attribution, never suppression.
        const eventId = `${t.accountKey}:${m.id}`;
        const existing = handles
          .database(match.home)
          .query(
            "SELECT prospect_id FROM channel_events WHERE source='oneshot-linkedin' AND external_event_id=?",
          )
          .get(eventId) as { prospect_id: number } | null;
        isOwner && !legacy && (!existing || existing.prospect_id === match.prospectId)
          ? ledger.recordLinkedInReply({
              prospectId: match.prospectId,
              accountKey: t.accountKey,
              source: "oneshot-linkedin",
              externalEventId: eventId,
              occurredAt: m.sent_at,
              body: m.text,
            })
          : ledger.suppressCadencesForReply(match.prospectId, t.accountKey);
        if (isOwner)
          this.db
            .query("INSERT OR IGNORE INTO deliveries VALUES(?,?,?,?)")
            .run(t.accountKey, m.id, match.workspace, match.prospectId);
      }
    }
  }
}
let singleton: LinkedInInboxStore | undefined;
export function getLinkedInInboxStore() {
  return (singleton ??= new LinkedInInboxStore());
}
