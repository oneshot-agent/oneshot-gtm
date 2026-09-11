import { contactAllowedClause } from "./contact-optout.ts";
import { extractBusinessAddress } from "./mail-address.ts";
import type { DirectMailDraft, PostalAddress } from "./direct-mail.ts";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./config.ts";
import {
  hasPersonSignal,
  mergePersonDossier,
  mergeProductDossier,
  type ProductResearchDossier,
} from "./dossier.ts";
import {
  bounceStatsByIdentity as delivBounceStatsByIdentity,
  contactSuppressionFor as delivContactSuppressionFor,
  countAutoPermanentBounces as delivCountAutoPermanentBounces,
  countBounces as delivCountBounces,
  latestCanaryResult as delivLatestCanaryResult,
  latestSentEmailCopy as delivLatestSentEmailCopy,
  listRecentBounces as delivListRecentBounces,
  recordBounce as delivRecordBounce,
  recordCanaryResult as delivRecordCanaryResult,
  suppressionFor as delivSuppressionFor,
} from "./delivery-health.ts";
import { humanDecisionWhereSql } from "./labels.ts";
import { LedgerCache } from "./ledger-cache.ts";
import { migrateLedgerSchema } from "./ledger-schema.ts";
import { MailboxStore } from "./mailbox-store.ts";
import { ReceiptStore } from "./ledger-receipts.ts";
import { getSharedDb } from "./shared-db.ts";
import type { ReplyKind } from "./reply-classify.ts";
import type {
  AuthVerdict,
  BounceKind,
  BounceRecord,
  CanaryResultRecord,
  ChannelEventRecord,
  DealOutcomeRecord,
  GmailPlacement,
  InboxReplyRecord,
  IcpDecisionExample,
  InterviewRecord,
  MeetingMatchMethod,
  MeetingMatchStatus,
  MeetingOutcome,
  MeetingRecord,
  ProspectPriority,
  ProspectRecord,
  SentOutcomeRawRow,
  QueueRow,
  QueueSearchOpts,
  QueueSearchRow,
  QueueStatus,
  ReceiptRecord,
  SequenceEventRecord,
  TriggerRow,
} from "./types.ts";

const ICP_EXAMPLE_FIELDS = [
  "title",
  "url",
  "summary",
  "author",
  "description",
  "postTitle",
  "postUrl",
  "repo",
  "repoUrl",
  "eventName",
  "eventUrl",
  "company",
] as const;

/** Keep classifier examples useful without returning enriched contact data. */
function icpExampleCandidate(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const source = payload as Record<string, unknown>;
  return Object.fromEntries(
    ICP_EXAMPLE_FIELDS.flatMap((field) => {
      const value = source[field];
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? [[field, value] as const]
        : [];
    }),
  );
}

const DEFAULT_DB_PATH = join(configDir(), "ledger.sqlite");

// Cache TTL/deadline constants and all cache get/set/expiry/invalidation
// implementations live in ledger-cache.ts (#618) — re-exported here so every
// existing `import { ENRICH_CACHE_TTL_MS, ... } from "./ledger.ts"` (and the
// package's `export * from "./ledger.ts"` barrel) keeps resolving unchanged.
export {
  ENRICH_CACHE_TTL_MS,
  ENRICH_DEADLINE_MS,
  ENRICH_FAILURE_TTL_MS,
  LINKEDIN_CACHE_TTL_MS,
  LINKEDIN_MISS_TTL_MS,
  RESEARCH_CACHE_TTL_MS,
  RESEARCH_DEADLINE_MS,
} from "./ledger-cache.ts";

const QUEUE_STATUSES: readonly QueueStatus[] = [
  "pending",
  "approved",
  "rejected",
  "sent",
  "expired",
];

/** USD as integer cents, so money comparisons are exact. */
function cents(usd: number): number {
  return Math.round(usd * 100);
}

/** Escape a user term for `LIKE ? ESCAPE '\'` so `%` and `_` match literally. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The searchable text of a queue row for `searchQueue`: every identity key a
 * finder writes into `payload_json` (the same keys the /queue row reads —
 * `name`/`founderName`, `email`/`founderEmail`, company, title, the show-hn
 * post, the repo/post URLs a pre-enrichment reject only carries, LinkedIn),
 * plus the reviewer's notes, the play, and the joined prospect record. Built
 * once as a string so each term binds against the same expression.
 *
 * No LOWER(): bun's SQLite has no ICU, so LOWER() and LIKE fold ASCII only.
 * Case-insensitivity for non-ASCII letters comes from binding each term
 * twice (see `likePatternsFor`) rather than from a wrapper that would leave
 * "Émile" unfindable by "émile".
 */
const QUEUE_SEARCH_HAYSTACK = `(${[
  "name",
  "founderName",
  "email",
  "founderEmail",
  "company",
  "title",
  "postTitle",
  "repoUrl",
  "postUrl",
  "linkedinUrl",
]
  .map((key) => `COALESCE(json_extract(b.payload_json, '$.${key}'), '')`)
  .concat([
    "COALESCE(b.notes, '')",
    "b.play_name",
    "COALESCE(p.name, '')",
    "COALESCE(p.email, '')",
    "COALESCE(p.company, '')",
    "COALESCE(p.title, '')",
  ])
  .join(" || ' ' || ")})`;

/**
 * Bind patterns for one search term. LIKE already folds ASCII case, so an
 * ASCII term needs one pattern; a term with non-ASCII letters is bound in
 * lower and upper case, which together also catch title case ("Émile"
 * matches the upper pattern because every ASCII letter after É folds).
 */
function likePatternsFor(term: string): string[] {
  const lower = term.toLowerCase();
  const upper = term.toUpperCase();
  // eslint-disable-next-line no-control-regex
  if (lower === upper || !/[^\x00-\x7f]/.test(term)) return [`%${escapeLike(lower)}%`];
  return [`%${escapeLike(lower)}%`, `%${escapeLike(upper)}%`];
}

/** Best display name for a queue row: the prospect record, then the payload. */
const QUEUE_SEARCH_NAME_EXPR = `COALESCE(NULLIF(p.name, ''), NULLIF(json_extract(b.payload_json, '$.name'), ''), NULLIF(json_extract(b.payload_json, '$.founderName'), ''))`;

/**
 * Canonical form for matching prospect emails — trim + lowercase. Inbound reply
 * addresses (cadence inbox poll) are normalized the same way, so a prospect
 * stored from a mixed-case address still matches when they reply. Applied on
 * both store (upsertProspect) and every lookup so the two never diverge.
 */
function canonEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Stable LinkedIn profile key across www/mobile hosts, schemes, query strings and trailing slashes. */
export function canonicalLinkedInProfileKey(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
    const match = /^\/in\/([^/]+)\/?$/i.exec(url.pathname);
    if (!match?.[1]) return null;
    return `linkedin.com/in/${decodeURIComponent(match[1]).toLowerCase()}`;
  } catch {
    return null;
  }
}

function safeParseJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** A `cadence_state` row joined with the prospect details needed by cadence surfaces. */
export interface CadenceWithProspect {
  prospect_id: number;
  play_name: string;
  current_step: number;
  status: string;
  enrolled_at: string;
  next_due_at: string | null;
  last_polled_at: string | null;
  stop_reason: string | null;
  stop_note: string | null;
  stopped_at: string | null;
  next_step_draft_json: string | null;
  next_step_drafted_at: string | null;
  /**
   * ISO timestamp when a fire-and-forget send was claimed for this cadence.
   * Null = no send in flight. Survives server restart so the UI's "sending"
   * spinner doesn't get stranded by a `bun --watch` reload mid-SDK-call.
   */
  sending_started_at: string | null;
  /** Last send-failure message (truncated); cleared on any forward progress.
   *  Non-null = the most recent send attempt failed and nothing has succeeded
   *  since — drives the "send failed · retrying" row indicator. */
  last_send_error: string | null;
  /** ISO timestamp of `last_send_error`. */
  last_send_error_at: string | null;
  prospect_email: string | null;
  prospect_name: string | null;
  prospect_company: string | null;
  prospect_title: string | null;
  prospect_linkedin_url: string | null;
  reply_channel: "email" | "linkedin" | null;
  replied_at: string | null;
}

/**
 * Subject as a thread key: reply/forward prefixes stripped (en/de/fr/es/sv/
 * pt/nl variants, repeated), case-folded, whitespace collapsed. Empty → null.
 */
function normalizeSubject(subject: string | null | undefined): string | null {
  if (!subject) return null;
  let s = subject.trim();
  // Each `\s*` is reachable by exactly one path, so a run of spaces can't be
  // split between two of them (CodeQL: polynomial backtracking).
  const prefix = /^(?:re|fw|fwd|aw|wg|sv|vs|rv|enc|tr|antw)(?:\s*\[\d+\])?\s*:\s*/i;
  while (prefix.test(s)) s = s.replace(prefix, "");
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s.length > 0 ? s : null;
}

/**
 * Sentinel written into `inbox_replies.intent` by `claimInboxReplyForTriage`
 * to atomically mark "a caller is triaging this row right now" without
 * committing to a real category yet. Never a valid `TriageCategory` /
 * `ReplyIntent` value, and never read back as a classification: every reader
 * of `intent` (`listInboxReplyIntents`, the /inbox route, `POSITIVE_REPLY_INTENTS`
 * checks) only sees it during the brief window between the claim and the
 * winner's `setInboxReplyIntent` call overwriting it with the real result (or
 * NULL on failure) — same transaction-scoped visibility any other in-flight
 * write has.
 */
const INBOX_REPLY_TRIAGE_PENDING = "__triage_pending__";

/**
 * The claim sentinel is bookkeeping, not a classification: every reader of
 * `intent` gets NULL back for it (#559), so the column's `ReplyIntent | null`
 * contract holds even during the window a triage call is in flight.
 */
function publicIntent(intent: string | null): string | null {
  return intent === INBOX_REPLY_TRIAGE_PENDING ? null : intent;
}

export class Ledger {
  readonly mailboxes: MailboxStore;
  private db: Database;
  private path: string;
  private receipts: ReceiptStore;
  private cache: LedgerCache;

  constructor(path: string = DEFAULT_DB_PATH) {
    this.path = path;
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    // Wait (don't immediately throw) when another connection holds the write
    // lock — e.g. a background send and a request both opening the ledger, or
    // parallel test workers running first-run migrations against a shared file.
    // Without this, concurrent DDL surfaces as a spurious "database is locked"
    // / "no such table" mid-migration.
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
    // Receipt reads/writes/attribution/aggregation live in ledger-receipts.ts
    // (see its doc comment) — extracted as the next slice of the ledger split
    // tracked in ROADMAP.md, following the schema extraction in #452.
    // Constructed AFTER migrate() so the receipts table already exists.
    this.receipts = new ReceiptStore(this.db);
    // Same slice, same reason: the cache tables exist only after migrate().
    this.cache = new LedgerCache(this.db, this.path);
    this.mailboxes = new MailboxStore(this.db);
  }

  getDirectMail(id: string): DirectMailDraft | null {
    const row = this.db.query("SELECT data FROM direct_mail_drafts WHERE id=?").get(id) as {
      data: string;
    } | null;
    return row ? JSON.parse(row.data) : null;
  }
  listDirectMail(): DirectMailDraft[] {
    return (
      this.db.query("SELECT data FROM direct_mail_drafts ORDER BY rowid DESC").all() as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data));
  }
  findDirectMail(
    prospect: number,
    play: string,
    enrollment: string,
    step: number,
  ): DirectMailDraft | null {
    const row = this.db
      .query(
        "SELECT data FROM direct_mail_drafts WHERE prospect_id=? AND play_name=? AND enrollment=? AND step_index=?",
      )
      .get(prospect, play, enrollment, step) as { data: string } | null;
    return row ? JSON.parse(row.data) : null;
  }
  saveDirectMail(draft: DirectMailDraft): void {
    this.db
      .transaction(() => {
        const previous = this.getDirectMail(draft.id);
        if (previous && previous.revision !== draft.revision)
          throw new Error("Mailpiece changed; refresh before retrying");
        const next = { ...draft, revision: (draft.revision ?? 0) + 1 };
        this.db
          .query(
            "INSERT INTO direct_mail_drafts(id,prospect_id,play_name,enrollment,step_index,data) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
          )
          .run(
            next.id,
            next.prospectId,
            next.playName,
            next.enrollment,
            next.stepIndex,
            JSON.stringify(next),
          );
        draft.revision = next.revision;
      })
      .immediate();
  }
  deleteDirectMail(id: string): void {
    this.db
      .query(
        "DELETE FROM direct_mail_drafts WHERE id=? AND coalesce(json_extract(data,'$.started'),0)=0",
      )
      .run(id);
  }
  getCadencePlan(
    prospectId: number,
    playName: string,
    enrollment: string,
  ): import("./types.ts").CadencePlanStep[] | null {
    const row = this.db
      .query("SELECT steps FROM cadence_plans WHERE prospect_id=? AND play_name=? AND enrollment=?")
      .get(prospectId, playName, enrollment) as { steps: string } | null;
    return row ? JSON.parse(row.steps) : null;
  }
  saveCadencePlan(
    prospectId: number,
    playName: string,
    enrollment: string,
    steps: import("./types.ts").CadencePlanStep[],
  ): void {
    this.db
      .query(
        "INSERT INTO cadence_plans VALUES(?,?,?,?) ON CONFLICT(prospect_id,play_name,enrollment) DO UPDATE SET steps=excluded.steps",
      )
      .run(prospectId, playName, enrollment, JSON.stringify(steps));
  }
  setMailAddress(key: string, address: PostalAddress, source = "manual"): void {
    this.db
      .transaction(() => {
        this.db
          .query(
            "INSERT INTO direct_mail_addresses VALUES (?,?) ON CONFLICT(key) DO UPDATE SET address=excluded.address",
          )
          .run(key, JSON.stringify(address));
        this.setMailAddressMetadata(key, { source, collectedAt: new Date().toISOString() });
      })
      .immediate();
  }
  setMailAddressMetadata(key: string, data: Record<string, unknown>): void {
    this.db
      .query(
        "INSERT INTO mail_address_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      )
      .run(key, JSON.stringify(data));
  }
  getMailAddressMetadata(key: string): Record<string, unknown> | null {
    const row = this.db.query("SELECT data FROM mail_address_metadata WHERE key=?").get(key) as {
      data: string;
    } | null;
    return row ? JSON.parse(row.data) : null;
  }
  getMailPreparation(
    prospectId: number,
    playName: string,
    enrollment: string,
    stepIndex: number,
  ): import("./direct-mail.ts").MailPreparation | null {
    const row = this.db
      .query(
        "SELECT data FROM mail_preparations WHERE prospect_id=? AND play_name=? AND enrollment=? AND step_index=?",
      )
      .get(prospectId, playName, enrollment, stepIndex) as { data: string } | null;
    return row ? JSON.parse(row.data) : null;
  }
  saveMailPreparation(
    prospectId: number,
    playName: string,
    enrollment: string,
    stepIndex: number,
    data: import("./direct-mail.ts").MailPreparation,
  ): void {
    this.db
      .query(
        "INSERT INTO mail_preparations VALUES(?,?,?,?,?) ON CONFLICT(prospect_id,play_name,enrollment,step_index) DO UPDATE SET data=excluded.data",
      )
      .run(prospectId, playName, enrollment, stepIndex, JSON.stringify(data));
  }
  deleteMailPreparation(
    prospectId: number,
    playName: string,
    enrollment: string,
    stepIndex: number,
  ): void {
    this.db
      .query(
        "DELETE FROM mail_preparations WHERE prospect_id=? AND play_name=? AND enrollment=? AND step_index=?",
      )
      .run(prospectId, playName, enrollment, stepIndex);
  }
  setMailAddresses(prospect: number, to: PostalAddress, from: PostalAddress): void {
    const put = this.db.query(
      "INSERT INTO direct_mail_addresses(key,address) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET address=excluded.address",
    );
    this.db
      .transaction(() => {
        put.run(`prospect:${prospect}`, JSON.stringify(to));
        put.run("return", JSON.stringify(from));
      })
      .immediate();
  }
  getMailAddress(key: string): PostalAddress | null {
    const row = this.db.query("SELECT address FROM direct_mail_addresses WHERE key=?").get(key) as {
      address: string;
    } | null;
    return row ? JSON.parse(row.address) : null;
  }
  recordMailReceipt(receipt: string, input: Parameters<Ledger["recordReceipt"]>[0]): number {
    return this.db
      .transaction(() => {
        const previous = this.db
          .query("SELECT local_id FROM direct_mail_receipts WHERE receipt_id=?")
          .get(receipt) as { local_id: number } | null;
        if (previous) {
          if (input.signedReceipt)
            this.db
              .query("UPDATE receipts SET signed_receipt=? WHERE id=?")
              .run(JSON.stringify(input.signedReceipt), previous.local_id);
          return previous.local_id;
        }
        const id = this.recordReceipt(input);
        this.db
          .query("INSERT INTO direct_mail_receipts(receipt_id,local_id) VALUES (?,?)")
          .run(receipt, id);
        return id;
      })
      .immediate();
  }

  private migrate(): void {
    // Fresh-install schema construction + inline column/table migrations
    // live in ledger-schema.ts (see its doc comment) — extracted so the
    // highest-risk inline DDL in this file can be tested and read in
    // isolation from the domain methods below.
    migrateLedgerSchema(this.db);
  }

  /**
   * CAS-claim a timestamp marker on a single row: true when the marker was
   * NULL (or older than `staleCutoffIso`) and was set; false when another
   * caller holds the claim. Shared by every in-flight marker in the ledger.
   * Table/column names are whitelisted to bare ASCII (SQLite can't bind them).
   */
  private claimMarker(opts: {
    table: string;
    pkeyWhere: string;
    column: string;
    pkeyValues: unknown[];
    startedAtIso: string;
    staleCutoffIso?: string;
  }): boolean {
    this.assertSafeIdentifiers(opts.table, opts.column);
    const staleClause = opts.staleCutoffIso
      ? ` AND (${opts.column} IS NULL OR ${opts.column} < ?)`
      : ` AND ${opts.column} IS NULL`;
    const args = opts.staleCutoffIso
      ? [opts.startedAtIso, ...opts.pkeyValues, opts.staleCutoffIso]
      : [opts.startedAtIso, ...opts.pkeyValues];
    const result = this.db
      .prepare(
        `UPDATE ${opts.table}
         SET ${opts.column} = ?
         WHERE ${opts.pkeyWhere}${staleClause}`,
      )
      .run(...(args as never[]));
    return result.changes > 0;
  }

  /**
   * Release a timestamp marker (set to NULL). Idempotent — no-op if the row
   * doesn't exist or the column is already NULL.
   */
  private clearMarker(opts: {
    table: string;
    pkeyWhere: string;
    column: string;
    pkeyValues: unknown[];
  }): void {
    this.assertSafeIdentifiers(opts.table, opts.column);
    this.db
      .prepare(`UPDATE ${opts.table} SET ${opts.column} = NULL WHERE ${opts.pkeyWhere}`)
      .run(...(opts.pkeyValues as never[]));
  }

  private assertSafeIdentifiers(table: string, column: string): void {
    const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
    if (!ident.test(table) || !ident.test(column)) {
      throw new Error(`unsafe identifier in marker helper: ${table}.${column}`);
    }
  }

  enrollCadence(input: { prospectId: number; playName: string; nextDueAt: string }): void {
    this.db
      .prepare(
        `INSERT INTO cadence_state(prospect_id, play_name, current_step, status, next_due_at)
         VALUES(?, ?, 0, 'active', ?)
         ON CONFLICT(prospect_id, play_name) DO UPDATE SET
           status = 'active',
           next_due_at = excluded.next_due_at,
           last_polled_at = NULL,
           stop_reason = NULL,
           stop_note = NULL,
           stopped_at = NULL,
           last_send_error = NULL,
           last_send_error_at = NULL
         WHERE cadence_state.status != 'stopped'`,
      )
      .run(input.prospectId, input.playName, input.nextDueAt);
  }

  listActiveCadences(opts: { dueByIso?: string } = {}): CadenceWithProspect[] {
    const where: string[] = ["c.status = 'active'"];
    const args: unknown[] = [];
    if (opts.dueByIso) {
      where.push("(c.next_due_at IS NULL OR c.next_due_at <= ?)");
      args.push(opts.dueByIso);
    }
    const sql = `
      SELECT c.*, p.email AS prospect_email, p.name AS prospect_name, p.company AS prospect_company,
             p.title AS prospect_title, p.linkedin_url AS prospect_linkedin_url,
             (SELECT channel FROM (
                SELECT 'email' AS channel, received_at AS at FROM inbox_replies WHERE prospect_id = p.id AND coalesce(kind,'human') = 'human'
                UNION ALL
                SELECT channel, occurred_at AS at FROM channel_events WHERE prospect_id = p.id AND event_type = 'reply'
              ) ORDER BY at DESC LIMIT 1) AS reply_channel,
             (SELECT at FROM (
                SELECT received_at AS at FROM inbox_replies WHERE prospect_id = p.id AND coalesce(kind,'human') = 'human'
                UNION ALL
                SELECT occurred_at AS at FROM channel_events WHERE prospect_id = p.id AND event_type = 'reply'
              ) ORDER BY at DESC LIMIT 1) AS replied_at
      FROM cadence_state c
      JOIN prospects p ON p.id = c.prospect_id
      WHERE ${where.join(" AND ")}
      ORDER BY c.next_due_at ASC NULLS LAST
    `;
    return this.db.query(sql).all(...(args as never[])) as never;
  }

  listAllCadences(): CadenceWithProspect[] {
    const sql = `
      SELECT c.*, p.email AS prospect_email, p.name AS prospect_name, p.company AS prospect_company,
             p.title AS prospect_title, p.linkedin_url AS prospect_linkedin_url,
             (SELECT channel FROM (
                SELECT 'email' AS channel, received_at AS at FROM inbox_replies WHERE prospect_id = p.id AND coalesce(kind,'human') = 'human'
                UNION ALL SELECT channel, occurred_at AS at FROM channel_events WHERE prospect_id = p.id AND event_type = 'reply'
              ) ORDER BY at DESC LIMIT 1) AS reply_channel,
             (SELECT at FROM (
                SELECT received_at AS at FROM inbox_replies WHERE prospect_id = p.id AND coalesce(kind,'human') = 'human'
                UNION ALL SELECT occurred_at AS at FROM channel_events WHERE prospect_id = p.id AND event_type = 'reply'
              ) ORDER BY at DESC LIMIT 1) AS replied_at
      FROM cadence_state c
      JOIN prospects p ON p.id = c.prospect_id
      ORDER BY c.status ASC, c.next_due_at ASC NULLS LAST
    `;
    return this.db.query(sql).all() as never;
  }

  /**
   * Single cadence (joined with its prospect) by (prospect_id, play_name) — an
   * index seek on the `cadence_state` PRIMARY KEY. Replaces the O(n)
   * `listAllCadences().find(...)` scan callers used to do per row.
   */
  getCadence(prospectId: number, playName: string): CadenceWithProspect | null {
    const sql = `
      SELECT c.*, p.email AS prospect_email, p.name AS prospect_name, p.company AS prospect_company,
             p.title AS prospect_title, p.linkedin_url AS prospect_linkedin_url,
             (SELECT channel FROM (
                SELECT 'email' AS channel, received_at AS at FROM inbox_replies WHERE prospect_id = p.id AND coalesce(kind,'human') = 'human'
                UNION ALL SELECT channel, occurred_at AS at FROM channel_events WHERE prospect_id = p.id AND event_type = 'reply'
              ) ORDER BY at DESC LIMIT 1) AS reply_channel,
             (SELECT at FROM (
                SELECT received_at AS at FROM inbox_replies WHERE prospect_id = p.id AND coalesce(kind,'human') = 'human'
                UNION ALL SELECT occurred_at AS at FROM channel_events WHERE prospect_id = p.id AND event_type = 'reply'
              ) ORDER BY at DESC LIMIT 1) AS replied_at
      FROM cadence_state c
      JOIN prospects p ON p.id = c.prospect_id
      WHERE c.prospect_id = ? AND c.play_name = ?
    `;
    return (this.db.query(sql).get(prospectId, playName) as CadenceWithProspect) ?? null;
  }

  /** All cadences for one prospect — index seek on cadence_state.prospect_id (PK prefix). */
  listCadencesForProspect(prospectId: number): CadenceWithProspect[] {
    const sql = `
      SELECT c.*, p.email AS prospect_email, p.name AS prospect_name, p.company AS prospect_company,
             p.title AS prospect_title, p.linkedin_url AS prospect_linkedin_url,
             (SELECT channel FROM (
                SELECT 'email' AS channel, received_at AS at FROM inbox_replies WHERE prospect_id = p.id AND coalesce(kind,'human') = 'human'
                UNION ALL SELECT channel, occurred_at AS at FROM channel_events WHERE prospect_id = p.id AND event_type = 'reply'
              ) ORDER BY at DESC LIMIT 1) AS reply_channel,
             (SELECT at FROM (
                SELECT received_at AS at FROM inbox_replies WHERE prospect_id = p.id AND coalesce(kind,'human') = 'human'
                UNION ALL SELECT occurred_at AS at FROM channel_events WHERE prospect_id = p.id AND event_type = 'reply'
              ) ORDER BY at DESC LIMIT 1) AS replied_at
      FROM cadence_state c
      JOIN prospects p ON p.id = c.prospect_id
      WHERE c.prospect_id = ?
      ORDER BY c.status ASC, c.next_due_at ASC NULLS LAST
    `;
    return this.db.query(sql).all(prospectId) as never;
  }

  advanceCadence(input: {
    prospectId: number;
    playName: string;
    newStep: number;
    nextDueAt: string | null;
  }): void {
    // Also clear any persisted next-step draft AND the sending marker — the
    // draft was for the OLD next step (stale after advance), and a successful
    // advance means the in-flight send for this row is done. /cadences will
    // surface a fresh "no preview yet" state.
    // A successful advance also clears any prior send-failure marker (the send
    // that just advanced us obviously succeeded).
    this.db
      .prepare(
        `UPDATE cadence_state
         SET current_step = ?, next_due_at = ?, last_polled_at = datetime('now'),
             next_step_draft_json = NULL, next_step_drafted_at = NULL,
             sending_started_at = NULL,
             last_send_error = NULL, last_send_error_at = NULL
         WHERE prospect_id = ? AND play_name = ?`,
      )
      .run(input.newStep, input.nextDueAt, input.prospectId, input.playName);
  }

  /**
   * Record the last cadence send FAILURE so /cadences can show the row is
   * blocked upstream (vs. waiting on the founder). Cleared by advanceCadence /
   * setCadenceStatus on any forward progress. No-op if the row is gone.
   */
  recordCadenceSendError(input: { prospectId: number; playName: string; error: string }): void {
    this.db
      .prepare(
        `UPDATE cadence_state
         SET last_send_error = ?, last_send_error_at = datetime('now')
         WHERE prospect_id = ? AND play_name = ?`,
      )
      .run(input.error.slice(0, 200), input.prospectId, input.playName);
  }

  setCadenceStatus(input: {
    prospectId: number;
    playName: string;
    status: "active" | "replied" | "breakup" | "completed" | "bounced" | "off-icp" | "unsubscribed";
  }): void {
    // Non-active terminal states clear the persisted draft AND any send
    // marker — a replied / breakup / completed / bounced cadence shouldn't have
    // a sendable preview hanging around or a stuck "sending" flag. A reply /
    // breakup / completion / bounce also clears any stale send-failure marker
    // (for a bounce that marker is actively misleading: it reads as
    // "retrying", but a dead address will never accept a retry).
    this.db
      .prepare(
        `UPDATE cadence_state
         SET status = ?,
             next_step_draft_json = CASE WHEN ? = 'active' THEN next_step_draft_json ELSE NULL END,
             next_step_drafted_at = CASE WHEN ? = 'active' THEN next_step_drafted_at ELSE NULL END,
             sending_started_at = CASE WHEN ? = 'active' THEN sending_started_at ELSE NULL END,
             last_send_error = CASE WHEN ? = 'active' THEN last_send_error ELSE NULL END,
             last_send_error_at = CASE WHEN ? = 'active' THEN last_send_error_at ELSE NULL END
         WHERE prospect_id = ? AND play_name = ?`,
      )
      .run(
        input.status,
        input.status,
        input.status,
        input.status,
        input.status,
        input.status,
        input.prospectId,
        input.playName,
      );
  }

  stopCadence(input: {
    prospectId: number;
    playName: string;
    reason: "bad_timing" | "other" | "not_a_fit" | "do_not_contact";
    note?: string;
  }): boolean {
    let changed = false;
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE cadence_state
           SET status = 'stopped', stop_reason = ?, stop_note = ?, stopped_at = datetime('now'),
               next_due_at = NULL,
               next_step_draft_json = NULL, next_step_drafted_at = NULL,
               sending_started_at = NULL, last_send_error = NULL, last_send_error_at = NULL
           WHERE prospect_id = ? AND play_name = ? AND status = 'active'
             AND sending_started_at IS NULL`,
        )
        .run(input.reason, input.note?.trim() || null, input.prospectId, input.playName);
      changed = result.changes > 0;
      if (changed) {
        this.expireBreakupReviveQueue(input.prospectId, "cadence stopped");
      }
    })();
    return changed;
  }

  setCadenceDraft(input: {
    prospectId: number;
    playName: string;
    draft: {
      subject: string;
      body: string;
      flags: string[];
      payload: unknown;
    };
  }): void {
    const draftedAtIso = new Date().toISOString();
    const json = JSON.stringify({ ...input.draft, draftedAt: draftedAtIso });
    this.db
      .prepare(
        `UPDATE cadence_state
         SET next_step_draft_json = ?, next_step_drafted_at = ?
         WHERE prospect_id = ? AND play_name = ?`,
      )
      .run(json, draftedAtIso, input.prospectId, input.playName);
  }

  getCadenceDraft(input: { prospectId: number; playName: string }): {
    subject: string;
    body: string;
    flags: string[];
    payload: unknown;
    draftedAt: string;
  } | null {
    const row = this.db
      .query(
        `SELECT next_step_draft_json AS j FROM cadence_state
         WHERE prospect_id = ? AND play_name = ?`,
      )
      .get(input.prospectId, input.playName) as { j: string | null } | null;
    if (!row?.j) return null;
    try {
      return JSON.parse(row.j) as {
        subject: string;
        body: string;
        flags: string[];
        payload: unknown;
        draftedAt: string;
      };
    } catch {
      return null;
    }
  }

  clearCadenceDraft(input: { prospectId: number; playName: string }): void {
    this.db
      .prepare(
        `UPDATE cadence_state
         SET next_step_draft_json = NULL, next_step_drafted_at = NULL
         WHERE prospect_id = ? AND play_name = ?`,
      )
      .run(input.prospectId, input.playName);
  }

  /**
   * Save (or overwrite) the single in-progress draft for an inbox thread.
   * Backs the /inbox composer's debounced auto-save so a refresh or navigation
   * away no longer discards the draft. Keyed by thread_key (see `inboxThreadKey`
   * in shared-types) — Gmail thread_id, else the email id.
   *
   * `status` is recomputed by the CALLER on every save from the body's own
   * lint state (issue #480's `commits-terms` flag) — never trust a
   * client-sent value, so the caller passes the freshly-computed verdict.
   * `steer` is deliberately NOT part of this statement: an ordinary autosave
   * must never clobber a standing founder instruction. Use
   * `setInboxDraftSteer` for that.
   */
  upsertInboxDraft(input: {
    threadKey: string;
    inboundEmailId: string;
    toEmail: string;
    subject: string;
    identityId: string | null;
    body: string;
    status?: "needs_decision" | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO inbox_drafts(thread_key, inbound_email_id, to_email, subject, identity_id, body, status, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_key) DO UPDATE SET
           inbound_email_id = excluded.inbound_email_id,
           to_email = excluded.to_email,
           subject = excluded.subject,
           identity_id = excluded.identity_id,
           body = excluded.body,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.threadKey,
        input.inboundEmailId,
        input.toEmail,
        input.subject,
        input.identityId,
        input.body,
        input.status ?? null,
        new Date().toISOString(),
      );
  }

  /**
   * Persist the founder's standing redraft instruction for a thread (issue
   * #480's steer box) — a no-op if the thread has no draft row yet (the
   * steer route always upserts a draft first, so this is only ever called
   * after that succeeds).
   */
  setInboxDraftSteer(threadKey: string, steer: string | null): void {
    this.db.prepare(`UPDATE inbox_drafts SET steer = ? WHERE thread_key = ?`).run(steer, threadKey);
  }

  /**
   * Persist a server-generated draft body (round-1 correction, #480's steer
   * flow): `steerRoute` computes a redraft and returned it to the client
   * without ever writing it back to `inbox_drafts`, so the debounced
   * autosave (which only fires on a body DIFF) never saw a change and the
   * redraft was lost on refresh/collapse. Mirrors `saveDraftRoute`'s body
   * write but leaves `steer` and every other column untouched — the standing
   * steer instruction is set separately via `setInboxDraftSteer` and must
   * survive this call.
   */
  setInboxDraftBody(threadKey: string, body: string, status: "needs_decision" | null): void {
    this.db
      .prepare(`UPDATE inbox_drafts SET body = ?, status = ?, updated_at = ? WHERE thread_key = ?`)
      .run(body, status, new Date().toISOString(), threadKey);
  }

  clearInboxDraft(threadKey: string): void {
    this.db.prepare(`DELETE FROM inbox_drafts WHERE thread_key = ?`).run(threadKey);
  }

  /**
   * Record a reply that was actually sent (append to history) and clear the
   * thread's draft in one transaction. History is append-only because we let
   * the founder reply again on the same thread.
   */
  recordInboxSent(input: {
    threadKey: string;
    toEmail: string;
    subject: string;
    body: string;
    identityId: string | null;
    requestId: string | null;
  }): void {
    this.db.transaction(() => {
      if (
        input.requestId &&
        this.db
          .query("SELECT 1 FROM inbox_sent WHERE request_id=? AND identity_id IS ? LIMIT 1")
          .get(input.requestId, input.identityId)
      )
        return;
      this.db
        .prepare(
          `INSERT INTO inbox_sent(thread_key, to_email, subject, body, identity_id, request_id, sent_at)
           VALUES(?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.threadKey,
          input.toEmail,
          input.subject,
          input.body,
          input.identityId,
          input.requestId,
          new Date().toISOString(),
        );
      this.db.prepare(`DELETE FROM inbox_drafts WHERE thread_key = ?`).run(input.threadKey);
    })();
  }

  /**
   * Bulk-read persisted reply state for the inbox list route: the saved draft
   * (if any) plus the sent history per thread. Mirrors the `byEmail` map the
   * list route builds for cadence context — one read, indexed by thread_key.
   */
  getInboxThreads(): Map<
    string,
    {
      draftBody: string | null;
      sent: { body: string; sentAt: string }[];
      steer: string | null;
      status: "needs_decision" | null;
    }
  > {
    const map = new Map<
      string,
      {
        draftBody: string | null;
        sent: { body: string; sentAt: string }[];
        steer: string | null;
        status: "needs_decision" | null;
      }
    >();
    const ensure = (key: string) => {
      let entry = map.get(key);
      if (!entry) {
        entry = { draftBody: null, sent: [], steer: null, status: null };
        map.set(key, entry);
      }
      return entry;
    };
    const drafts = this.db
      .query(`SELECT thread_key AS k, body AS b, steer AS s, status AS st FROM inbox_drafts`)
      .all() as Array<{ k: string; b: string; s: string | null; st: string | null }>;
    for (const d of drafts) {
      const entry = ensure(d.k);
      entry.draftBody = d.b;
      entry.steer = d.s;
      entry.status = d.st === "needs_decision" ? "needs_decision" : null;
    }
    const sent = this.db
      .query(`SELECT thread_key AS k, body AS b, sent_at AS t FROM inbox_sent ORDER BY sent_at ASC`)
      .all() as Array<{ k: string; b: string; t: string }>;
    for (const s of sent) ensure(s.k).sent.push({ body: s.b, sentAt: s.t });
    return map;
  }

  /**
   * Atomic CAS claim of the sending marker — two concurrent Send clicks can't
   * double-fire. `staleCutoffIso` lets a fresh click reclaim a marker stranded
   * by a restart before the cold-boot sweep (else the row 409s until reboot).
   */
  claimCadenceSendingMarker(input: {
    prospectId: number;
    playName: string;
    startedAtIso: string;
    staleCutoffIso?: string;
  }): boolean {
    return this.claimMarker({
      table: "cadence_state",
      pkeyWhere: "prospect_id = ? AND play_name = ?",
      column: "sending_started_at",
      pkeyValues: [input.prospectId, input.playName],
      startedAtIso: input.startedAtIso,
      ...(input.staleCutoffIso ? { staleCutoffIso: input.staleCutoffIso } : {}),
    });
  }

  /** Release the sending marker for this cadence (sets sending_started_at = NULL). */
  clearCadenceSendingMarker(input: { prospectId: number; playName: string }): void {
    this.clearMarker({
      table: "cadence_state",
      pkeyWhere: "prospect_id = ? AND play_name = ?",
      column: "sending_started_at",
      pkeyValues: [input.prospectId, input.playName],
    });
  }

  /**
   * Sweep stale `sending_started_at` markers (any non-null value when
   * `staleAgeMs` is 0 — cold-boot semantics). A matching sequence_event means
   * the send went out: clear the marker only; no event means it was stranded:
   * clear the marker but keep the draft. Returns swept rows; takes `now` +
   * `maxAgeMs` as args so tests don't fake the clock.
   */
  sweepStaleCadenceSends(input: { now: Date; maxAgeMs: number }): Array<{
    prospectId: number;
    playName: string;
    startedAt: string;
    ageMs: number;
    actuallySent: boolean;
  }> {
    const cutoffMs = input.now.getTime() - input.maxAgeMs;
    const rows = this.db
      .query(
        `SELECT prospect_id, play_name, current_step, sending_started_at
         FROM cadence_state
         WHERE sending_started_at IS NOT NULL`,
      )
      .all() as Array<{
      prospect_id: number;
      play_name: string;
      current_step: number;
      sending_started_at: string;
    }>;
    const swept: Array<{
      prospectId: number;
      playName: string;
      startedAt: string;
      ageMs: number;
      actuallySent: boolean;
    }> = [];
    const checkEvent = this.db.prepare(
      `SELECT 1 FROM sequence_events
       WHERE prospect_id = ? AND play_name = ? AND step_index = ?
         AND status IN ('sent','delivered','replied')
       LIMIT 1`,
    );
    const clear = this.db.prepare(
      `UPDATE cadence_state
       SET sending_started_at = NULL
       WHERE prospect_id = ? AND play_name = ?`,
    );
    for (const row of rows) {
      const startedMs = new Date(row.sending_started_at).getTime();
      if (Number.isFinite(startedMs) && startedMs > cutoffMs) continue; // still fresh
      const ageMs = Number.isFinite(startedMs) ? input.now.getTime() - startedMs : -1;
      // The in-flight step's step_index is `current_step + 1` (= nextIndex in the
      // engine): the marker is claimed while current_step still holds the OLD
      // value, and `recordSequenceEvent` writes at nextIndex. So "did the
      // in-flight send land?" checks current_step + 1. We also check current_step
      // to cover the race where advanceCadence already ran (current_step moved to
      // the sent step) but the marker hadn't been cleared yet.
      const sentInflight = checkEvent.get(row.prospect_id, row.play_name, row.current_step + 1);
      const sentAfterAdvance = checkEvent.get(row.prospect_id, row.play_name, row.current_step);
      const actuallySent = sentInflight != null || sentAfterAdvance != null;
      clear.run(row.prospect_id, row.play_name);
      swept.push({
        prospectId: row.prospect_id,
        playName: row.play_name,
        startedAt: row.sending_started_at,
        ageMs,
        actuallySent,
      });
    }
    return swept;
  }

  findProspectByEmail(email: string): { id: number } | null {
    return (
      (this.db.query("SELECT id FROM prospects WHERE email = ?").get(canonEmail(email)) as {
        id: number;
      }) ?? null
    );
  }

  /** Full prospect record by email — used to attach name/company to inbox replies. */
  getProspectByEmail(email: string): ProspectRecord | null {
    return (
      (this.db
        .query("SELECT * FROM prospects WHERE email = ?")
        .get(canonEmail(email)) as ProspectRecord) ?? null
    );
  }

  resolveProspectForLinkedInReply(input: {
    email?: string;
    linkedinUrl?: string;
  }): { status: "matched"; prospectId: number } | { status: "unmatched" } | { status: "conflict" } {
    const emailId = input.email ? (this.findProspectByEmail(input.email)?.id ?? null) : null;
    let linkedinIds: number[] = [];
    if (input.linkedinUrl) {
      const key = canonicalLinkedInProfileKey(input.linkedinUrl);
      if (key) {
        const rows = this.db
          .query(
            `SELECT id, linkedin_url, source_profile_url FROM prospects
             WHERE linkedin_url LIKE '%linkedin.com/in/%'
                OR source_profile_url LIKE '%linkedin.com/in/%'`,
          )
          .all() as Array<{
          id: number;
          linkedin_url: string | null;
          source_profile_url: string | null;
        }>;
        linkedinIds = rows
          .filter(
            (row) =>
              (row.linkedin_url && canonicalLinkedInProfileKey(row.linkedin_url) === key) ||
              (row.source_profile_url &&
                canonicalLinkedInProfileKey(row.source_profile_url) === key),
          )
          .map((row) => row.id);
      }
    }
    const uniqueLinkedIn = [...new Set(linkedinIds)];
    if (uniqueLinkedIn.length > 1) return { status: "conflict" };
    const linkedinId = uniqueLinkedIn[0] ?? null;
    if (emailId && linkedinId && emailId !== linkedinId) return { status: "conflict" };
    const prospectId = emailId ?? linkedinId;
    return prospectId ? { status: "matched", prospectId } : { status: "unmatched" };
  }

  recordLinkedInReply(input: {
    prospectId: number;
    source: string;
    externalEventId: string;
    occurredAt: string;
    /** The message text, when the channel supplies one. Feeds the composer. */
    body?: string | null;
  }): {
    duplicate: boolean;
    prospectId: number;
    cadencesStopped: number;
    inFlightSends: number;
  } {
    return this.db.transaction(() => {
      const existing = this.db
        .query(`SELECT * FROM channel_events WHERE source = ? AND external_event_id = ?`)
        .get(input.source, input.externalEventId) as ChannelEventRecord | null;
      if (existing) {
        const inFlight = this.db
          .query(
            `SELECT COUNT(*) AS n FROM cadence_state
             WHERE prospect_id = ? AND sending_started_at IS NOT NULL`,
          )
          .get(existing.prospect_id) as { n: number };
        return {
          duplicate: true,
          prospectId: existing.prospect_id,
          cadencesStopped: 0,
          inFlightSends: inFlight.n,
        };
      }
      const live = this.db
        .query(
          `SELECT sending_started_at FROM cadence_state
           WHERE prospect_id = ? AND status IN ('active','paused')`,
        )
        .all(input.prospectId) as Array<{ sending_started_at: string | null }>;
      this.db
        .prepare(
          `INSERT INTO channel_events
             (source, external_event_id, prospect_id, channel, event_type, occurred_at, body)
           VALUES (?, ?, ?, 'linkedin', 'reply', ?, ?)`,
        )
        .run(
          input.source,
          input.externalEventId,
          input.prospectId,
          input.occurredAt,
          input.body?.trim() || null,
        );
      this.db
        .prepare(
          `UPDATE cadence_state
           SET status = 'replied', next_due_at = NULL,
               next_step_draft_json = NULL, next_step_drafted_at = NULL,
               last_send_error = NULL, last_send_error_at = NULL
           WHERE prospect_id = ? AND status IN ('active','paused')`,
        )
        .run(input.prospectId);
      this.expireBreakupReviveQueue(input.prospectId, "prospect replied");
      return {
        duplicate: false,
        prospectId: input.prospectId,
        cadencesStopped: live.length,
        inFlightSends: live.filter((row) => row.sending_started_at != null).length,
      };
    })();
  }

  private expireBreakupReviveQueue(prospectId: number, reason: string): void {
    this.db
      .prepare(
        `UPDATE target_queue
         SET status = 'expired',
             notes = CASE WHEN notes IS NULL OR notes = '' THEN ?
                          ELSE notes || ' · ' || ? END
         WHERE (prospect_id = ? OR dedupe_key = ?)
           AND play_name = 'breakup-revive'
           AND status IN ('pending', 'approved')`,
      )
      .run(`expired: ${reason}`, `expired: ${reason}`, prospectId, `prospect:${prospectId}`);
  }

  /**
   * Emails of every prospect with a recorded reply — the target list for the
   * inbox's known-replier fetch, so a reply is never lost to the live window.
   */
  listRepliedProspectEmails(): string[] {
    const rows = this.db
      .query(
        `SELECT DISTINCT p.email FROM sequence_events se
         JOIN prospects p ON p.id = se.prospect_id
         WHERE se.status = 'replied' AND p.email IS NOT NULL AND p.email != ''`,
      )
      .all() as Array<{ email: string }>;
    return rows.map((r) => r.email);
  }

  listInboxArchives(): Map<number, string> {
    const rows = this.db
      .query("SELECT prospect_id, archived_at FROM inbox_archives")
      .all() as Array<{ prospect_id: number; archived_at: string }>;
    return new Map(rows.map((r) => [r.prospect_id, r.archived_at]));
  }

  /** Compare the caller's visible replies under the same write lock as archiving. */
  archiveInboxConversation(
    prospectId: number,
    observedReplyIds: string[],
  ): "archived" | "stale" | "missing" {
    return this.db
      .transaction(() => {
        const current = this.listInboxRepliesForProspect(prospectId).map((r) => r.id);
        if (!current.length) return "missing" as const;
        const observed = new Set(observedReplyIds);
        if (observed.size !== current.length || current.some((id) => !observed.has(id)))
          return "stale" as const;
        this.db
          .query(
            "INSERT INTO inbox_archives(prospect_id, archived_at) VALUES (?, ?) ON CONFLICT(prospect_id) DO UPDATE SET archived_at=excluded.archived_at",
          )
          .run(prospectId, new Date().toISOString());
        return "archived" as const;
      })
      .immediate();
  }

  restoreInboxConversation(prospectId: number): void {
    this.db.query("DELETE FROM inbox_archives WHERE prospect_id=?").run(prospectId);
  }

  /**
   * Persist one inbound reply (full body) keyed by provider email id.
   * INSERT OR IGNORE — re-sweeps and double captures are no-ops. Returns true
   * when this call stored a NEW reply.
   */
  recordInboxReply(row: {
    id: string;
    threadKey: string;
    prospectId: number;
    playName?: string | null;
    fromEmail: string;
    subject?: string | null;
    body: string;
    receivedAt: string;
    sourceIdentityId?: string | null;
    threadId?: string | null;
    messageId?: string | null;
    kind?: ReplyKind | null;
  }): boolean {
    return this.db
      .transaction(() => {
        const res = this.db
          .query(
            `INSERT OR IGNORE INTO inbox_replies
           (id, thread_key, prospect_id, play_name, from_email, subject, body,
            received_at, source_identity_id, thread_id, message_id, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.id,
            row.threadKey,
            row.prospectId,
            row.playName ?? null,
            canonEmail(row.fromEmail),
            row.subject ?? null,
            row.body,
            row.receivedAt,
            row.sourceIdentityId ?? null,
            row.threadId ?? null,
            row.messageId ?? null,
            row.kind ?? null,
          );
        if (res.changes > 0) this.restoreInboxConversation(row.prospectId);
        return res.changes > 0;
      })
      .immediate();
  }

  /**
   * Set the sentiment/intent classification on an already-persisted reply
   * (issue #480) — the triage call runs AFTER recordInboxReply so a triage
   * failure never loses the reply itself. `id IS` a no-op UPDATE if the row
   * somehow isn't there (e.g. a race), which is the correct behaviour: never
   * throw out of a best-effort classification path.
   */
  setInboxReplyIntent(id: string, intent: string | null, intentReason: string | null): void {
    this.db
      .prepare(`UPDATE inbox_replies SET intent = ?, intent_reason = ? WHERE id = ?`)
      .run(intent, intentReason, id);
  }

  /**
   * Atomically claim a persisted reply for triage (issue #558 round-1
   * correction). Two overlapping `pollInboxReplies()` calls (realistically:
   * the server's background scheduler tick and a manually-run `cadence
   * advance` CLI invocation) can both observe the same freshly-inserted row
   * with `intent` still NULL while the first call's `triageEmails()` await is
   * in flight — a bare re-check of the nullable `intent` column can't tell
   * "nobody has started triaging this yet" from "I already looked a moment
   * ago", so both callers would re-trigger the paid triage call and race on
   * the write-back. This flips `intent` from NULL to `INBOX_REPLY_TRIAGE_PENDING`
   * in the SAME statement that checks it's still NULL — SQLite serializes
   * writers, so only one caller's UPDATE can match a given row, and its
   * `changes` count is the claim. The winner must call `setInboxReplyIntent`
   * (real result) or release the claim (`setInboxReplyIntent(id, null, null)`
   * on failure) so a later poll can retry; the loser must skip triage
   * entirely for this row this poll.
   */
  claimInboxReplyForTriage(id: string): boolean {
    const res = this.db
      .prepare(`UPDATE inbox_replies SET intent = ? WHERE id = ? AND intent IS NULL`)
      .run(INBOX_REPLY_TRIAGE_PENDING, id);
    return res.changes > 0;
  }

  /**
   * Cold-boot recovery for `claimInboxReplyForTriage` (round-2 correction,
   * #558): every other claim-marker in this file
   * (claimCadenceSendingMarker/sweepStaleCadenceSends,
   * claimQueueSendingMarker/sweepStaleQueueSends,
   * claimRunningTrigger/sweepStaleRunningTriggers) has a paired sweep so a
   * crash between the claim UPDATE and the try/catch's release doesn't
   * strand the marker forever. This one didn't: a process death mid-triage
   * left `intent = '__triage_pending__'` permanently on the row — it could
   * never be re-claimed (the claim UPDATE only matches `intent IS NULL`) or
   * classified again, and the non-`ReplyIntent` sentinel was exposed to
   * every reader of `intent` (`listInboxReplyIntents`, the /inbox route).
   * Unlike the other markers, the claim here has no `started_at` column to
   * age against — it's held only for the duration of one in-process `await
   * triageEmails(...)`, which cannot survive past that process's death — so
   * there's no `maxAgeMs`: cold boot (called once, like the other sweeps,
   * from apps/server/src/bin.ts) is the only moment a stranded claim can be
   * told apart from one a live process still holds. Returns the number of
   * rows reset so the caller can log it.
   *
   * Known trade-off: a claim held by a live `intel backfill-intent` CLI
   * process at the instant the server boots is cleared too, and the next
   * poll may re-claim that row. The cost is one duplicated triage call
   * (cents) whose result is the same category — last writer wins, no data
   * is lost. Telling the two apart would need a claim timestamp column and
   * an age-gated sweep; not worth a schema change for that window.
   */
  sweepStaleInboxReplyTriage(): number {
    const res = this.db
      .prepare(`UPDATE inbox_replies SET intent = NULL WHERE intent = ?`)
      .run(INBOX_REPLY_TRIAGE_PENDING);
    return res.changes;
  }

  /**
   * Bulk intent lookup for a set of provider email ids — the /inbox route's
   * badge needs the persisted (LLM-classified) intent per visible reply
   * without an N+1 query. Empty input short-circuits (SQLite's `IN ()` is
   * invalid syntax, not just slow).
   */
  listInboxReplyIntents(
    ids: string[],
  ): Map<string, { intent: string | null; intentReason: string | null }> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .query(
        `SELECT id, intent, intent_reason AS intentReason FROM inbox_replies
         WHERE id IN (${placeholders})`,
      )
      .all(...ids) as Array<{ id: string; intent: string | null; intentReason: string | null }>;
    return new Map(
      rows.map((r) => [r.id, { intent: publicIntent(r.intent), intentReason: r.intentReason }]),
    );
  }

  /** All persisted inbound replies for one prospect, oldest first. */
  listInboxRepliesForProspect(prospectId: number): InboxReplyRecord[] {
    const rows = this.db
      .query(`SELECT * FROM inbox_replies WHERE prospect_id = ? ORDER BY received_at ASC, id ASC`)
      .all(prospectId) as InboxReplyRecord[];
    for (const r of rows) if (r.intent === INBOX_REPLY_TRIAGE_PENDING) r.intent = null;
    return rows;
  }

  /** Provider ids of every persisted reply — dedupe set for capture passes. */
  listInboxReplyIds(): Set<string> {
    const rows = this.db.query(`SELECT id FROM inbox_replies`).all() as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Every persisted HUMAN reply with no intent classification yet (issue
   * #480) — the backfill target for `oneshot-gtm intel backfill-intent` and
   * for any pre-#480 install's existing history. `COALESCE(kind,'human')`
   * mirrors the same predicate `listSentOutcomeRows` uses: pre-v23 rows with
   * a NULL kind read as human everywhere.
   */
  listUntriagedHumanReplies(limit = 200): InboxReplyRecord[] {
    return this.db
      .query(
        `SELECT * FROM inbox_replies
         WHERE COALESCE(kind, 'human') = 'human' AND intent IS NULL
         ORDER BY received_at ASC
         LIMIT ?`,
      )
      .all(limit) as InboxReplyRecord[];
  }

  /** Prospects that have at least one persisted reply, most recent activity first. */
  listProspectIdsWithReplies(): number[] {
    const rows = this.db
      .query(
        `SELECT prospect_id, MAX(received_at) AS last FROM inbox_replies
         GROUP BY prospect_id ORDER BY last DESC`,
      )
      .all() as Array<{ prospect_id: number }>;
    return rows.map((r) => r.prospect_id);
  }

  /** Full prospect record by id (PK seek). Avoids loading every prospect to find one. */
  getProspectById(id: number): ProspectRecord | null {
    const prospect = this.db
      .query("SELECT * FROM prospects WHERE id = ?")
      .get(id) as ProspectRecord | null;
    const address = prospect && this.getMailAddress(`prospect:${id}`);
    return prospect
      ? {
          ...prospect,
          ...(address
            ? {
                businessAddress: address,
                businessAddressSource: String(
                  this.getMailAddressMetadata(`prospect:${id}`)?.source ?? "saved address",
                ),
              }
            : {}),
        }
      : null;
  }

  /**
   * Paid-lookup caches live in the cross-workspace SHARED DB (shared-db.ts) —
   * the same person must never be bought twice across products. Delegated to
   * `LedgerCache` (ledger-cache.ts, #618), which keeps the same contracts.
   */
  getCachedEnrichment(
    email: string,
  ): { result_json: string; fetched_at: string; status: string | null } | null {
    return this.cache.getCachedEnrichment(email);
  }

  getCachedLinkedIn(
    queryKey: string,
  ): { url: string | null; status: string; fetched_at: string } | null {
    return this.cache.getCachedLinkedIn(queryKey);
  }

  setCachedLinkedIn(queryKey: string, url: string | null): void {
    this.cache.setCachedLinkedIn(queryKey, url);
  }

  setCachedEnrichment(email: string, resultJson: string): void {
    this.cache.setCachedEnrichment(email, resultJson);
  }

  setCachedEnrichmentFailure(email: string, message: string): void {
    this.cache.setCachedEnrichmentFailure(email, message);
  }

  recordReceipt(input: {
    playName: string;
    callType: string;
    /** Per-call USD cost. Every wrapper in `oneshot.ts` reads `result.cost`
     *  from the SDK response (declared on every result type in
     *  `@oneshot-agent/sdk@0.15.2+`) and forwards it here. NULL in the
     *  column when undefined — visible signal that the SDK omitted cost. */
    costUsd?: number;
    signedReceipt?: unknown;
    oneshotRequestId?: string;
    /** EmailIdentity id for email.send receipts — drives per-identity daily caps. */
    senderIdentity?: string;
    /** Call-time memo (the same value sent to OneShot); defaults to "{play} {callType}". */
    memo?: string;
    /** Call-time decisionContext blob; JSON-stringified into the column. */
    decisionContext?: unknown;
  }): number {
    return this.receipts.recordReceipt(input);
  }

  getSenderAssignment(email: string): string | null {
    const row = this.db
      .query("SELECT identity_id FROM sender_assignments WHERE email = ?")
      .get(canonEmail(email)) as { identity_id: string } | undefined;
    return row?.identity_id ?? null;
  }

  /**
   * Pin a prospect email to a sending identity. INSERT OR IGNORE + read-back
   * makes concurrent first-touches race-safe: both callers end up using the
   * single winning assignment instead of splitting the thread across senders.
   */
  assignSender(email: string, identityId: string): string {
    const canon = canonEmail(email);
    this.db
      .prepare("INSERT OR IGNORE INTO sender_assignments(email, identity_id) VALUES(?, ?)")
      .run(canon, identityId);
    return this.getSenderAssignment(canon) ?? identityId;
  }

  /**
   * Sends by an identity since `sinceUtcSqlite`. The timestamp MUST be in
   * SQLite datetime('now') format ("YYYY-MM-DD HH:MM:SS", UTC) — receipts
   * default created_at to that format, and an ISO string with its 'T'
   * separator compares GREATER than any same-day SQLite timestamp, silently
   * excluding today's rows.
   */
  countEmailSendsSince(identityId: string, sinceUtcSqlite: string): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n FROM receipts
         WHERE call_type = 'email.send' AND sender_identity = ? AND created_at >= ?`,
      )
      .get(identityId, sinceUtcSqlite) as { n: number };
    return row.n;
  }

  /**
   * Did we ever email this address pre-rotation? Used to lazy-pin legacy
   * prospects (e.g. in-flight cadences) to the legacy identity instead of
   * letting the rotation picker move their thread to a new From address.
   */
  hasPriorEmailSend(email: string): boolean {
    const row = this.db
      .query(
        `SELECT 1 FROM sequence_events se
         JOIN prospects p ON p.id = se.prospect_id
         WHERE p.email = ? AND se.channel = 'email'
           AND se.status IN ('sent','delivered','replied')
         LIMIT 1`,
      )
      .get(canonEmail(email)) as 1 | undefined;
    return row != null;
  }

  /** First email.send by this identity (warm-up ramp anchor). SQLite-format UTC or null. */
  firstEmailSendAt(identityId: string): string | null {
    const row = this.db
      .query(
        `SELECT MIN(created_at) AS first FROM receipts
         WHERE call_type = 'email.send' AND sender_identity = ?`,
      )
      .get(identityId) as { first: string | null };
    return row.first;
  }

  /**
   * Record one delivery failure. INSERT OR IGNORE on (message_id, recipient):
   * the sweep re-sees the same DSN every tick and it must count once. Returns
   * true only for a NEW bounce — callers gate receipt-tagging/logging on that.
   */
  recordBounce(input: {
    messageId: string;
    recipient: string;
    identityId: string | null;
    kind: BounceKind;
    statusCode: string | null;
    diagnostic: string | null;
    prospectId: number | null;
    bouncedAt: string;
  }): boolean {
    return delivRecordBounce(this.db, input);
  }

  /**
   * The hard bounce that suppresses this address, or null if it's still
   * sendable. HARD ONLY — a `block` is the receiving server refusing a message
   * on policy, not a statement that the mailbox is dead, so suppressing on it
   * would permanently burn valid prospects over one spam-filter verdict.
   * Soft bounces are transient by definition.
   */
  suppressionFor(email: string): BounceRecord | null {
    return delivSuppressionFor(this.db, email);
  }

  /**
   * A do-not-send verdict from the reply stream: the newest 'unsubscribe'
   * (they asked to stop) or 'auto_permanent' (their responder says the
   * mailbox is dead) captured from this address. Durable on purpose — it
   * outlives any one cadence, so a later play can never re-enroll and email
   * an unsubscribed or gone prospect. Sibling of suppressionFor (bounces).
   */
  contactSuppressionFor(email: string): { kind: string; received_at: string } | null {
    return delivContactSuppressionFor(this.db, email);
  }

  /** Permanent manual-stop hold used only by breakup-revive's final send backstop. */
  breakupReviveHoldFor(email: string): { reason: string; stopped_at: string } | null {
    const prospect = this.findProspectByEmail(email);
    if (!prospect) return null;
    return (
      (this.db
        .query(
          `SELECT stop_reason AS reason, stopped_at
           FROM cadence_state
           WHERE prospect_id = ? AND status = 'stopped'
             AND stop_reason IN ('not_a_fit', 'do_not_contact')
           ORDER BY stopped_at DESC
           LIMIT 1`,
        )
        .get(prospect.id) as { reason: string; stopped_at: string }) ?? null
    );
  }

  /** Bounce counts per sending identity since `sinceIso` — the doctor check's numerator. */
  bounceStatsByIdentity(opts: {
    sinceIso: string;
  }): Map<string, { hard: number; block: number; soft: number }> {
    return delivBounceStatsByIdentity(this.db, opts);
  }

  /** Most recent bounces for display (doctor detail lines, debugging). */
  listRecentBounces(opts: { limit?: number } = {}): BounceRecord[] {
    return delivListRecentBounces(this.db, opts);
  }

  /**
   * Count of distinct recorded delivery-failure events in the window, keyed
   * by `bounces`' own (message_id, recipient) PK — the Slack daily summary's
   * `bounced` total (issue #71 round-3 review finding). Deliberately NOT
   * derived from `sequence_events`: `pollInboxBounces` inserts one
   * sequence_events row PER CADENCE a bounced prospect is enrolled in, so a
   * single DSN for a prospect in 2+ concurrent cadences would be counted
   * multiple times there, and it skips sequence_events entirely for soft
   * bounces and for bounces on prospects with no ledger match — both of
   * which still land here and still fire `notifySlackBounceRecorded`. This
   * table is the one row per real bounce event; `bounced_at` is NOT NULL on
   * every row (unlike sequence_events', which predates the column on old
   * rows), so no COALESCE fallback is needed. Sibling of
   * countAutoPermanentBounces (the reply-stream bounce path, which never
   * writes to this table).
   */
  countBounces(opts: { sinceIso?: string; untilIso?: string } = {}): number {
    return delivCountBounces(this.db, opts);
  }

  /**
   * Count of distinct dead-mailbox autoresponder events ("auto_permanent"
   * reply kind, see reply-classify.ts) in the window — the OTHER bounce
   * source the Slack daily summary's `bounced` total must include alongside
   * countBounces (DSN bounces never touch `sequence_events`; this reply-
   * stream path never touches `bounces`). Counted from `inbox_replies`, NOT
   * `sequence_events` (issue #71 round-1 correction): `pollInboxReplies`
   * (and the /inbox route's opportunistic capture) call `recordInboxReply`
   * for EVERY matched auto_permanent email unconditionally, but only write a
   * `sequence_events` row inside the `listCadencesForProspect(...).filter
   * (status active|paused)` loop right after — a dead-mailbox reply for a
   * prospect whose only cadence is already terminal (or who has none) still
   * fires `notifySlackBounceRecorded` and is persisted here, but would never
   * produce a `sequence_events` row to count. `inbox_replies.id` is the
   * provider's own message id and PRIMARY KEY (INSERT OR IGNORE), so each
   * real event is already exactly one row — no de-dup math needed, unlike
   * countBounces' sibling problem on the multi-cadence `sequence_events`
   * path.
   */
  countAutoPermanentBounces(opts: { sinceIso?: string; untilIso?: string } = {}): number {
    return delivCountAutoPermanentBounces(this.db, opts);
  }

  recordCanaryResult(input: {
    fromIdentity: string;
    toIdentity: string;
    placement: GmailPlacement;
    labelIds: string[];
    auth: { spf: AuthVerdict; dkim: AuthVerdict; dmarc: AuthVerdict };
    subject: string | null;
    sourcePlay: string | null;
    sameDomain: boolean;
    latencyMs: number | null;
  }): number {
    return delivRecordCanaryResult(this.db, input);
  }

  /** Newest placement test, or null if one has never been run. */
  latestCanaryResult(): CanaryResultRecord | null {
    return delivLatestCanaryResult(this.db);
  }

  /**
   * Subject + body of the most recent email this tool actually SENT, for the
   * placement canary to replay. Spam filters judge content, so testing with
   * invented copy would measure nothing that transfers to real outreach.
   * Reads the persisted draft off the sequence_events row (metadata_json
   * carries {subject, body} for sent email steps).
   */
  latestSentEmailCopy(
    opts: { playName?: string } = {},
  ): { subject: string; body: string; playName: string } | null {
    return delivLatestSentEmailCopy(this.db, opts);
  }

  /**
   * Bodies of the most recent email sends for one play + step, newest first.
   * Feeds the opener-frequency lint: a follow-up step that keeps reaching for
   * the same opening words is a fingerprint, and only the ledger knows what
   * the last N sends actually opened with.
   *
   * Same status set as `latestSentEmailCopy` — 'sent' rows are UPDATEd in
   * place to 'replied', so matching only 'sent' would silently drop every
   * prospect who answered and skew the share.
   */
  recentSentEmailBodies(opts: { playName: string; stepIndex: number; limit?: number }): string[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 40, 200));
    const rows = this.db
      .query(
        `SELECT metadata_json FROM sequence_events
         WHERE play_name = ? AND step_index = ?
           AND status IN ('sent', 'delivered', 'replied')
           AND channel = 'email' AND metadata_json IS NOT NULL
           AND json_valid(metadata_json)
           AND trim(coalesce(json_extract(metadata_json, '$.body'), '')) != ''
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(opts.playName, opts.stepIndex, limit) as Array<{ metadata_json: string }>;
    const out: string[] = [];
    for (const row of rows) {
      let body: unknown;
      try {
        body = (JSON.parse(row.metadata_json) as { body?: unknown }).body;
      } catch {
        continue;
      }
      if (typeof body === "string" && body.trim()) out.push(body);
    }
    return out;
  }

  getReceipt(id: number): ReceiptRecord | null {
    return this.receipts.getReceipt(id);
  }

  listReceipts(
    opts: { playName?: string; sinceIso?: string; limit?: number } = {},
  ): ReceiptRecord[] {
    return this.receipts.listReceipts(opts);
  }

  upsertProspect(input: Partial<ProspectRecord> & { email?: string | null }): number {
    // Store the canonical (lowercased) email so reply matching — which
    // normalizes the inbound from-address the same way — always lands.
    const email = input.email ? canonEmail(input.email) : null;
    if (email) {
      const existing = this.db.query("SELECT id FROM prospects WHERE email = ?").get(email) as
        | { id: number }
        | undefined;
      if (existing) {
        if (input.businessAddress && !this.getMailAddress(`prospect:${existing.id}`))
          this.setMailAddress(
            `prospect:${existing.id}`,
            input.businessAddress,
            input.businessAddressSource ?? "prospect input",
          );
        return existing.id;
      }
    }
    const stmt = this.db.prepare(`
      INSERT INTO prospects(name, email, phone, company, linkedin_url, dossier_json, source,
                            source_profile_url, title)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.name ?? null,
      email,
      (input as { phone?: string | null }).phone ?? null,
      input.company ?? null,
      input.linkedin_url ?? null,
      input.dossier_json ?? null,
      input.source ?? null,
      input.source_profile_url ?? null,
      input.title ?? null,
    );
    const id = Number(result.lastInsertRowid);
    if (input.businessAddress)
      this.setMailAddress(
        `prospect:${id}`,
        input.businessAddress,
        input.businessAddressSource ?? "prospect input",
      );
    return id;
  }

  /**
   * Backfill identity columns that are NULL on an existing prospect — the only
   * such path (`upsertProspect` never writes twice). COALESCE on purpose: a
   * backfill must never clobber a URL a finder already resolved, and
   * `undefined`/`null` leaves the column untouched. True when a column changed.
   */
  updateProspectIdentity(
    id: number,
    patch: {
      linkedin_url?: string | null;
      phone?: string | null;
      company?: string | null;
      source_profile_url?: string | null;
      title?: string | null;
    },
  ): boolean {
    const cols = ["linkedin_url", "phone", "company", "source_profile_url", "title"] as const;
    const set: string[] = [];
    const blank: string[] = [];
    const args: Array<string | number> = [];
    for (const col of cols) {
      const value = patch[col];
      if (typeof value !== "string" || value.trim() === "") continue;
      // NULLIF, not a bare COALESCE: the WHERE guard below counts '' as empty
      // (listProspectsMissingLinkedIn selects those rows), so COALESCE alone
      // would match the row, report a change, and leave the '' in place.
      set.push(`${col} = COALESCE(NULLIF(${col}, ''), ?)`);
      // Guard in the WHERE so the statement only matches when at least one
      // target column is actually empty. Without this `changes` would report 1
      // for a pure no-op (it counts matched rows, not modified columns) and
      // every caller would over-report how much it backfilled.
      blank.push(`(${col} IS NULL OR ${col} = '')`);
      args.push(value.trim());
    }
    if (set.length === 0) return false;
    args.push(id);
    const result = this.db
      .prepare(`UPDATE prospects SET ${set.join(", ")} WHERE id = ? AND (${blank.join(" OR ")})`)
      .run(...(args as never[]));
    return Number(result.changes) > 0;
  }

  /**
   * Record the person-level ICP verdict for a prospect. Overwrites — a
   * re-audit with better data (a real title instead of a stale event bio)
   * must be able to flip an earlier call in either direction.
   *
   * `unclear` is a real, persisted verdict: qualifyPerson is 4-state, and
   * writing its ambiguity as NULL made "we looked and couldn't tell"
   * indistinguishable from "never judged". It is PROVISIONAL, not settled —
   * _qualify.ts escalates `unclear` rather than dropping a candidate, so a
   * re-audit re-judges those rows (picking up role text that arrived since)
   * and skips only pass/reject. Suppression is unaffected — the cadence gate
   * tests `=== "reject"`, so `unclear` fails open exactly as NULL did.
   * `transient` is never persisted; it stays a retry signal.
   */
  setProspectIcpVerdict(
    id: number,
    verdict: "pass" | "reject" | "unclear",
    reason?: string | null,
  ): void {
    this.db
      .prepare("UPDATE prospects SET icp_verdict = ?, icp_verdict_reason = ? WHERE id = ?")
      .run(verdict, reason ?? null, id);
  }

  /**
   * Persist a research dossier onto an existing prospect.
   *
   * Deliberately NOT part of updateProspectIdentity: that method's column
   * allowlist is write-once (COALESCE(NULLIF(col,''), ?)), which is right for
   * identity fields but wrong here — re-researching a person must be able to
   * refresh a stale dossier. Plain overwrite; callers decide whether to skip
   * rows that already have one. Pass null to clear.
   */
  setProspectDossier(id: number, dossier: string | null): void {
    this.db.prepare("UPDATE prospects SET dossier_json = ? WHERE id = ?").run(dossier, id);
  }

  /**
   * Persist a synthesized per-prospect angle (issue #355) onto an existing
   * prospect. Plain UPDATE, mirroring `setProspectDossier` — NOT
   * `upsertProspect`, which skips existing rows and would silently no-op
   * every backfill call. Pass null to clear both columns together, so
   * `angle_synthesized_at` can never point at a row with no `angle_json`.
   */
  setProspectAngle(id: number, angle: string | null): void {
    this.db
      .prepare("UPDATE prospects SET angle_json = ?, angle_synthesized_at = ? WHERE id = ?")
      .run(angle, angle == null ? null : new Date().toISOString(), id);
  }

  /**
   * Write ONE half of a prospect's dossier without clobbering the other.
   *
   * `research-prospects` owns the `person` half and `research-products` owns
   * `product`, and each was doing read → merge → write with the read outside
   * any transaction. Two writers, one column, a wide window between them: the
   * later write silently reverts the earlier one.
   *
   * Not theoretical — it happened during this feature's own dogfood run. The
   * workspace server researched a prospect while a script held a merge in
   * flight, and the curated person half vanished under an API one. The reads
   * were seconds apart.
   *
   * BEGIN IMMEDIATE via `db.transaction` takes the write lock before the
   * re-read, so the merge sees the current value and no one can interleave
   * between the two statements.
   */
  mergeProspectDossierHalf(
    id: number,
    half: "person" | "product",
    value: unknown,
    slice?: number,
  ): void {
    this.db.transaction(() => {
      const row = this.db.query("SELECT dossier_json FROM prospects WHERE id = ?").get(id) as
        | { dossier_json: string | null }
        | undefined;
      if (!row) return;
      const merged =
        half === "person"
          ? mergePersonDossier(row.dossier_json, value)
          : mergeProductDossier(row.dossier_json, value as ProductResearchDossier);
      const bounded = slice != null && merged.length > slice ? merged.slice(0, slice) : merged;
      this.db.prepare("UPDATE prospects SET dossier_json = ? WHERE id = ?").run(bounded, id);
    })();
  }

  /**
   * Prospects that could take a LinkedIn URL but don't have one. Rows already
   * holding a GitHub/X URL in `linkedin_url` are skipped (updateProspectIdentity
   * won't overwrite them); a name is required — the lookup searches by name.
   */
  listProspectsMissingLinkedIn(opts: { limit?: number; play?: string } = {}): Array<{
    id: number;
    name: string | null;
    company: string | null;
    email: string | null;
    source: string | null;
    source_profile_url: string | null;
  }> {
    const where = ["(linkedin_url IS NULL OR linkedin_url = '')", "name IS NOT NULL", "name != ''"];
    const args: Array<string | number> = [];
    if (opts.play) {
      where.push("source = ?");
      args.push(opts.play);
    }
    args.push(opts.limit ?? 500);
    return this.db
      .query(
        `SELECT id, name, company, email, source, source_profile_url
           FROM prospects
          WHERE ${where.join(" AND ")}
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(...(args as never[])) as Array<{
      id: number;
      name: string | null;
      company: string | null;
      email: string | null;
      source: string | null;
      source_profile_url: string | null;
    }>;
  }

  /**
   * Prospects worth buying a research dossier for, by scope:
   *
   * - `active`   — a cadence is still running, so a dossier changes what gets sent
   * - `replied`  — a live conversation, where reply drafting reads the dossier
   * - `unjudged` — no ICP verdict AND a profile URL to research, so the gate can judge
   * - `all`      — every prospect
   *
   * Scopes union. Rows that already hold a dossier are excluded unless
   * `includeResearched`, so an interrupted run resumes instead of re-buying.
   * A row needs a social URL or an email — deepResearchPerson has nothing to
   * chase otherwise.
   */
  listProspectsForResearch(
    opts: {
      scopes?: ReadonlyArray<"active" | "replied" | "unjudged" | "all">;
      includeResearched?: boolean;
      limit?: number;
    } = {},
  ): Array<{
    id: number;
    name: string | null;
    company: string | null;
    email: string | null;
    source: string | null;
    source_profile_url: string | null;
    linkedin_url: string | null;
    dossier_json: string | null;
  }> {
    const scopes = opts.scopes?.length ? opts.scopes : (["active", "replied", "unjudged"] as const);
    const any: string[] = [];
    if (scopes.includes("all")) {
      any.push("1 = 1");
    } else {
      if (scopes.includes("active")) {
        any.push(
          "EXISTS(SELECT 1 FROM cadence_state cs WHERE cs.prospect_id = p.id AND cs.status = 'active')",
        );
      }
      if (scopes.includes("replied")) {
        any.push("EXISTS(SELECT 1 FROM inbox_replies ir WHERE ir.prospect_id = p.id)");
      }
      if (scopes.includes("unjudged")) {
        any.push(
          "(p.icp_verdict IS NULL AND COALESCE(NULLIF(TRIM(p.source_profile_url), ''), NULLIF(TRIM(p.linkedin_url), '')) IS NOT NULL)",
        );
      }
    }
    if (any.length === 0) return [];

    const where = [`(${any.join(" OR ")})`];
    // Something for deepResearchPerson to key on.
    where.push(
      "(COALESCE(NULLIF(TRIM(p.source_profile_url), ''), NULLIF(TRIM(p.linkedin_url), '')) IS NOT NULL OR (p.email IS NOT NULL AND TRIM(p.email) != ''))",
    );

    const rows = this.db
      .query(
        `SELECT p.id, p.name, p.company, p.email, p.source, p.source_profile_url, p.linkedin_url,
                p.dossier_json
           FROM prospects p
          WHERE ${where.join(" AND ")}
          ORDER BY p.id DESC`,
      )
      .all() as Array<{
      id: number;
      name: string | null;
      company: string | null;
      email: string | null;
      source: string | null;
      source_profile_url: string | null;
      linkedin_url: string | null;
      dossier_json: string | null;
    }>;

    // The "already researched" filter runs here, not in SQL. It used to be
    // `dossier_json IS NULL OR TRIM(...) = ''`, which silently emptied the
    // backlog the moment `research-products` began writing a
    // `{person, product}` wrapper onto every row: 531 of 684 prospects held a
    // product half and a null person half, looked researched to that test, and
    // became permanently unreachable. `hasPersonSignal` asks the question the
    // caller actually means — is there PERSON research here — and matches the
    // gate every other consumer of this column already uses.
    //
    // `limit` is applied AFTER the filter so it keeps meaning "return N rows to
    // research", not "consider N rows". The prospects table is small enough
    // that scanning it whole costs nothing.
    const eligible = opts.includeResearched
      ? rows
      : rows.filter((row) => !hasPersonSignal(row.dossier_json));
    const limit = opts.limit ?? 100_000;
    return eligible.length > limit ? eligible.slice(0, limit) : eligible;
  }

  /**
   * Prospects worth synthesizing a per-prospect angle for (issue #355), by
   * scope. Mirrors `listProspectsForResearch`'s scope semantics exactly:
   *
   * - `active`   — a cadence is still running, so a sharper angle changes what
   *                gets sent once drafting reads it (#356)
   * - `replied`  — a live conversation; the reply history is itself an input
   *                to the synthesis (corrections, "not what I meant", etc.)
   * - `unjudged` — no ICP verdict yet, so the angle's `relationship` /
   *                `valueMode` read can inform the gate
   * - `all`      — every prospect
   *
   * Scopes union, not intersect. Unlike `listProspectsForResearch`, this does
   * NOT require a social URL or email — reply history alone is enough input
   * for a synthesis, and gatherAngleEvidence degrades gracefully when GitHub
   * lookups have nothing to chase. Rows that already hold an angle are
   * excluded unless `includeSynthesized`, so an interrupted backfill resumes
   * instead of re-synthesizing (and re-billing) rows already done.
   */
  listProspectsForAngle(
    opts: {
      scopes?: ReadonlyArray<"active" | "replied" | "unjudged" | "all">;
      includeSynthesized?: boolean;
      limit?: number;
    } = {},
  ): Array<{
    id: number;
    name: string | null;
    company: string | null;
    email: string | null;
    source: string | null;
    source_profile_url: string | null;
    linkedin_url: string | null;
    dossier_json: string | null;
    angle_json: string | null;
  }> {
    const scopes = opts.scopes?.length ? opts.scopes : (["active", "replied", "unjudged"] as const);
    const any: string[] = [];
    if (scopes.includes("all")) {
      any.push("1 = 1");
    } else {
      if (scopes.includes("active")) {
        any.push(
          "EXISTS(SELECT 1 FROM cadence_state cs WHERE cs.prospect_id = p.id AND cs.status = 'active')",
        );
      }
      if (scopes.includes("replied")) {
        any.push(
          "EXISTS(SELECT 1 FROM inbox_replies ir WHERE ir.prospect_id = p.id) OR " +
            "EXISTS(SELECT 1 FROM channel_events ce WHERE ce.prospect_id = p.id AND ce.event_type = 'reply')",
        );
      }
      if (scopes.includes("unjudged")) {
        any.push(
          "(p.icp_verdict IS NULL AND COALESCE(NULLIF(TRIM(p.source_profile_url), ''), NULLIF(TRIM(p.linkedin_url), '')) IS NOT NULL)",
        );
      }
    }
    if (any.length === 0) return [];

    const where = [`(${any.join(" OR ")})`];
    const rows = this.db
      .query(
        `SELECT p.id, p.name, p.company, p.email, p.source, p.source_profile_url, p.linkedin_url,
                p.dossier_json, p.angle_json
           FROM prospects p
          WHERE ${where.join(" AND ")}
          ORDER BY p.id DESC`,
      )
      .all() as Array<{
      id: number;
      name: string | null;
      company: string | null;
      email: string | null;
      source: string | null;
      source_profile_url: string | null;
      linkedin_url: string | null;
      dossier_json: string | null;
      angle_json: string | null;
    }>;

    const eligible = opts.includeSynthesized ? rows : rows.filter((row) => !row.angle_json?.trim());
    const limit = opts.limit ?? 100_000;
    return eligible.length > limit ? eligible.slice(0, limit) : eligible;
  }

  recordOutcome(input: {
    prospectId: number;
    playName?: string;
    outcome: "meeting_booked" | "sql_qualified" | "deal_won" | "deal_lost" | "ghosted";
    amountUsd?: number;
    notes?: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO deal_outcomes(prospect_id, play_name, outcome, amount_usd, notes)
      VALUES(?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.prospectId,
      input.playName ?? null,
      input.outcome,
      input.amountUsd ?? null,
      input.notes ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  /** Latest outcome timestamp per prospect, bulk-read to acknowledge earlier positive replies. */
  listLatestOutcomeRecordedAtByProspect(): Map<number, string> {
    const rows = this.db
      .query(
        `SELECT prospect_id, MAX(recorded_at) AS recorded_at FROM deal_outcomes GROUP BY prospect_id`,
      )
      .all() as Array<{ prospect_id: number; recorded_at: string }>;
    return new Map(rows.map((r) => [r.prospect_id, r.recorded_at]));
  }

  countOutcomes(
    opts: {
      sinceIso?: string;
      playName?: string;
      outcome?: string;
    } = {},
  ): number {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.sinceIso) {
      where.push("recorded_at >= ?");
      args.push(opts.sinceIso);
    }
    if (opts.playName) {
      where.push("play_name = ?");
      args.push(opts.playName);
    }
    if (opts.outcome) {
      where.push("outcome = ?");
      args.push(opts.outcome);
    }
    const sql = `SELECT COUNT(*) AS n FROM deal_outcomes ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    return (this.db.query(sql).get(...(args as never[])) as { n: number } | null)?.n ?? 0;
  }

  outcomesByPlay(opts: { sinceIso?: string } = {}): Array<{
    play_name: string | null;
    meetings: number;
    sqls: number;
    won: number;
    lost: number;
    ghosted: number;
    won_value_usd: number;
  }> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.sinceIso) {
      where.push("recorded_at >= ?");
      args.push(opts.sinceIso);
    }
    const sql = `
      SELECT
        play_name,
        SUM(CASE WHEN outcome = 'meeting_booked' THEN 1 ELSE 0 END) AS meetings,
        SUM(CASE WHEN outcome = 'sql_qualified' THEN 1 ELSE 0 END) AS sqls,
        SUM(CASE WHEN outcome = 'deal_won' THEN 1 ELSE 0 END) AS won,
        SUM(CASE WHEN outcome = 'deal_lost' THEN 1 ELSE 0 END) AS lost,
        SUM(CASE WHEN outcome = 'ghosted' THEN 1 ELSE 0 END) AS ghosted,
        -- The return side. amount_usd has been written since v16 and read by
        -- nothing; without it the only figure putting dollars over dollars is
        -- the platform's per-goal RoCS, which divides one winner's cadence cost
        -- into its own deal and so ignores every prospect that went nowhere.
        COALESCE(SUM(CASE WHEN outcome = 'deal_won' THEN amount_usd ELSE 0 END), 0) AS won_value_usd
      FROM deal_outcomes
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY play_name
      ORDER BY play_name ASC NULLS LAST
    `;
    return this.db.query(sql).all(...(args as never[])) as never;
  }

  listColdProspects(opts: {
    minDaysSinceLastEvent: number;
    maxDaysSinceLastEvent: number;
    limit?: number;
  }): Array<{
    id: number;
    name: string | null;
    email: string | null;
    company: string | null;
    linkedin_url: string | null;
    phone: string | null;
    last_event_at: string | null;
  }> {
    const sql = `
      SELECT p.id, p.name, p.email, p.company, p.linkedin_url, p.phone,
             MAX(s.created_at) AS last_sequence_at,
             MAX(CASE WHEN c.status = 'stopped' AND c.stop_reason IN ('bad_timing', 'other')
                      THEN c.stopped_at END) AS last_revivable_stop_at,
             MAX(
               COALESCE(MAX(s.created_at), ''),
               COALESCE(MAX(CASE WHEN c.status = 'stopped' AND c.stop_reason IN ('bad_timing', 'other')
                                 THEN c.stopped_at END), ''),
               COALESCE((SELECT MAX(ir.received_at) FROM inbox_replies ir
                         WHERE ir.prospect_id = p.id AND coalesce(ir.kind,'human') = 'human'), ''),
               COALESCE((SELECT MAX(ce.occurred_at) FROM channel_events ce
                         WHERE ce.prospect_id = p.id AND ce.event_type = 'reply'), '')
             ) AS last_event_at
      FROM prospects p
      LEFT JOIN sequence_events s ON s.prospect_id = p.id
      LEFT JOIN cadence_state c ON c.prospect_id = p.id
      WHERE ${contactAllowedClause(this.db)} AND NOT EXISTS (
        SELECT 1 FROM cadence_state blocked
        WHERE blocked.prospect_id = p.id AND blocked.status = 'stopped'
          AND blocked.stop_reason IN ('not_a_fit', 'do_not_contact')
      )
      GROUP BY p.id
      HAVING last_event_at != ''
        AND julianday('now') - julianday(last_event_at) BETWEEN ? AND ?
      ORDER BY last_event_at ASC
      LIMIT ?
    `;
    return this.db
      .query(sql)
      .all(opts.minDaysSinceLastEvent, opts.maxDaysSinceLastEvent, opts.limit ?? 50) as never;
  }

  recordSequenceEvent(input: {
    prospectId: number;
    playName: string;
    stepIndex: number;
    channel: SequenceEventRecord["channel"];
    status: SequenceEventRecord["status"];
    metadata?: unknown;
    /** The send receipt this step produced — links the step to its billable call
     *  so an outcome (reply/deal) can tag the receipt's value. */
    receiptId?: number;
    /**
     * The provider's own bounce timestamp (DSN `bouncedAt`), for `status:
     * "bounced"` rows only. `created_at` is stamped at POLL/detection time —
     * this is the real occurrence time, so date-windowed rollups (the Slack
     * daily summary) attribute the bounce to the day it actually happened
     * rather than the day the mailbox happened to be polled.
     */
    bouncedAt?: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO sequence_events(prospect_id, play_name, step_index, channel, status, metadata_json, receipt_id, bounced_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.prospectId,
      input.playName,
      input.stepIndex,
      input.channel,
      input.status,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.receiptId ?? null,
      input.bouncedAt ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  /** Persist the RoCS value tag (JSON `{type,amount?,label?}`) on a single receipt. */
  setReceiptValueTag(receiptId: number, valueTagJson: string): void {
    this.receipts.setReceiptValueTag(receiptId, valueTagJson);
  }

  /**
   * Local mirror of a goal-level value tag: stamp every receipt in the cadence
   * (matching `goal_id`) so the /receipts UI shows the value per row. Returns the
   * number of receipts touched. The platform records the value once per goal via
   * `tagReceiptValue({goalId})`; this just keeps the dashboard in sync.
   */
  setReceiptValueTagByGoal(goalId: string, valueTagJson: string): number {
    return this.receipts.setReceiptValueTagByGoal(goalId, valueTagJson);
  }

  /** Current local value tag for a goal (any one of its receipts), or null. */
  currentGoalValueTag(goalId: string): string | null {
    return this.receipts.currentGoalValueTag(goalId);
  }

  /**
   * Human labels (play + prospect) for a set of goalIds, derived from the local
   * receipts so the Measure page can render OneShot's opaque goal_id rollups as
   * "{play} → {prospect}". First receipt per goal wins.
   */
  goalLabels(goalIds: string[]): Map<string, { playName: string | null; prospect: string | null }> {
    return this.receipts.goalLabels(goalIds);
  }

  /**
   * True when a (prospect, play, step) already has a terminal-sent
   * sequence_event. Pre-dispatch guard: a crash between recordSequenceEvent
   * and advanceCadence leaves current_step lagging the sent step — this stops
   * the re-send on the next due tick.
   */
  hasSentSequenceEvent(prospectId: number, playName: string, stepIndex: number): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM sequence_events
           WHERE prospect_id = ? AND play_name = ? AND step_index = ?
             AND status IN ('sent','delivered','replied')
           LIMIT 1`,
        )
        .get(prospectId, playName, stepIndex) != null
    );
  }

  /**
   * Mark the latest sent step `replied` — a state transition of the existing
   * step, NOT a new event, so `sent` counts stay correct. Idempotent per
   * (prospect, play) via the NOT EXISTS guard; returns true on the one call
   * that flips a row. Stamps `replied_at` to the actual reply moment — the
   * row's `created_at` stays pinned to the original SEND time, so date-windowed
   * rollups (eventsByPlay, the Slack daily summary) must use replied_at, not
   * created_at, to count a reply on the day it happened rather than the day it
   * was sent. `repliedAt` defaults to now (the manual-reply / UI-send path,
   * where the moment of the call IS the reply); the background inbox poll
   * passes the inbound email's own `received_at` so a reply pulled from a
   * backlog page — arriving in this process well after it actually landed in
   * the mailbox — is still credited to the day it was actually sent, not the
   * day this poll happened to run.
   */
  markLatestStepReplied(input: {
    prospectId: number;
    playName: string;
    repliedAt?: string | null;
  }): boolean {
    // datetime(?) normalizes any SQLite-recognized input (an ISO 8601 string
    // with 'T'/'Z', or the 'YYYY-MM-DD HH:MM:SS' form) to the latter — the
    // same format datetime('now') already writes everywhere else in this
    // table. Storing repliedAt un-normalized would make replied_at sort
    // lexicographically wrong against created_at / sinceIso / untilIso
    // (ISO's 'T' separator sorts after the space datetime('now') uses).
    const result = this.db
      .prepare(
        `UPDATE sequence_events SET status = 'replied', replied_at = datetime(COALESCE(?, 'now'))
         WHERE id = (
           SELECT id FROM sequence_events
           WHERE prospect_id = ? AND play_name = ? AND channel = 'email'
             AND status IN ('sent','delivered')
           ORDER BY created_at DESC, id DESC LIMIT 1
         )
         AND NOT EXISTS (
           SELECT 1 FROM sequence_events
           WHERE prospect_id = ? AND play_name = ? AND status = 'replied'
         )`,
      )
      .run(
        input.repliedAt ?? null,
        input.prospectId,
        input.playName,
        input.prospectId,
        input.playName,
      );
    return result.changes > 0;
  }

  /**
   * Single source of truth for "a prospect replied to a cadence" — writes both
   * planes in one transaction so they can't drift. Control plane
   * (`cadence_state.status='replied'`) is conservative: only a live cadence
   * (`active`/`paused`) flips, so a terminal sequence is never resurrected.
   * Analytics plane (sequence_events) is unconditional: the event is recorded
   * for ANY status — gating the two together silently drops replies that
   * arrive after a sequence finishes. Count replies on `eventRecorded` (true
   * exactly once per (prospect, play)); `newlyReplied` marks the control
   * transition.
   */
  recordCadenceReply(input: { prospectId: number; playName: string; repliedAt?: string | null }): {
    newlyReplied: boolean;
    eventRecorded: boolean;
  } {
    return this.db.transaction(() => {
      const cad = this.getCadence(input.prospectId, input.playName);
      const newlyReplied = cad?.status === "active" || cad?.status === "paused";
      if (newlyReplied) {
        this.markCadenceReplied(input.prospectId, input.playName);
      }
      const eventRecorded = this.markLatestStepReplied({
        prospectId: input.prospectId,
        playName: input.playName,
        repliedAt: input.repliedAt,
      });
      return { newlyReplied, eventRecorded };
    })();
  }

  /**
   * Record a reply. Control: EVERY live cadence for the prospect stops —
   * nobody keeps getting follow-ups after answering. Analytics: the reply is
   * credited to exactly ONE play — the one whose sent subject it threads on
   * (`Re: …`), else the most recent play that emailed them. Returns one entry
   * per play touched. `repliedAt` (default now) should be the inbound
   * email's own received/sent timestamp when known — see
   * markLatestStepReplied's note on why the background inbox poll must pass
   * it rather than let this stamp the moment the poll happened to run.
   */
  recordProspectReply(
    prospectId: number,
    opts?: { subject?: string | null; repliedAt?: string | null },
  ): Array<{ playName: string; newlyReplied: boolean; eventRecorded: boolean }> {
    return this.db.transaction(() => {
      const credited = this.latestSentPlayForProspect(prospectId, opts?.subject);
      const out = new Map<string, { newlyReplied: boolean; eventRecorded: boolean }>();
      for (const cad of this.listCadencesForProspect(prospectId)) {
        const live = cad.status === "active" || cad.status === "paused";
        if (live) {
          this.markCadenceReplied(prospectId, cad.play_name);
        }
        out.set(cad.play_name, { newlyReplied: live, eventRecorded: false });
      }
      if (credited) {
        const eventRecorded = this.markLatestStepReplied({
          prospectId,
          playName: credited,
          repliedAt: opts?.repliedAt,
        });
        out.set(credited, {
          newlyReplied: out.get(credited)?.newlyReplied ?? false,
          eventRecorded,
        });
      }
      this.expireBreakupReviveQueue(prospectId, "prospect replied");
      return [...out].map(([playName, r]) => ({
        playName,
        newlyReplied: r.newlyReplied,
        eventRecorded: r.eventRecorded,
      }));
    })();
  }

  /** Stop future work on one live cadence without hiding a send already handed to a provider. */
  private markCadenceReplied(prospectId: number, playName: string): void {
    this.db
      .prepare(
        `UPDATE cadence_state
         SET status = 'replied', next_due_at = NULL,
             next_step_draft_json = NULL, next_step_drafted_at = NULL,
             last_send_error = NULL, last_send_error_at = NULL
         WHERE prospect_id = ? AND play_name = ? AND status IN ('active','paused')`,
      )
      .run(prospectId, playName);
  }

  /**
   * Which play an EMAIL reply belongs to. With a subject, the sent email whose
   * subject it threads on wins (reply prefixes in a few languages stripped, case
   * and whitespace ignored); otherwise, or when nothing matches, the prospect's
   * most recent sent email. Other channels (sms/voice/linkedin) are never
   * credited with an email reply. Null if never emailed.
   */
  latestSentPlayForProspect(prospectId: number, replySubject?: string | null): string | null {
    const wanted = normalizeSubject(replySubject);
    if (wanted) {
      const rows = this.db
        .query(
          `SELECT play_name, json_extract(metadata_json, '$.subject') AS subject
           FROM sequence_events
           WHERE prospect_id = ? AND channel = 'email'
             AND status IN ('sent','delivered','replied')
             AND json_extract(metadata_json, '$.subject') IS NOT NULL
           ORDER BY created_at DESC, id DESC`,
        )
        .all(prospectId) as Array<{ play_name: string; subject: string }>;
      const hit = rows.find((r) => normalizeSubject(r.subject) === wanted);
      if (hit) return hit.play_name;
    }
    const row = this.db
      .query(
        `SELECT play_name FROM sequence_events
         WHERE prospect_id = ? AND channel = 'email'
           AND status IN ('sent','delivered','replied')
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(prospectId) as { play_name: string } | null;
    return row?.play_name ?? null;
  }

  getPollWatermark(key: string): string | null {
    const row = this.db.query(`SELECT value FROM poll_state WHERE key = ?`).get(key) as {
      value: string;
    } | null;
    return row?.value ?? null;
  }

  setPollWatermark(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO poll_state(key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value);
  }

  /**
   * A play's prior steps for one prospect — every send, plus a letter the
   * founder skipped (#610), so the cadence history says why step N never
   * went out. The conversation view (`listSequenceEventsForProspect`) stays
   * sends-only; so does every counter.
   */
  listSequenceEventsForProspectPlay(prospectId: number, playName: string): SequenceEventRecord[] {
    return this.db
      .query(
        `SELECT * FROM sequence_events
         WHERE prospect_id = ? AND play_name = ?
           AND status IN ('sent','delivered','replied','skipped')
         ORDER BY step_index ASC, id ASC`,
      )
      .all(prospectId, playName) as SequenceEventRecord[];
  }

  /** Every sent step for a prospect across ALL plays — the outreach half of a conversation timeline. */
  listSequenceEventsForProspect(prospectId: number): SequenceEventRecord[] {
    return this.db
      .query(
        `SELECT * FROM sequence_events
         WHERE prospect_id = ?
           AND status IN ('sent','delivered','replied')
         ORDER BY created_at ASC, id ASC`,
      )
      .all(prospectId) as SequenceEventRecord[];
  }

  /**
   * Bulk variant of listSequenceEventsForProspectPlay: one round-trip, Map
   * keyed `${prospect_id}|${play_name}`, same (step_index ASC, id ASC)
   * ordering. Index-served by idx_sequence_events_prospect_play.
   */
  listSequenceEventsForCadences(
    pairs: ReadonlyArray<{ prospectId: number; playName: string }>,
  ): Map<string, SequenceEventRecord[]> {
    const map = new Map<string, SequenceEventRecord[]>();
    if (pairs.length === 0) return map;
    const conditions = pairs.map(() => "(prospect_id = ? AND play_name = ?)").join(" OR ");
    const args: unknown[] = [];
    for (const p of pairs) {
      args.push(p.prospectId, p.playName);
    }
    const rows = this.db
      .query(
        `SELECT * FROM sequence_events
         WHERE (${conditions})
           AND status IN ('sent','delivered','replied','skipped')
         ORDER BY prospect_id ASC, play_name ASC, step_index ASC, id ASC`,
      )
      .all(...(args as never[])) as SequenceEventRecord[];
    for (const r of rows) {
      const key = `${r.prospect_id}|${r.play_name}`;
      let list = map.get(key);
      if (!list) {
        list = [];
        map.set(key, list);
      }
      list.push(r);
    }
    return map;
  }

  recordInterview(input: Omit<InterviewRecord, "id" | "created_at">): number {
    const stmt = this.db.prepare(`
      INSERT INTO interviews(person, transcript_path, jtbd, pain_quotes_json)
      VALUES(?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.person,
      input.transcript_path,
      input.jtbd,
      input.pain_quotes_json,
    );
    return Number(result.lastInsertRowid);
  }

  countSends(opts: { playName?: string } = {}): number {
    const sql = opts.playName
      ? "SELECT COUNT(*) AS n FROM sequence_events WHERE play_name = ? AND status IN ('sent', 'delivered', 'replied')"
      : "SELECT COUNT(*) AS n FROM sequence_events WHERE status IN ('sent', 'delivered', 'replied')";
    const args = opts.playName ? [opts.playName] : [];
    return (this.db.query(sql).get(...(args as never[])) as { n: number } | null)?.n ?? 0;
  }

  spendByPlay(
    opts: { sinceIso?: string } = {},
  ): Array<{ play_name: string; calls: number; total_usd: number }> {
    return this.receipts.spendByPlay(opts);
  }

  /**
   * Per-play rollup of sequence_events, windowed by `sinceIso`/`untilIso`.
   *
   * By default every column windows on `created_at` alone — byte-for-byte the
   * pre-existing behaviour every current caller (home.ts's sentLast7d/
   * repliedLast7d, measure.ts's reply-rate %, weekly-review.ts) depends on,
   * which guarantees `replied <= sent` for any window: a reply can only be
   * counted once its originating send's `created_at` already falls inside
   * the same window.
   *
   * Pass `occurrenceWindow: true` to window `replied`/`bounced` on their OWN
   * occurrence column instead (COALESCEd onto `created_at` for older rows
   * that predate it), which the Slack daily summary needs so a reply or
   * bounce landing the day AFTER it was sent still shows up on the day it
   * actually happened rather than vanishing from every completed-day rollup:
   *   - `replied`: `COALESCE(replied_at, created_at)` — `markLatestStepReplied`
   *     flips the ORIGINAL sent row in place rather than inserting a new one,
   *     so that row's `created_at` stays pinned to the SEND time.
   *   - `bounced`: `COALESCE(bounced_at, created_at)` — a bounce DOES insert a
   *     fresh row, but `created_at` is stamped at POLL/detection time, not the
   *     provider's own bounce time; a poll resuming after downtime (or a
   *     delayed DSN) would otherwise misattribute the bounce to the wrong day.
   * This mode intentionally breaks the `replied <= sent` invariant for a
   * window whose reply/bounce occurrence lands inside it but whose send
   * predates it — that's why it's opt-in, scoped to the one caller that reads
   * `sent`/`replied`/`bounced` as independent daily counts rather than a
   * cohort funnel.
   */
  eventsByPlay(
    opts: { sinceIso?: string; untilIso?: string; occurrenceWindow?: boolean } = {},
  ): Array<{
    play_name: string;
    sent: number;
    delivered: number;
    replied: number;
    bounced: number;
  }> {
    const createdClause: string[] = [];
    const repliedClause: string[] = [];
    const bouncedClause: string[] = [];
    const repliedCol = opts.occurrenceWindow ? "COALESCE(replied_at, created_at)" : "created_at";
    const bouncedCol = opts.occurrenceWindow ? "COALESCE(bounced_at, created_at)" : "created_at";
    if (opts.sinceIso) {
      createdClause.push("created_at >= $sinceIso");
      repliedClause.push(`${repliedCol} >= $sinceIso`);
      bouncedClause.push(`${bouncedCol} >= $sinceIso`);
    }
    if (opts.untilIso) {
      createdClause.push("created_at < $untilIso");
      repliedClause.push(`${repliedCol} < $untilIso`);
      bouncedClause.push(`${bouncedCol} < $untilIso`);
    }
    const createdWindow = createdClause.length ? `(${createdClause.join(" AND ")})` : "1";
    const repliedWindow = repliedClause.length ? `(${repliedClause.join(" AND ")})` : "1";
    const bouncedWindow = bouncedClause.length ? `(${bouncedClause.join(" AND ")})` : "1";
    const params: Record<string, string> = {};
    if (opts.sinceIso) params["$sinceIso"] = opts.sinceIso;
    if (opts.untilIso) params["$untilIso"] = opts.untilIso;
    const sql = `
      SELECT
        play_name,
        SUM(CASE WHEN status IN ('sent', 'delivered', 'replied') AND ${createdWindow} THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN status IN ('delivered', 'replied') AND ${createdWindow} THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN status = 'replied' AND ${repliedWindow} THEN 1 ELSE 0 END) AS replied,
        SUM(CASE WHEN status = 'bounced' AND ${bouncedWindow} THEN 1 ELSE 0 END) AS bounced
      FROM sequence_events
      WHERE ${createdWindow} OR (status = 'replied' AND ${repliedWindow}) OR (status = 'bounced' AND ${bouncedWindow})
      GROUP BY play_name
    `;
    return this.db.query(sql).all(params) as Array<{
      play_name: string;
      sent: number;
      delivered: number;
      replied: number;
      bounced: number;
    }>;
  }

  /**
   * How many receipts fall in the window.
   *
   * Callers wanting a count must not list the rows and measure the array: the
   * Today page did exactly that behind a `limit: 1000`, so any install busy
   * enough to exceed it reported precisely 1000 calls a week, for ever, with
   * nothing in the response to say it had been truncated.
   */
  countReceipts(opts: { sinceIso?: string; playName?: string } = {}): number {
    return this.receipts.countReceipts(opts);
  }

  /**
   * Daily signed spend per play, for the trend sparklines on Measure.
   *
   * Bucketed in SQL rather than by listing receipts and grouping in the
   * browser. The page used to pull 500 rows and bucket them client-side, which
   * silently became a five-hour window once an install carried tens of
   * thousands of receipts; and `new Date("YYYY-MM-DD HH:MM:SS")` parses as
   * local time, so the buckets drifted by the viewer's UTC offset. `date()`
   * here has neither problem.
   */
  spendSeriesByPlay(opts: { days: number }): Array<{
    play_name: string;
    day: string;
    total_usd: number;
  }> {
    return this.receipts.spendSeriesByPlay(opts);
  }

  totalSpendUsd(opts: { sinceIso?: string; playName?: string } = {}): number {
    return this.receipts.totalSpendUsd(opts);
  }

  // ── spend_reservations (issue #481: install-wide daily USD spend ceiling) ──

  /**
   * Hold `amountUsd` against the daily ceiling for the duration of an
   * automated call. Returns the reservation id — callers MUST release it
   * (on success or failure) via `releaseSpendReservation`, else it counts
   * against the ceiling until `sweepStaleSpendReservations` reclaims it.
   */
  reserveSpend(amountUsd: number): number {
    const result = this.db
      .prepare(`INSERT INTO spend_reservations(amount_usd) VALUES(?)`)
      .run(amountUsd);
    return Number(result.lastInsertRowid);
  }

  /** Release a reservation once the caller's actual spend has posted (or the call was skipped/failed). */
  releaseSpendReservation(id: number): void {
    this.db.prepare(`DELETE FROM spend_reservations WHERE id = ?`).run(id);
  }

  /** Sum of currently-held reservations since `sinceIso` (the local-midnight boundary). */
  reservedSpendUsd(sinceIso: string): number {
    const row = this.db
      .query(
        `SELECT COALESCE(SUM(amount_usd), 0) AS total FROM spend_reservations WHERE created_at >= ?`,
      )
      .get(sinceIso) as { total: number } | null;
    return row?.total ?? 0;
  }

  /**
   * Atomic check-then-reserve against the daily ceiling (issue #481
   * round-1 review finding). The read (posted spend + held reservations
   * since `sinceIso`) and the write (INSERT into `spend_reservations`)
   * happen inside ONE transaction on this connection — the same
   * `BEGIN IMMEDIATE` pattern `dequeueApproved` uses to close its own
   * cross-process claim race. IMMEDIATE takes SQLite's RESERVED write lock
   * at the START of the transaction (not the default DEFERRED, which only
   * locks on the first write), so in WAL mode two separate OS processes —
   * e.g. a `find watch --once` cron run and the server's in-process
   * scheduler firing the same tick — cannot both read the pre-reservation
   * total and both pass the check before either commits: the second
   * caller's transaction blocks until the first one's reservation is
   * already reflected in the sum it reads. Returns the new reservation id
   * when granted, or null when posted+reserved+`amountUsd` would EXCEED
   * `ceilingUsd`. Landing exactly on the ceiling is allowed: the ceiling is
   * "spend up to this", and a finder whose worst-case estimate equals the
   * ceiling (`config spend-ceiling 5` against a `maxCostUsd: 5` finder) must
   * still be able to fire once — with `>=` it never could, reporting
   * "$0.00/$5.00 spent today" while refusing forever (#488).
   */
  reserveSpendIfUnderCeiling(opts: {
    sinceIso: string;
    ceilingUsd: number;
    amountUsd: number;
  }): number | null {
    const txn = this.db.transaction((): number | null => {
      const effectiveUsd =
        this.totalSpendUsd({ sinceIso: opts.sinceIso }) + this.reservedSpendUsd(opts.sinceIso);
      // Compare in integer cents: receipts are REALs and three $0.10 calls
      // sum to 0.30000000000000004, which would read as over a $0.30 ceiling.
      if (cents(effectiveUsd) + cents(opts.amountUsd) > cents(opts.ceilingUsd)) return null;
      return this.reserveSpend(opts.amountUsd);
    });
    return txn.immediate();
  }

  /**
   * Sweep reservations older than `maxAgeMs` — a crashed process (kill -9
   * between reserve and release) must not hold spend against the ceiling for
   * the rest of the day. Returns the number of rows swept.
   */
  sweepStaleSpendReservations(maxAgeMs: number, now = new Date()): number {
    const cutoffIso = new Date(now.getTime() - maxAgeMs)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    const result = this.db
      .prepare(`DELETE FROM spend_reservations WHERE created_at < ?`)
      .run(cutoffIso);
    return Number(result.changes);
  }

  // ── target_queue ────────────────────────────────────────────────────────────

  /** Recent reviewed rows for few-shot ICP classification. */
  recentIcpDecisions(limit = 20): IcpDecisionExample[] {
    const rows = this.db
      .query(
        `SELECT payload_json, status, notes
         FROM target_queue
         WHERE ${humanDecisionWhereSql()}
           AND play_name IN (
             'show-hn', 'post-funding', 'accelerator-batch', 'job-change',
             'hiring-signal', 'podcast-guest', 'github-topics', 'github-stars',
             'competitor-switch', 'stack-consolidation', 'repo-interest', 'luma-events'
           )
           AND json_valid(payload_json)
         ORDER BY reviewed_at DESC, id DESC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.floor(limit))) as Array<{
      payload_json: string;
      status: "approved" | "rejected" | "sent";
      notes: string | null;
    }>;

    return rows.flatMap((row) => {
      try {
        const payload = JSON.parse(row.payload_json) as unknown;
        return [
          {
            // Queue payloads grow as a prospect is enriched and can contain
            // email, phone and social-profile fields. Few-shot topic
            // classification only needs the original public source context.
            candidate: icpExampleCandidate(payload),
            decision: row.status !== "rejected",
            reason: row.notes,
          },
        ];
      } catch {
        return [];
      }
    });
  }

  /**
   * Insert a row into target_queue. Returns the new id, or null if a row with
   * the same (play_name, dedupe_key) already exists.
   */
  enqueueTarget(input: {
    playName: string;
    payload: unknown;
    dedupeKey: string;
    source: string;
    notes?: string;
    /**
     * Status to insert with. Defaults to "pending" (the normal review path).
     * Pass "rejected" to record an auto-drop (e.g. ICP filter said no) so the
     * founder can see what was filtered out and override if needed.
     */
    initialStatus?: QueueStatus;
    /**
     * Shadow-mode priority artifact, persisted verbatim. Omit/null for
     * producers that can't score (manual rows, legacy callers, auto-drops).
     */
    priority?: ProspectPriority | null;
  }): number | null {
    try {
      const status = input.initialStatus ?? "pending";
      const reviewedAt = status === "pending" ? null : new Date().toISOString();
      const result = this.db
        .prepare(
          `INSERT INTO target_queue(play_name, payload_json, dedupe_key, source, status, reviewed_at, notes, priority_json, decision, decided_at, decided_by)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.playName,
          JSON.stringify(
            input.payload && typeof input.payload === "object"
              ? {
                  ...input.payload,
                  ...(extractBusinessAddress(input.payload)
                    ? { businessAddress: extractBusinessAddress(input.payload) }
                    : {}),
                }
              : input.payload,
          ),
          input.dedupeKey,
          input.source,
          status,
          reviewedAt,
          input.notes ?? null,
          input.priority ? JSON.stringify(input.priority) : null,
          // An insert-time rejection is a gate's verdict, never a human's —
          // structural provenance replaces the `auto:` notes-sniffing (the
          // notes convention stays for humans and pre-v26 fallback).
          status === "rejected" ? "auto_reject" : null,
          status === "rejected" ? reviewedAt : null,
          status === "rejected" ? "machine" : null,
        );
      return Number(result.lastInsertRowid);
    } catch (err) {
      // Unique constraint violation = already queued; return null to signal dedupe.
      const msg = (err as Error).message ?? "";
      if (msg.includes("UNIQUE constraint failed")) return null;
      throw err;
    }
  }

  isQueueDuplicate(playName: string, dedupeKey: string): boolean {
    const row = this.db
      .query("SELECT 1 FROM target_queue WHERE play_name = ? AND dedupe_key = ?")
      .get(playName, dedupeKey);
    return row !== null && row !== undefined;
  }

  /**
   * Persist a candidate whose paid resolution hit a transient platform error,
   * so the retry pass can complete it later (and re-scan won't re-create it).
   * Idempotent: a re-discovered candidate keeps its original first_seen_at and
   * attempt count (the retry pass owns attempt bookkeeping).
   */
  upsertPendingResolution(input: {
    playName: string;
    dedupeKey: string;
    source: string;
    raw: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO pending_resolution(play_name, dedupe_key, source, raw_json)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(play_name, dedupe_key) DO UPDATE SET
           source = excluded.source,
           raw_json = excluded.raw_json`,
      )
      .run(input.playName, input.dedupeKey, input.source, JSON.stringify(input.raw));
  }

  /** True when (play, dedupeKey) is awaiting retry — finders OR this into their dedup. */
  isPendingResolution(playName: string, dedupeKey: string): boolean {
    const row = this.db
      .query("SELECT 1 FROM pending_resolution WHERE play_name = ? AND dedupe_key = ?")
      .get(playName, dedupeKey);
    return row !== null && row !== undefined;
  }

  /** Pending rows (optionally one play), oldest first, for the retry pass. */
  listPendingResolution(opts?: { playName?: string; limit?: number }): Array<{
    play_name: string;
    dedupe_key: string;
    source: string;
    raw_json: string;
    first_seen_at: string;
    last_attempt_at: string | null;
    attempts: number;
  }> {
    const where = opts?.playName ? "WHERE play_name = ?" : "";
    const limit = opts?.limit ? `LIMIT ${Math.max(1, Math.floor(opts.limit))}` : "";
    const sql = `SELECT * FROM pending_resolution ${where} ORDER BY first_seen_at ASC ${limit}`;
    const q = this.db.query(sql);
    return (opts?.playName ? q.all(opts.playName) : q.all()) as never;
  }

  /** Mark a pending row as just-attempted (bumps attempts + last_attempt_at). */
  markPendingResolutionAttempted(playName: string, dedupeKey: string): void {
    this.db
      .prepare(
        `UPDATE pending_resolution
         SET attempts = attempts + 1, last_attempt_at = datetime('now')
         WHERE play_name = ? AND dedupe_key = ?`,
      )
      .run(playName, dedupeKey);
  }

  deletePendingResolution(playName: string, dedupeKey: string): void {
    this.db
      .prepare("DELETE FROM pending_resolution WHERE play_name = ? AND dedupe_key = ?")
      .run(playName, dedupeKey);
  }

  /**
   * Purge pending rows older than maxAgeMs (permanently-unresolvable or an
   * aged-out time-windowed source) so their dedupe_key frees for future
   * re-discovery and the table doesn't silt. Returns the number removed.
   */
  sweepStalePendingResolution(maxAgeMs: number): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const res = this.db
      .prepare("DELETE FROM pending_resolution WHERE first_seen_at < ?")
      .run(cutoff);
    return Number(res.changes ?? 0);
  }

  /** Tweet ids the x-reposters finder paid for since `cutoffIso` — skipped on the next harvest. */
  recentXHarvestedTweetIds(cutoffIso: string): Set<string> {
    const rows = this.db
      .query("SELECT tweet_id FROM x_harvested_tweets WHERE harvested_at >= ?")
      .all(cutoffIso) as Array<{ tweet_id: string }>;
    return new Set(rows.map((r) => r.tweet_id));
  }

  /**
   * Record tweets just paid for and prune rows past the skip window in one
   * transaction, so the table can't silt. Re-recording an id refreshes its
   * timestamp (a re-buy inside the freshness window restarts its clock).
   */
  recordXHarvestedTweets(ids: string[], nowIso: string, pruneCutoffIso: string): void {
    const insert = this.db.prepare(
      `INSERT INTO x_harvested_tweets(tweet_id, harvested_at) VALUES(?, ?)
       ON CONFLICT(tweet_id) DO UPDATE SET harvested_at = excluded.harvested_at`,
    );
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM x_harvested_tweets WHERE harvested_at < ?").run(pruneCutoffIso);
      for (const id of ids) insert.run(id, nowIso);
    });
    tx();
  }

  /**
   * Cross-play dedup (finder side): is this email in a non-terminal queue row
   * under ANY play? Catches the window before either play has sent (no
   * prospect row exists yet). Matches both `email` and `founderEmail`.
   */
  isEmailPendingInQueue(email: string): boolean {
    // Case-insensitive to match findProspectByEmail/upsertProspect, which store
    // and look up the canonical (lowercased) email — otherwise a casing mismatch
    // between two finders would slip a dup through. LOWER() on the JSON side,
    // canonEmail() on the arg.
    const row = this.db
      .query(
        `SELECT 1 FROM target_queue
         WHERE status IN ('pending','approved')
           AND (LOWER(json_extract(payload_json, '$.email')) = ?1
                OR LOWER(json_extract(payload_json, '$.founderEmail')) = ?1)
         LIMIT 1`,
      )
      .get(canonEmail(email));
    return row !== null && row !== undefined;
  }

  /**
   * Cross-play dedup (send side): has this prospect already received an initial
   * (step-0) touch under ANY play? The authoritative guard against first-touching
   * the same person twice. Mirrors the step-0 existence check in
   * sweepStaleCadenceSends. Note: deliberate re-engagement (breakup-revive)
   * bypasses this via sendDraftedEmail's `allowRecontact`.
   */
  prospectHasFirstTouch(prospectId: number): boolean {
    const row = this.db
      .query(
        `SELECT 1 FROM sequence_events
         WHERE prospect_id = ? AND step_index = 0
           AND status IN ('sent','delivered','replied')
         LIMIT 1`,
      )
      .get(prospectId);
    return row !== null && row !== undefined;
  }

  /**
   * Look up a queue row by its (play_name, dedupe_key) — the unique pair.
   * Used by the SSE /run endpoint to map drafts back to the originating
   * row so we can persist `last_draft_json`. Returns null when absent.
   */
  getQueueRowByDedupe(playName: string, dedupeKey: string): QueueRow | null {
    return (
      (this.db
        .query("SELECT * FROM target_queue WHERE play_name = ? AND dedupe_key = ?")
        .get(playName, dedupeKey) as QueueRow) ?? null
    );
  }

  listQueue(
    opts: { playName?: string; status?: QueueStatus; limit?: number; ids?: number[] } = {},
  ): QueueRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.playName) {
      where.push("play_name = ?");
      args.push(opts.playName);
    }
    if (opts.status) {
      where.push("status = ?");
      args.push(opts.status);
    }
    // Explicit row picks (the /queue "drain selected" path). An empty array
    // would compile to `IN ()` — a syntax error in SQLite — and semantically
    // means "nothing selected", so return early rather than silently listing
    // every row.
    if (opts.ids) {
      if (opts.ids.length === 0) return [];
      where.push(`id IN (${opts.ids.map(() => "?").join(",")})`);
      args.push(...opts.ids);
    }
    const sql = `
      SELECT * FROM target_queue
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY found_at DESC
      LIMIT ?
    `;
    args.push(opts.limit ?? 200);
    return this.db.query(sql).all(...(args as never[])) as QueueRow[];
  }

  getQueueRow(id: number): QueueRow | null {
    return (this.db.query("SELECT * FROM target_queue WHERE id = ?").get(id) as QueueRow) ?? null;
  }

  /**
   * Most recent queue row linked to a prospect — the finder's original signal
   * that queued them, used as evidence input to angle synthesis (issue #355).
   * Not every prospect has one: manually added prospects, or rows whose queue
   * entry was never linked via `setQueueProspectId`, return null.
   *
   * Tiebreak on `id DESC` after `found_at DESC`: `found_at` is
   * second-granularity (`datetime('now')`), so two rows queued within the
   * same second — routine in a fast backfill or a test — would otherwise tie
   * and return whichever SQLite happens to prefer.
   */
  getQueueRowForProspect(prospectId: number): QueueRow | null {
    return (
      (this.db
        .query(
          "SELECT * FROM target_queue WHERE prospect_id = ? ORDER BY found_at DESC, id DESC LIMIT 1",
        )
        .get(prospectId) as QueueRow) ?? null
    );
  }

  /**
   * FROM + WHERE shared by `searchQueue` (rows and total) and
   * `searchQueueStatusCounts`. The prospect is resolved with a scalar
   * subquery (`LIMIT 1`) rather than an OR-join so one queue row can never
   * fan out into two — two prospects sharing an email would otherwise
   * inflate `total` and shift every OFFSET. Filters that only need the queue
   * row (status, play, decided_by) go inside the derived table so the
   * existing status/play indexes still prune before the prospect lookup;
   * the free-text terms need the joined prospect and stay outside.
   */
  private queueSearchParts(
    opts: Pick<QueueSearchOpts, "q" | "statuses" | "playName" | "decidedBy">,
    withStatus: boolean,
  ): { sql: string; args: unknown[] } {
    const inner: string[] = [];
    const outer: string[] = [];
    const args: unknown[] = [];
    // De-duplicated: `?status=sent,sent,sent,sent,sent` is one status, not
    // "all five" — the length guard below must see distinct values.
    const statuses = [...new Set((opts.statuses ?? []).filter((s) => QUEUE_STATUSES.includes(s)))];
    if (withStatus && statuses.length > 0 && statuses.length < QUEUE_STATUSES.length) {
      inner.push(`q.status IN (${statuses.map(() => "?").join(",")})`);
      args.push(...statuses);
    }
    if (opts.playName) {
      inner.push("q.play_name = ?");
      args.push(opts.playName);
    }
    switch (opts.decidedBy) {
      case "human":
        inner.push("q.decided_by IN ('human', 'human_bulk')");
        break;
      case "machine":
        inner.push("q.decided_by = 'machine'");
        break;
      case "none":
        inner.push("q.decided_by IS NULL");
        break;
      default:
        break;
    }
    const terms = (opts.q ?? "")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    for (const term of terms) {
      const patterns = likePatternsFor(term);
      outer.push(
        `(${patterns.map(() => `${QUEUE_SEARCH_HAYSTACK} LIKE ? ESCAPE '\\'`).join(" OR ")})`,
      );
      args.push(...patterns);
    }
    const sql = `
      FROM (
        SELECT q.*, COALESCE(q.prospect_id, (
            SELECT p2.id FROM prospects p2
             WHERE p2.email = LOWER(TRIM(COALESCE(json_extract(q.payload_json, '$.email'),
                                                  json_extract(q.payload_json, '$.founderEmail'))))
             ORDER BY p2.id LIMIT 1)) AS joined_prospect_id
          FROM target_queue q
          ${inner.length ? `WHERE ${inner.join(" AND ")}` : ""}) b
      LEFT JOIN prospects p ON p.id = b.joined_prospect_id
      ${outer.length ? `WHERE ${outer.join(" AND ")}` : ""}`;
    return { sql, args };
  }

  /**
   * The /prospects browse view: every queue row, any status, searched, sorted
   * and paged. `q` is a deliberate full scan (LIKE over json_extract can use
   * no index) — measured at ~50 ms on 9k rows. Past ~100k rows an FTS5
   * external-content table is the upgrade path; nothing here would change
   * shape. Without `q` the derived table is pruned by the status/play
   * indexes like `listQueue`.
   */
  searchQueue(opts: QueueSearchOpts): { rows: QueueSearchRow[]; total: number | null } {
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit)));
    const offset = Math.max(0, Math.floor(opts.offset));
    const dir = opts.dir === "asc" ? "ASC" : "DESC";
    let orderSql: string;
    switch (opts.sort) {
      case "decided_at":
        // Undecided rows sink to the bottom in both directions.
        orderSql = `(b.decided_at IS NULL) ASC, b.decided_at ${dir}, b.id ${dir}`;
        break;
      case "name":
        // Named rows first; rows that only carry a source URL (pre-enrichment
        // rejects) sort after them by that URL, then by dedupe key.
        orderSql = `(${QUEUE_SEARCH_NAME_EXPR} IS NULL) ASC, LOWER(COALESCE(${QUEUE_SEARCH_NAME_EXPR}, json_extract(b.payload_json, '$.repoUrl'), json_extract(b.payload_json, '$.postUrl'), b.dedupe_key)) ${dir}, b.id ${dir}`;
        break;
      default:
        orderSql = `b.found_at ${dir}, b.id ${dir}`;
        break;
    }
    const { sql, args } = this.queueSearchParts(opts, true);
    const rows = this.db
      .query(
        `SELECT b.*, p.id AS p_id, p.name AS p_name, p.email AS p_email, p.company AS p_company,
                p.title AS p_title,
                p.icp_verdict AS p_icp_verdict, p.icp_verdict_reason AS p_icp_verdict_reason,
                (p.dossier_json IS NOT NULL AND TRIM(p.dossier_json) != '') AS p_has_dossier,
                (b.prospect_id IS NULL AND p.id IS NOT NULL) AS p_linked_by_email
         ${sql}
         ORDER BY ${orderSql}
         LIMIT ? OFFSET ?`,
      )
      .all(...(args as never[]), limit, offset) as QueueSearchRow[];
    if (opts.withTotal === false) return { rows, total: null };
    const total = (
      this.db.query(`SELECT COUNT(*) AS n ${sql}`).get(...(args as never[])) as {
        n: number;
      }
    ).n;
    return { rows, total };
  }

  /**
   * Per-status counts for the /prospects filter chips under the current
   * search/play/decided filters — the status filter itself is left out so a
   * chip can show how many rows it would reveal.
   */
  searchQueueStatusCounts(
    opts: Pick<QueueSearchOpts, "q" | "playName" | "decidedBy">,
  ): Record<QueueStatus, number> {
    const { sql, args } = this.queueSearchParts(opts, false);
    const rows = this.db
      .query(`SELECT b.status AS status, COUNT(*) AS n ${sql} GROUP BY b.status`)
      .all(...(args as never[])) as Array<{ status: QueueStatus; n: number }>;
    const out: Record<QueueStatus, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
      sent: 0,
      expired: 0,
    };
    for (const r of rows) if (r.status in out) out[r.status] = r.n;
    return out;
  }

  /** Every play that has ever enqueued a row, for the /prospects play filter. */
  listQueuePlayNames(): string[] {
    return (
      this.db
        .query("SELECT DISTINCT play_name FROM target_queue ORDER BY play_name ASC")
        .all() as Array<{ play_name: string }>
    ).map((r) => r.play_name);
  }

  /**
   * Every recorded step for a prospect across all plays — including bounced,
   * failed and unsubscribed ones, which `listSequenceEventsForProspect`
   * (the conversation view) filters out. `queued` rows are reservations,
   * not history. Oldest first.
   */
  listAllSequenceEventsForProspect(prospectId: number): SequenceEventRecord[] {
    return this.db
      .query(
        `SELECT * FROM sequence_events
         WHERE prospect_id = ? AND status != 'queued'
         ORDER BY created_at ASC, id ASC`,
      )
      .all(prospectId) as SequenceEventRecord[];
  }

  /** Inbound engagement on non-email channels (LinkedIn replies) for one prospect, oldest first. */
  listChannelEventsForProspect(prospectId: number): ChannelEventRecord[] {
    return this.db
      .query(`SELECT * FROM channel_events WHERE prospect_id = ? ORDER BY occurred_at ASC, id ASC`)
      .all(prospectId) as ChannelEventRecord[];
  }

  /** Recorded deal outcomes for one prospect, oldest first. */
  listDealOutcomesForProspect(prospectId: number): DealOutcomeRecord[] {
    return this.db
      .query(`SELECT * FROM deal_outcomes WHERE prospect_id = ? ORDER BY recorded_at ASC, id ASC`)
      .all(prospectId) as DealOutcomeRecord[];
  }

  /** Remove an unreviewed queue reservation, leaving reviewed rows untouched. */
  removePendingQueueTarget(id: number): boolean {
    const result = this.db
      .prepare("DELETE FROM target_queue WHERE id = ? AND status = 'pending'")
      .run(id);
    return result.changes > 0;
  }

  removeExpiredQueueTarget(id: number): boolean {
    const result = this.db
      .prepare("DELETE FROM target_queue WHERE id = ? AND status = 'expired'")
      .run(id);
    return result.changes > 0;
  }

  setQueueStatus(input: {
    id: number;
    status: QueueStatus;
    notes?: string;
    /**
     * Who made this transition. Defaults are per-status, chosen so every
     * existing unannotated caller stays correctly classified:
     * - approved → "human": approving IS the review act; no machine path
     *   approves single rows today (bulk goes through approveAllPending).
     * - rejected/sent → "machine": auto-reject gates and drain sends call
     *   this unannotated, and an unannotated caller must never mint a human
     *   REJECTION label (a mislabeled negative poisons any future fit) —
     *   the per-row UI routes pass "human" explicitly.
     */
    decidedBy?: "human" | "machine";
  }): void {
    const now = new Date().toISOString();
    const decidedBy = input.decidedBy ?? (input.status === "approved" ? "human" : "machine");
    // Every status transition clears `send_started_at` — a deliberate status
    // change means the previous "sending" attempt (if any) is settled. Terminal
    // states (sent/rejected/expired) clear naturally. Approved → approved
    // doesn't need to preserve a marker (caller re-claims on the next send).
    if (input.status === "sent") {
      // COALESCE on the decision columns: a drain/run send must never
      // overwrite the human approve that put the row here; a send on a
      // never-decided row records an honest machine disposition.
      this.db
        .prepare(
          `UPDATE target_queue SET status = ?, sent_at = ?, reviewed_at = COALESCE(reviewed_at, ?), decision = COALESCE(decision, 'approve'), decided_at = COALESCE(decided_at, ?), decided_by = COALESCE(decided_by, ?), send_started_at = NULL ${input.notes ? ", notes = ?" : ""} WHERE id = ?`,
        )
        .run(
          ...(input.notes
            ? [input.status, now, now, now, decidedBy, input.notes, input.id]
            : [input.status, now, now, now, decidedBy, input.id]),
        );
    } else if (input.status === "approved" || input.status === "pending") {
      // The ledger, not the routes, owns "never re-approve a sent row": drain
      // picks up every `status = 'approved'` row, so moving a sent row back to
      // pending/approved would re-email the person. queue.ts and
      // add-prospect.ts keep their own pre-checks (they produce the
      // user-facing 400/409 messages), but this is the guard that can't be
      // forgotten by a future caller (#561).
      //
      // The guard is baked into the UPDATE's WHERE clause instead of a
      // separate SELECT-then-UPDATE: a single statement is its own atomic
      // check-and-set, so two processes racing this call in WAL mode can't
      // both pass a "not sent yet" check before either holds the write lock
      // — the same class of race dequeueApproved's BEGIN IMMEDIATE guards
      // against a few lines below (~3449), just closed here by folding the
      // check into one statement instead of wrapping a transaction.
      const decision = input.status === "approved" ? "approve" : null;
      const result =
        input.status === "approved"
          ? this.db
              .prepare(
                `UPDATE target_queue SET status = ?, reviewed_at = ?, decision = ?, decided_at = ?, decided_by = ?, send_started_at = NULL ${input.notes ? ", notes = ?" : ""} WHERE id = ? AND status != 'sent' AND sent_at IS NULL`,
              )
              .run(
                ...(input.notes
                  ? [input.status, now, decision, now, decidedBy, input.notes, input.id]
                  : [input.status, now, decision, now, decidedBy, input.id]),
              )
          : this.db
              .prepare(
                `UPDATE target_queue SET status = ?, reviewed_at = NULL, send_started_at = NULL ${input.notes !== undefined ? ", notes = ?" : ""} WHERE id = ? AND status != 'sent' AND sent_at IS NULL`,
              )
              .run(
                ...(input.notes !== undefined
                  ? [input.status, input.notes, input.id]
                  : [input.status, input.id]),
              );
      this.throwIfSentRowGuardBlocked(result.changes, input.id, input.status);
    } else if (input.status === "rejected") {
      // Always overwrites: the latest decision wins on a re-decide. Rejecting
      // a sent row is allowed — it's a label, not a send, so no sent-row
      // guard here. `notes` follows the pending branch: present (even "")
      // means write it, so a founder can clear a stale reason; absent means
      // leave whatever is there.
      const decision = decidedBy === "human" ? "reject" : "auto_reject";
      this.db
        .prepare(
          `UPDATE target_queue SET status = ?, reviewed_at = ?, decision = ?, decided_at = ?, decided_by = ?, send_started_at = NULL ${input.notes !== undefined ? ", notes = ?" : ""} WHERE id = ?`,
        )
        .run(
          ...(input.notes !== undefined
            ? [input.status, now, decision, now, decidedBy, input.notes, input.id]
            : [input.status, now, decision, now, decidedBy, input.id]),
        );
    } else {
      this.db
        .prepare(`UPDATE target_queue SET status = ?, send_started_at = NULL WHERE id = ?`)
        .run(input.status, input.id);
    }
  }

  /**
   * Fired after a guarded approved/pending UPDATE affects 0 rows: the row
   * may simply not exist (fine, matches the pre-#561 no-op behavior for an
   * unknown id) or it may have been excluded by the sent-row guard in the
   * WHERE clause. Only the latter throws.
   */
  private throwIfSentRowGuardBlocked(changes: number, id: number, status: QueueStatus): void {
    if (changes > 0) return;
    const current = this.db
      .query("SELECT status, sent_at FROM target_queue WHERE id = ?")
      .get(id) as { status: QueueStatus; sent_at: string | null } | undefined;
    if (current && (current.status === "sent" || current.sent_at != null)) {
      throw new Error(
        `setQueueStatus: row #${id} was already sent — refusing to move it to '${status}' (would re-send on the next drain)`,
      );
    }
  }

  /**
   * Atomic claim of the queue-send marker on `target_queue.send_started_at`.
   * Mirrors `claimCadenceSendingMarker` semantics — survives server restart so
   * `/queue` Send-draft UI doesn't lose its spinner on `bun --watch` reloads.
   * Cleared on success via `setQueueStatus('sent', …)`, on failure via
   * `clearQueueSendingMarker`, on cold boot via `sweepStaleQueueSends`.
   */
  claimQueueSendingMarker(input: {
    id: number;
    startedAtIso: string;
    staleCutoffIso?: string;
  }): boolean {
    const markerWhere = input.staleCutoffIso
      ? "(send_started_at IS NULL OR send_started_at < ?)"
      : "send_started_at IS NULL";
    const args: Array<string | number> = [input.startedAtIso, input.id];
    if (input.staleCutoffIso) args.push(input.staleCutoffIso);
    const result = this.db
      .prepare(
        // sent_at IS NULL is belt-and-braces alongside status = 'approved' —
        // the same guard setQueueStatus and dequeueApproved apply, closed
        // here too so a row desynced back to 'approved' with a stale
        // sent_at can't be claimed and re-sent through this path (#561).
        `UPDATE target_queue SET send_started_at = ?
         WHERE id = ? AND status = 'approved' AND sent_at IS NULL AND ${markerWhere}`,
      )
      .run(...args);
    return result.changes > 0;
  }

  clearQueueSendingMarker(id: number): void {
    this.clearMarker({
      table: "target_queue",
      pkeyWhere: "id = ?",
      column: "send_started_at",
      pkeyValues: [id],
    });
  }

  /**
   * Sweep queue rows whose `send_started_at` is older than `maxAgeMs` (or any
   * non-null when 0 — cold-boot semantics). For each: classify by current
   * status. status='sent' means the SDK call landed before the kill (clear
   * the marker only); otherwise the send was stranded (clear the marker,
   * draft is still on the row for retry).
   */
  sweepStaleQueueSends(input: { now: Date; maxAgeMs: number }): Array<{
    id: number;
    startedAt: string;
    ageMs: number;
    actuallySent: boolean;
  }> {
    const cutoffMs = input.now.getTime() - input.maxAgeMs;
    const rows = this.db
      .query(
        `SELECT id, status, send_started_at FROM target_queue WHERE send_started_at IS NOT NULL`,
      )
      .all() as Array<{ id: number; status: string; send_started_at: string }>;
    const swept: Array<{
      id: number;
      startedAt: string;
      ageMs: number;
      actuallySent: boolean;
    }> = [];
    const clear = this.db.prepare(`UPDATE target_queue SET send_started_at = NULL WHERE id = ?`);
    for (const row of rows) {
      const startedMs = new Date(row.send_started_at).getTime();
      if (Number.isFinite(startedMs) && startedMs > cutoffMs) continue;
      const ageMs = Number.isFinite(startedMs) ? input.now.getTime() - startedMs : -1;
      clear.run(row.id);
      swept.push({
        id: row.id,
        startedAt: row.send_started_at,
        ageMs,
        actuallySent: row.status === "sent",
      });
    }
    return swept;
  }

  approveAllPending(opts: { playName?: string } = {}): number {
    // `sent_at IS NULL` is belt-and-braces alongside `status = 'pending'` —
    // a pending row should never carry a sent_at, but the invariant lives
    // here, not in the caller (#561).
    const where: string[] = ["status = 'pending'", "sent_at IS NULL"];
    const args: unknown[] = [];
    if (opts.playName) {
      where.push("play_name = ?");
      args.push(opts.playName);
    }
    // decided_by='human_bulk': a human sanctioned the batch, but no per-row
    // judgment happened — evaluation code can include or exclude these
    // explicitly instead of reverse-engineering shared timestamps.
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE target_queue SET status = 'approved', reviewed_at = ?, decision = 'approve', decided_at = ?, decided_by = 'human_bulk' WHERE ${where.join(" AND ")}`,
      )
      .run(...([now, now, ...args] as never[]));
    return Number(result.changes);
  }

  /**
   * Atomic claim-and-return: SELECT + `drain_claimed_at` UPDATE in one
   * transaction so concurrent drains can't overlap. 15-min lease self-heals a
   * crashed drain; held/error rows back off for the lease duration.
   */
  dequeueApproved(opts: { playName: string; limit?: number; leaseSeconds?: number }): QueueRow[] {
    const leaseSeconds = opts.leaseSeconds ?? 900;
    const claimedAt = new Date().toISOString();
    const cutoff = new Date(Date.now() - leaseSeconds * 1000).toISOString();
    const limit = opts.limit ?? 50;
    const txn = this.db.transaction((): QueueRow[] => {
      const rows = this.db
        .query(
          `SELECT * FROM target_queue
           WHERE play_name = ? AND status = 'approved' AND sent_at IS NULL
             AND (drain_claimed_at IS NULL OR drain_claimed_at < ?)
           ORDER BY found_at ASC
           LIMIT ?`,
        )
        .all(opts.playName, cutoff, limit) as QueueRow[];
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      this.db
        .prepare(`UPDATE target_queue SET drain_claimed_at = ? WHERE id IN (${placeholders})`)
        .run(...([claimedAt, ...ids] as never[]));
      return rows;
    });
    // BEGIN IMMEDIATE takes a RESERVED lock at the start of the transaction
    // instead of the default DEFERRED (which only locks on the first write).
    // In WAL mode with two processes, DEFERRED lets both transactions pass
    // the SELECT before either holds the write lock, then the second UPDATE
    // silently overwrites the first's claim — both drains would consider the
    // rows theirs. IMMEDIATE serializes the whole thing across connections.
    return txn.immediate();
  }

  expirePendingOlderThan(days: number): number {
    const sinceIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    const result = this.db
      .prepare(
        `UPDATE target_queue SET status = 'expired' WHERE status = 'pending' AND found_at < ?`,
      )
      .run(sinceIso);
    return Number(result.changes);
  }

  queueCounts(): Record<QueueStatus, number> {
    const rows = this.db
      .query("SELECT status, COUNT(*) AS n FROM target_queue GROUP BY status")
      .all() as Array<{ status: QueueStatus; n: number }>;
    const out: Record<QueueStatus, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
      sent: 0,
      expired: 0,
    };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  /**
   * Approved-row count per play, across the whole queue. Deliberately ignores
   * any status/play filter the caller is showing: /queue's drain button needs
   * to know a play has drainable rows even when the visible page is filtered
   * to `pending`. Plays with zero approved rows are absent from the map.
   */
  approvedCountsByPlay(): Record<string, number> {
    const rows = this.db
      .query(
        "SELECT play_name, COUNT(*) AS n FROM target_queue WHERE status = 'approved' GROUP BY play_name",
      )
      .all() as Array<{ play_name: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.play_name] = r.n;
    return out;
  }

  /** Reviewed queue outcomes for one finder inside a trailing time window. */
  finderApprovalStats(input: { finder: string; sinceIso: string }): {
    approved: number;
    reviewed: number;
    rate: number | null;
  } {
    // post-funding-auto predates the registry name and writes find:post-funding.
    const sourceName = input.finder === "post-funding-auto" ? "post-funding" : input.finder;
    const source = `find:${sourceName}`;
    const row = this.db
      .query(
        `SELECT
           SUM(CASE WHEN status IN ('approved','sent') THEN 1 ELSE 0 END) AS approved,
           COUNT(*) AS reviewed
         FROM target_queue
         WHERE (source = ? OR source LIKE ?)
           AND ${humanDecisionWhereSql()}
           AND reviewed_at >= ?`,
      )
      .get(source, `${source}:%`, input.sinceIso) as {
      approved: number | null;
      reviewed: number;
    };
    const approved = row.approved ?? 0;
    const reviewed = row.reviewed ?? 0;
    return { approved, reviewed, rate: reviewed > 0 ? approved / reviewed : null };
  }

  // ── runs (per-/run-page dispatch records) ──────────────────────────────────
  // One row per /run Execute click; the SSE endpoint persists events/counters,
  // the UI rebuilds progress from the row, and the cold-boot sweep flips
  // stranded `running` rows to `interrupted`.

  createRun(input: {
    playName: string;
    dryRun: boolean;
    targets: unknown[];
    dedupeKeys?: Array<string | null>;
  }): {
    runId: number;
    startedAt: string;
  } {
    const startedAt = new Date().toISOString();
    const result = this.db
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
   * counter. Cheap re-serialize is fine — events_json fits in a single row;
   * runs are bounded at ~25 targets typically.
   */
  appendRunEvent(input: { runId: number; event: unknown }): void {
    const row = this.db
      .query(
        `SELECT events_json, drafted_count, sent_count, error_count
         FROM runs WHERE id = ?`,
      )
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
    // Counter bump driven by event.kind — keeps the writer side simple and
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
    this.db
      .prepare(
        `UPDATE runs
         SET events_json = ?, drafted_count = ?, sent_count = ?, error_count = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(events), drafted, sent, errors, input.runId);
  }

  /**
   * Terminal write for a run that finished on its own. Cancellation goes
   * through `cancelRun` instead — it is the only writer of 'cancelled', so a
   * cancelled row can never exist without the reason that explains it.
   */
  markRunComplete(input: {
    runId: number;
    status: "done" | "interrupted";
    sentEmails?: string[];
  }): void {
    const completedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE runs
         SET status = ?, completed_at = ?, prospect_emails_json = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(input.status, completedAt, JSON.stringify(input.sentEmails ?? []), input.runId);
  }

  /**
   * Overwrite the run's record of which prospects it actually emailed, in any
   * status. Deliberately not CASed on 'running': a cancelled run's last sends
   * land after the row went terminal (the play's workers finish one by one),
   * and the /cadences?sinceRun deep-link needs them.
   */
  setRunSentEmails(input: { runId: number; sentEmails: string[] }): void {
    this.db
      .prepare(`UPDATE runs SET prospect_emails_json = ? WHERE id = ?`)
      .run(JSON.stringify(input.sentEmails), input.runId);
  }

  /**
   * Flip a still-'running' row to the terminal 'cancelled' state with the
   * reason it ended. CAS on `status = 'running'` so this is a no-op — never an
   * error — against a run that already finished, and so it races safely with
   * the SSE handler's own completion write. `sentEmails` records what did go
   * out before the abort, keeping the /cadences?sinceRun deep-link honest.
   *
   * Returns whether this call was the one that cancelled it, plus the row's
   * status afterwards (null when there is no such run).
   */
  cancelRun(input: { runId: number; reason: string; sentEmails?: string[] }): {
    cancelled: boolean;
    status: "running" | "done" | "interrupted" | "cancelled" | null;
  } {
    // Sent-email bookkeeping is deliberately outside the CAS below: the cancel
    // route may have flipped the row already by the time the SSE handler
    // unwinds, and the emails it collected still belong on the record. Only
    // that handler passes `sentEmails`, so the two callers can't clobber
    // each other whichever order they land in.
    if (input.sentEmails)
      this.setRunSentEmails({ runId: input.runId, sentEmails: input.sentEmails });
    const completedAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE runs
         SET status = 'cancelled', completed_at = ?, cancel_reason = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(completedAt, input.reason, input.runId);
    const row = this.db.query(`SELECT status FROM runs WHERE id = ?`).get(input.runId) as {
      status: "running" | "done" | "interrupted" | "cancelled";
    } | null;
    return { cancelled: result.changes > 0, status: row?.status ?? null };
  }

  getRun(runId: number): {
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
  } | null {
    const row = this.db.query(`SELECT * FROM runs WHERE id = ?`).get(runId) as {
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
   * Compact run listing for dashboards. Returns lightweight columns only —
   * `events_json` + `targets_json` stay on the row but aren't read here so
   * `/api/home` doesn't pay to ship them on every 30s poll. Default order:
   * newest started_at first; capped at `limit` rows (default 5). When
   * `status` is set, filters via the existing `idx_runs_status` index.
   */
  listRuns(
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
    const rows = this.db
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
   * (or any non-null when 0 — cold-boot semantics). Marks them as
   * 'interrupted' so the UI shows a truthful banner instead of an eternal
   * spinner. Returns the swept rows so the caller can log them.
   *
   * Terminal rows — including 'cancelled' — are never touched: a run the user
   * cancelled must not be relabelled as a crash by the next cold boot.
   */
  sweepStaleRuns(input: { now: Date; maxAgeMs: number }): Array<{
    id: number;
    playName: string;
    startedAt: string;
    ageMs: number;
  }> {
    const cutoffMs = input.now.getTime() - input.maxAgeMs;
    const rows = this.db
      .query(`SELECT id, play_name, started_at FROM runs WHERE status = 'running'`)
      .all() as Array<{ id: number; play_name: string; started_at: string }>;
    const swept: Array<{
      id: number;
      playName: string;
      startedAt: string;
      ageMs: number;
    }> = [];
    const update = this.db.prepare(
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
      swept.push({
        id: row.id,
        playName: row.play_name,
        startedAt: row.started_at,
        ageMs,
      });
    }
    return swept;
  }

  // ── triggers (find watch state) ────────────────────────────────────────────

  upsertTrigger(input: { name: string; configJson: string; enabled?: boolean }): void {
    this.db
      .prepare(
        `INSERT INTO triggers(name, enabled, config_json)
         VALUES(?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           enabled = excluded.enabled,
           config_json = excluded.config_json`,
      )
      .run(input.name, input.enabled === false ? 0 : 1, input.configJson);
  }

  getTrigger(name: string): TriggerRow | null {
    return (this.db.query("SELECT * FROM triggers WHERE name = ?").get(name) as TriggerRow) ?? null;
  }

  listTriggers(): TriggerRow[] {
    return this.db.query("SELECT * FROM triggers ORDER BY name ASC").all() as TriggerRow[];
  }

  /**
   * Records the result of a finished run AND clears `running_started_at` in
   * the same statement. This is the only "completed" path — both success and
   * caught-finder-throw funnel through here, so clearing the in-flight flag
   * here is the right semantic.
   */
  updateTriggerLastPoll(input: { name: string; summary: unknown }): void {
    this.db
      .prepare(
        `UPDATE triggers
         SET last_polled_at = ?, last_run_summary = ?, running_started_at = NULL
         WHERE name = ?`,
      )
      .run(new Date().toISOString(), JSON.stringify(input.summary), input.name);
  }

  /**
   * Release a trigger's in-flight claim WITHOUT stamping `last_polled_at`
   * (issue #481 review finding). Used only when the finder never actually
   * ran — currently the daily spend ceiling refusal branches in
   * `registry.ts`. `updateTriggerLastPoll` would treat the refusal as a
   * completed poll and push `dueAt` a full interval into the future, so a
   * trigger blocked by the ceiling would sit unpolled long after headroom
   * (or a new day) opens back up. `last_run_summary` still records the
   * refusal reason so the dashboard/doctor surface it, same as before.
   */
  clearTriggerClaim(input: { name: string; summary: unknown }): void {
    this.db
      .prepare(
        `UPDATE triggers
         SET last_run_summary = ?, running_started_at = NULL
         WHERE name = ?`,
      )
      .run(JSON.stringify(input.summary), input.name);
  }

  /**
   * Atomic claim: marks a trigger in-flight only if not already running — the
   * conditional UPDATE closes the TOCTOU race where two fireTriggerNow calls
   * both fire and double-spend. `staleCutoffIso` also lets the claim succeed
   * over a stale marker so a dead row doesn't 409 until the next cold boot.
   * Cleared by updateTriggerLastPoll or sweepStaleRunningTriggers.
   */
  markTriggerRunning(name: string, startedAtIso: string, staleCutoffIso?: string): boolean {
    return this.claimMarker({
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
  sweepStaleRunningTriggers(input: {
    now: Date;
    maxAgeMs: number;
  }): Array<{ name: string; startedAt: string; ageMs: number }> {
    const cutoffMs = input.now.getTime() - input.maxAgeMs;
    const rows = this.db
      .query(`SELECT name, running_started_at FROM triggers WHERE running_started_at IS NOT NULL`)
      .all() as Array<{ name: string; running_started_at: string }>;
    const swept: Array<{ name: string; startedAt: string; ageMs: number }> = [];
    const update = this.db.prepare(
      `UPDATE triggers
       SET last_polled_at = ?, last_run_summary = ?, running_started_at = NULL
       WHERE name = ?`,
    );
    for (const row of rows) {
      const startedMs = new Date(row.running_started_at).getTime();
      if (!Number.isFinite(startedMs)) {
        // Garbage timestamp — clear it so it doesn't perpetually re-trip.
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

  setTriggerEnabled(name: string, enabled: boolean): void {
    this.db.prepare(`UPDATE triggers SET enabled = ? WHERE name = ?`).run(enabled ? 1 : 0, name);
  }

  setTriggerConfig(name: string, configJson: string): void {
    this.db.prepare(`UPDATE triggers SET config_json = ? WHERE name = ?`).run(configJson, name);
  }

  /**
   * Apply a batch of trigger config writes atomically — insert a fresh
   * enabled row for a trigger with no stored config, or update an existing
   * row's config and enable it, for every entry in ONE transaction. Used by
   * the packs apply route: `applyPackRoute` previously ran each trigger's
   * upsert/update pair outside a transaction, so a later write throwing left
   * earlier writes in the batch persisted and the route returned a 500 with
   * a half-applied pack (finding PRRT_kwDOSKzrBs6fCBct). A throw here rolls
   * back every write in the batch, not just the failing one.
   */
  applyTriggerConfigs(entries: Array<{ name: string; configJson: string }>): void {
    const upsert = this.db.prepare(
      `INSERT INTO triggers(name, enabled, config_json)
       VALUES(?, 1, ?)
       ON CONFLICT(name) DO UPDATE SET
         enabled = 1,
         config_json = excluded.config_json`,
    );
    const tx = this.db.transaction(() => {
      for (const entry of entries) upsert.run(entry.name, entry.configJson);
    });
    tx();
  }

  /**
   * Associate a queued target with a known prospect (so the queue page can
   * link back to the prospect record). Best-effort — the caller is expected
   * to swallow failures since the link is a convenience, not a correctness
   * invariant.
   */
  setQueueProspectId(id: number, prospectId: number): void {
    this.db.prepare(`UPDATE target_queue SET prospect_id = ? WHERE id = ?`).run(prospectId, id);
    const row = this.getQueueRow(id);
    if (row && !this.getMailAddress(`prospect:${prospectId}`)) {
      const payload = JSON.parse(row.payload_json);
      const address = extractBusinessAddress(payload, this.getProspectById(prospectId)?.name ?? "");
      if (address)
        this.setMailAddress(
          `prospect:${prospectId}`,
          address,
          payload.businessAddressSource ?? row.source,
        );
    }
  }

  /** Save a generated draft only if no concurrent edit/send changed its inputs. */
  setQueueDraftIfCurrent(input: {
    id: number;
    previousDraft: string | null;
    previousPayload: string;
    draft: Parameters<Ledger["setQueueDraft"]>[0]["draft"];
  }): boolean {
    const at = new Date().toISOString();
    return (
      this.db
        .prepare(`UPDATE target_queue SET last_draft_json = ?, last_drafted_at = ?
      WHERE id = ? AND last_draft_json IS ? AND payload_json = ?
      AND status != 'sent' AND sent_at IS NULL AND send_started_at IS NULL`)
        .run(
          JSON.stringify({ ...input.draft, draftedAt: at }),
          at,
          input.id,
          input.previousDraft,
          input.previousPayload,
        ).changes === 1
    );
  }

  /**
   * Persist the most-recent draft for this queue row (the /run page is
   * ephemeral; /queue reviews from here). Most-recent-wins — re-runs
   * overwrite without history.
   */
  setQueueDraft(input: {
    id: number;
    draft: {
      subject: string;
      body: string;
      flags: string[];
      sent: boolean;
      receiptIds: number[];
      dryRun: boolean;
      enrichmentFailed?: boolean;
      angle?: unknown;
    };
  }): void {
    const draftedAtIso = new Date().toISOString();
    const json = JSON.stringify({ ...input.draft, draftedAt: draftedAtIso });
    this.db
      .prepare(`UPDATE target_queue SET last_draft_json = ?, last_drafted_at = ? WHERE id = ?`)
      .run(json, draftedAtIso, input.id);
  }

  /**
   * Overwrite a queue row's `payload_json`. Manual add-prospect flow: the row
   * is enqueued as a placeholder, then rewritten with the researched dossier
   * so regenerate re-drafts without paying for research again.
   */
  updateQueuePayload(input: { id: number; payload: unknown }): void {
    this.db
      .prepare(`UPDATE target_queue SET payload_json = ? WHERE id = ?`)
      .run(JSON.stringify(input.payload), input.id);
  }

  /**
   * The payload of the most recent SENT queue row for this play and address —
   * how a follow-up recovers the edge the intro drew its angle from (issue
   * #584), whichever path sent it (drain, /queue send-draft, mark-sent). Null
   * when nothing was sent to them on this play, or the payload won't parse.
   */
  latestSentQueuePayload(playName: string, email: string): Record<string, unknown> | null {
    const row = this.db
      .query(
        `SELECT payload_json FROM target_queue
          WHERE play_name = ? AND status = 'sent'
            AND lower(trim(json_extract(payload_json, '$.email'))) = lower(trim(?))
          ORDER BY sent_at DESC, id DESC LIMIT 1`,
      )
      .get(playName, email) as { payload_json: string } | null;
    if (!row) return null;
    try {
      const parsed: unknown = JSON.parse(row.payload_json);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /**
   * `latestSentQueuePayload` for a whole page of cadences at once (issue
   * #599): one query over the sent rows of the plays involved, newest first,
   * keeping the first row per `play|email`. Keyed exactly like the single-row
   * lookup canonicalises (lower-cased, trimmed email). Pairs with no email are
   * skipped; an empty input touches nothing. Never throws — `json_valid`
   * keeps a malformed row out of `json_extract` (which would fail the whole
   * query), so a bad payload is simply absent from the map.
   */
  latestSentQueuePayloads(
    pairs: ReadonlyArray<{ playName: string; email: string | null }>,
  ): Map<string, Record<string, unknown>> {
    const out = new Map<string, Record<string, unknown>>();
    const wanted = new Set<string>();
    const plays = new Set<string>();
    for (const p of pairs) {
      const email = p.email?.trim().toLowerCase();
      if (!email) continue;
      wanted.add(`${p.playName}|${email}`);
      plays.add(p.playName);
    }
    if (wanted.size === 0) return out;
    const playList = [...plays];
    const rows = this.db
      .query(
        `SELECT play_name, lower(trim(json_extract(payload_json, '$.email'))) AS email, payload_json
           FROM target_queue
          WHERE status = 'sent' AND json_valid(payload_json)
            AND play_name IN (${playList.map(() => "?").join(",")})
          ORDER BY sent_at DESC, id DESC`,
      )
      .all(...playList) as Array<{ play_name: string; email: string | null; payload_json: string }>;
    for (const row of rows) {
      if (!row.email) continue;
      const key = `${row.play_name}|${row.email}`;
      if (!wanted.has(key) || out.has(key)) continue;
      try {
        const parsed: unknown = JSON.parse(row.payload_json);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out.set(key, parsed as Record<string, unknown>);
        }
      } catch {
        // an unparsable payload is no reminder; the row simply has none
      }
      if (out.size === wanted.size) break;
    }
    return out;
  }

  /**
   * Run several ledger writes as one SQLite transaction. For the engine
   * steps that must land together (a recorded event and the state advance it
   * explains) — an interruption between them would leave a row that says one
   * thing and a cadence that says another.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Merge a few keys into a LIVE queue row's payload (issue #592) — pending or
   * approved, not sent, not mid-send. One statement, so there is no window
   * between checking eligibility and writing: a row that got sent between the
   * caller's listing and this call is simply not updated, and the caller is
   * told. `updateQueuePayload` above has no guard and stays for the paths that
   * own their row (the manual add's research rewrite).
   */
  patchLiveQueuePayload(input: { id: number; patch: Record<string, unknown> }): boolean {
    const r = this.db
      .prepare(
        `UPDATE target_queue
            SET payload_json = json_patch(payload_json, ?)
          WHERE id = ?
            AND status IN ('pending', 'approved')
            AND sent_at IS NULL
            AND send_started_at IS NULL
            AND json_valid(payload_json)`,
      )
      .run(JSON.stringify(input.patch), input.id);
    return r.changes === 1;
  }

  latestQueueId(): number {
    const row = this.db.query("SELECT COALESCE(MAX(id), 0) AS id FROM target_queue").get() as {
      id: number;
    };
    return row.id;
  }

  /** Newly-created pending rows, used by the post-finder product research stage. */
  listPendingQueueAfterId(id: number): QueueRow[] {
    return this.db
      .query("SELECT * FROM target_queue WHERE id > ? AND status = 'pending' ORDER BY id ASC")
      .all(id) as QueueRow[];
  }

  getProductResearchCache(cacheKey: string, maxAgeMs: number): string | null {
    return this.cache.getProductResearchCache(cacheKey, maxAgeMs);
  }

  setProductResearchCache(cacheKey: string, dossierJson: string): void {
    this.cache.setProductResearchCache(cacheKey, dossierJson);
  }

  /**
   * Set a queue row's `notes` without touching its status. Used by the manual
   * add-prospect flow to update the transient "researching profile…" note to
   * a "no email found" flag (or a research-failed message) once the async job
   * settles. Pass an empty string to clear it.
   */
  setQueueNotes(input: { id: number; notes: string }): void {
    this.db
      .prepare(`UPDATE target_queue SET notes = ? WHERE id = ?`)
      .run(input.notes === "" ? null : input.notes, input.id);
  }

  /**
   * Overwrite a queue row's shadow priority (the `score-prospects` backfill
   * writer). Pass null to clear.
   */
  setQueuePriority(id: number, priority: ProspectPriority | null): void {
    this.db
      .prepare(`UPDATE target_queue SET priority_json = ? WHERE id = ?`)
      .run(priority ? JSON.stringify(priority) : null, id);
  }

  /**
   * Rows the score-prospects backfill considers: pending + approved. Approved
   * implies unsent — a dispatched row moves to status 'sent'. id-ascending so
   * an interrupted run resumes deterministically.
   */
  listQueueRowsForScoring(
    opts: { playName?: string; limit?: number; allStatuses?: boolean } = {},
  ): QueueRow[] {
    const args: unknown[] = [];
    // Default scope is the live queue; `allStatuses` widens to full history so
    // scores can be compared against dispositions already made (methodology
    // evaluation) — it never changes what any consumer DOES with a score.
    let where = opts.allStatuses ? `1=1` : `status IN ('pending','approved')`;
    if (opts.playName) {
      where += ` AND play_name = ?`;
      args.push(opts.playName);
    }
    // Unbounded by default: the caller filters already-scored rows AFTER this
    // read, so a default LIMIT would pin every run to the same prefix and rows
    // past it could never be reached.
    let limitSql = "";
    if (opts.limit !== undefined) {
      limitSql = ` LIMIT ?`;
      args.push(opts.limit);
    }
    return this.db
      .query(`SELECT * FROM target_queue WHERE ${where} ORDER BY id ASC${limitSql}`)
      .all(...(args as never[])) as QueueRow[];
  }

  /**
   * Every sent queue row joined to its outcome evidence (Phase 3 of #410).
   * The prospect link is `prospect_id` when the post-send backfill caught it,
   * else an email join (LOWER/TRIM defeats the index — acceptable, this is an
   * offline report path over hundreds of rows). `COALESCE(kind,'human')` is
   * mandatory: pre-v23 replies have NULL kind and read as human everywhere.
   * `deal_lost`/`ghosted` map to no rank on purpose — deal_outcomes is
   * positives-only by construction (the cadences modal offers only the three
   * positive states), so its absence is never evidence of failure.
   */
  listSentOutcomeRows(opts: { playName?: string } = {}): SentOutcomeRawRow[] {
    const args: unknown[] = [];
    let where = `q.status = 'sent' AND q.sent_at IS NOT NULL`;
    if (opts.playName) {
      where += ` AND q.play_name = ?`;
      args.push(opts.playName);
    }
    return this.db
      .query(
        `SELECT q.id, q.play_name, q.dedupe_key, q.priority_json, q.sent_at,
                q.decision, q.decided_by,
                COALESCE(q.prospect_id, p.id) AS joined_prospect_id,
                json_extract(q.payload_json, '$.email') AS payload_email,
                (SELECT MIN(ir.received_at) FROM inbox_replies ir
                  WHERE ir.prospect_id = COALESCE(q.prospect_id, p.id)
                    AND COALESCE(ir.kind, 'human') = 'human') AS first_email_reply_at,
                (SELECT ir.intent FROM inbox_replies ir
                  WHERE ir.prospect_id = COALESCE(q.prospect_id, p.id)
                    AND COALESCE(ir.kind, 'human') = 'human'
                  ORDER BY ir.received_at ASC, ir.id ASC LIMIT 1) AS first_email_reply_intent,
                (SELECT MIN(ce.occurred_at) FROM channel_events ce
                  WHERE ce.prospect_id = COALESCE(q.prospect_id, p.id)
                    AND ce.event_type = 'reply') AS first_channel_reply_at,
                (SELECT MAX(CASE d.outcome WHEN 'deal_won' THEN 4
                                           WHEN 'sql_qualified' THEN 3
                                           WHEN 'meeting_booked' THEN 2
                                           ELSE NULL END)
                   FROM deal_outcomes d
                  WHERE d.prospect_id = COALESCE(q.prospect_id, p.id)) AS deal_rank
         FROM target_queue q
         LEFT JOIN prospects p
           ON p.email = LOWER(TRIM(json_extract(q.payload_json, '$.email')))
         WHERE ${where}
         ORDER BY q.id ASC`,
      )
      .all(...(args as never[])) as SentOutcomeRawRow[];
  }

  /**
   * The local funnel ladder: receipts value-tagged by outcome attribution
   * (engagement < meeting < qualified < revenue). goal_id is a sha256 of
   * (play, email) — not computable in SQLite, so the caller joins in JS via
   * `cadenceGoalId`.
   */
  listValueTaggedReceipts(): Array<{ goal_id: string; value_tag: string }> {
    return this.receipts.listValueTaggedReceipts();
  }

  close(): void {
    this.db.close();
  }

  // ── Meetings (issue #577) ─────────────────────────────────────────────

  /**
   * Upsert one calendar event. NEVER `INSERT OR REPLACE` (a cancellation
   * stub carries almost no fields and would wipe summary/prospect_id/
   * outcome) and NEVER `INSERT OR IGNORE` (unlike an immutable inbox_replies
   * row, an event mutates in place — a reschedule or cancellation is an
   * UPDATE to the same row). `undefined` on any field means "this poll
   * response didn't carry it" and preserves the existing value via
   * `COALESCE(excluded.col, meetings.col)`; pass `null` explicitly to CLEAR
   * a field.
   *
   * Two special cases the caller relies on:
   *  - A cancellation stub (`status: 'cancelled'`, no `startsAt`) for an
   *    event this ledger has never seen is a no-op — there's no start time
   *    to even file a ghost row under, so nothing is inserted.
   *  - A reschedule (an existing row whose `startsAt` differs from the new
   *    value) clears `outcomePromptedAt` — a stale nudge must withdraw —
   *    while leaving any already-recorded `outcome` untouched.
   *
   * Returns whether this event is new to the ledger and whether its
   * `attendeesFingerprint` changed since last seen — the poller uses the
   * latter to decide whether re-matching is worth running at all (a
   * founder's dismiss must stick until the attendee set actually changes).
   */
  upsertMeeting(input: {
    calendarId: string;
    eventId: string;
    icalUid?: string | null;
    recurringEventId?: string | null;
    status: string;
    summary?: string | null;
    allDay?: boolean;
    startsAt?: string | null;
    endsAt?: string | null;
    eventTimezone?: string | null;
    organizerEmail?: string | null;
    selfResponse?: string | null;
    externalAttendeeCount?: number;
    externalAttendeesJson?: string | null;
    attendeesOmitted?: boolean;
    matchStatus?: MeetingMatchStatus;
    matchMethod?: MeetingMatchMethod;
    matchConfidence?: number | null;
    prospectId?: number | null;
    suggestedProspectId?: number | null;
    eventUpdatedAt?: string | null;
    attendeesFingerprint?: string | null;
  }): { isNew: boolean; fingerprintChanged: boolean } {
    const existing = this.db
      .query(
        `SELECT starts_at, attendees_fingerprint FROM meetings
         WHERE calendar_id = ? AND event_id = ?`,
      )
      .get(input.calendarId, input.eventId) as
      | { starts_at: string | null; attendees_fingerprint: string | null }
      | undefined;
    const isNew = !existing;
    const fingerprintChanged =
      !existing ||
      (existing.attendees_fingerprint ?? null) !== (input.attendeesFingerprint ?? null);

    const isUnseenCancellationStub =
      isNew && input.status === "cancelled" && input.startsAt == null;
    if (isUnseenCancellationStub) {
      // Nothing to file this under — deliberately never inserted.
      return { isNew: true, fingerprintChanged: false };
    }

    this.db
      .prepare(
        `INSERT INTO meetings (
           calendar_id, event_id, ical_uid, recurring_event_id, status, summary,
           all_day, starts_at, ends_at, event_timezone, organizer_email,
           self_response, external_attendee_count, external_attendees_json,
           attendees_omitted, prospect_id, suggested_prospect_id, match_status,
           match_method, match_confidence, event_updated_at, attendees_fingerprint,
           first_seen_at, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   datetime('now'), datetime('now'))
         ON CONFLICT(calendar_id, event_id) DO UPDATE SET
           ical_uid                = COALESCE(excluded.ical_uid, meetings.ical_uid),
           recurring_event_id      = COALESCE(excluded.recurring_event_id, meetings.recurring_event_id),
           status                  = COALESCE(excluded.status, meetings.status),
           summary                 = COALESCE(excluded.summary, meetings.summary),
           all_day                 = COALESCE(excluded.all_day, meetings.all_day),
           -- A reschedule (starts_at genuinely changes) withdraws any stale
           -- nudge; the recorded outcome itself is untouched either way.
           outcome_prompted_at     = CASE
             WHEN excluded.starts_at IS NOT NULL AND excluded.starts_at IS NOT meetings.starts_at
               THEN NULL ELSE meetings.outcome_prompted_at END,
           starts_at               = COALESCE(excluded.starts_at, meetings.starts_at),
           ends_at                 = COALESCE(excluded.ends_at, meetings.ends_at),
           event_timezone          = COALESCE(excluded.event_timezone, meetings.event_timezone),
           organizer_email         = COALESCE(excluded.organizer_email, meetings.organizer_email),
           self_response           = COALESCE(excluded.self_response, meetings.self_response),
           external_attendee_count = COALESCE(excluded.external_attendee_count, meetings.external_attendee_count),
           external_attendees_json = COALESCE(excluded.external_attendees_json, meetings.external_attendees_json),
           attendees_omitted       = COALESCE(excluded.attendees_omitted, meetings.attendees_omitted),
           -- A founder dismissal ('dismissed') must survive a re-poll that
           -- carries no new match verdict (matchStatus undefined) — but a
           -- fresh verdict from the matcher (always passed together with a
           -- changed fingerprint) overwrites it, which is how a dismiss is
           -- allowed to lapse once the attendee set actually changes.
           prospect_id             = COALESCE(excluded.prospect_id, meetings.prospect_id),
           suggested_prospect_id   = excluded.suggested_prospect_id,
           match_status            = COALESCE(excluded.match_status, meetings.match_status),
           match_method            = excluded.match_method,
           match_confidence        = excluded.match_confidence,
           event_updated_at        = COALESCE(excluded.event_updated_at, meetings.event_updated_at),
           attendees_fingerprint   = COALESCE(excluded.attendees_fingerprint, meetings.attendees_fingerprint),
           last_seen_at            = datetime('now')`,
      )
      .run(
        input.calendarId,
        input.eventId,
        input.icalUid ?? null,
        input.recurringEventId ?? null,
        input.status,
        input.summary ?? null,
        // NOT NULL columns (schema DEFAULT 0) — must never bind NULL, or a
        // fresh INSERT (no existing row for the ON CONFLICT COALESCE to
        // fall back to) violates the constraint. The real caller
        // (packages/plays' calendar poller) always supplies these three
        // explicitly on every call, so defaulting an omitted one to
        // false/0 here never actually fires in production.
        input.allDay ? 1 : 0,
        input.startsAt ?? null,
        input.endsAt ?? null,
        input.eventTimezone ?? null,
        input.organizerEmail ?? null,
        input.selfResponse ?? null,
        input.externalAttendeeCount ?? 0,
        input.externalAttendeesJson ?? null,
        input.attendeesOmitted ? 1 : 0,
        input.prospectId ?? null,
        input.suggestedProspectId ?? null,
        input.matchStatus ?? null,
        input.matchMethod ?? null,
        input.matchConfidence ?? null,
        input.eventUpdatedAt ?? null,
        input.attendeesFingerprint ?? null,
      );
    return { isNew, fingerprintChanged };
  }

  getMeeting(calendarId: string, eventId: string): MeetingRecord | null {
    return (
      (this.db
        .query(`SELECT * FROM meetings WHERE calendar_id = ? AND event_id = ?`)
        .get(calendarId, eventId) as MeetingRecord) ?? null
    );
  }

  /**
   * The fast path for an unchanged event (`event_updated_at` hasn't
   * advanced since last poll): touch `last_seen_at` only, skip re-deriving
   * anything else. Returns false (no-op) if the row doesn't exist.
   */
  touchMeetingLastSeen(calendarId: string, eventId: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE meetings SET last_seen_at = datetime('now') WHERE calendar_id = ? AND event_id = ?`,
      )
      .run(calendarId, eventId);
    return res.changes > 0;
  }

  /**
   * Every prospect's (id, name, email, company), for the calendar matcher's
   * fuzzy domain/name signals — there's no `company_domain` column, so the
   * matcher derives a domain from `email` and slug-compares `company`
   * against it in JS. A full scan is fine at founder scale (same precedent
   * `resolveProspectForLinkedInReply` already relies on).
   */
  listProspectsForFuzzyMatch(): Array<{
    id: number;
    name: string | null;
    email: string | null;
    company: string | null;
  }> {
    return this.db
      .query(`SELECT id, name, email, company FROM prospects WHERE email IS NOT NULL`)
      .all() as Array<{
      id: number;
      name: string | null;
      email: string | null;
      company: string | null;
    }>;
  }

  /**
   * Whether `prospectId` has any outreach history (sequence_events) — the
   * calendar matcher's tie-break when two prospects share an exact-match
   * email account: the one with outreach history wins; only when NEITHER
   * has history is the match `ambiguous`.
   */
  hasOutreachHistory(prospectId: number): boolean {
    return (
      this.db
        .query(`SELECT 1 FROM sequence_events WHERE prospect_id = ? LIMIT 1`)
        .get(prospectId) != null
    );
  }

  /** Most recent sequence_events timestamp for a prospect, or null with no history. Tie-break helper alongside `hasOutreachHistory`. */
  lastOutreachAt(prospectId: number): string | null {
    const row = this.db
      .query(`SELECT MAX(created_at) AS at FROM sequence_events WHERE prospect_id = ?`)
      .get(prospectId) as { at: string | null } | undefined;
    return row?.at ?? null;
  }

  /**
   * Past meetings linked to a prospect with no recorded outcome yet — the
   * /inbox-style "awaiting" list. Grace period so a call that ran long
   * isn't nagged about the instant it crosses `ends_at`. Declined-by-founder
   * and all-day rows are excluded: a self-block or an all-day conference is
   * not a call, and COALESCE(self_response,'accepted') reads a NULL
   * response (never triaged, or an old row) as accepted rather than
   * silently dropping it from the nudge.
   */
  listPendingOutcomeMeetings(): MeetingRecord[] {
    return this.db
      .query(
        `SELECT * FROM meetings
         WHERE outcome IS NULL AND status = 'confirmed' AND all_day = 0
           AND prospect_id IS NOT NULL
           AND COALESCE(self_response, 'accepted') <> 'declined'
           AND ends_at < datetime('now', '-30 minutes')
         ORDER BY ends_at DESC`,
      )
      .all() as MeetingRecord[];
  }

  /** Founder-facing review queue: events with a fuzzy suggestion or an ambiguous multi-candidate match, unresolved. */
  listMeetingsForReview(): MeetingRecord[] {
    return this.db
      .query(
        `SELECT * FROM meetings
         WHERE match_status IN ('suggested', 'ambiguous')
         ORDER BY starts_at DESC`,
      )
      .all() as MeetingRecord[];
  }

  /** Record a founder-set outcome. Clears outcome_prompted_at is NOT done here — the row is resolved, not withdrawn. */
  setMeetingOutcome(input: {
    calendarId: string;
    eventId: string;
    outcome: MeetingOutcome;
    note?: string | null;
  }): void {
    this.db
      .prepare(
        `UPDATE meetings
         SET outcome = ?, outcome_note = ?, outcome_recorded_at = datetime('now')
         WHERE calendar_id = ? AND event_id = ?`,
      )
      .run(input.outcome, input.note ?? null, input.calendarId, input.eventId);
  }

  /**
   * The most recent founder-recorded outcome for a prospect's calendar
   * meeting(s) (issue #578) — modelled on `contactSuppressionFor`, a ledger
   * read returning a verdict for the reply drafter and cadence gate to act
   * on. This is the DIRECT path from an outcome into a draft: the existing
   * `tagOutcomeValue` → `triggerAngleRefresh` → `prospects.angle_json` path
   * never hands the outcome to the synthesizer as text, so this is a second
   * read, not a replacement. Newest by `outcome_recorded_at` wins when a
   * prospect has more than one resolved meeting.
   */
  latestMeetingOutcomeFor(
    prospectId: number,
  ): { outcome: MeetingOutcome; note: string | null; summary: string | null } | null {
    return (
      (this.db
        .query(
          `SELECT outcome, outcome_note AS note, summary
           FROM meetings
           WHERE prospect_id = ? AND outcome IS NOT NULL
           ORDER BY outcome_recorded_at DESC, starts_at DESC
           LIMIT 1`,
        )
        .get(prospectId) as
        | { outcome: MeetingOutcome; note: string | null; summary: string | null }
        | undefined) ?? null
    );
  }

  /**
   * Stamp `outcome_prompted_at` — called when the founder is shown the
   * nudge for this meeting, so a UI that dedupes reminders doesn't have to
   * infer "already asked" from anything else. `upsertMeeting`'s reschedule
   * branch clears this back to NULL when `starts_at` genuinely changes, so
   * a stale nudge withdraws on its own.
   */
  markMeetingPrompted(calendarId: string, eventId: string): void {
    this.db
      .prepare(
        `UPDATE meetings SET outcome_prompted_at = datetime('now') WHERE calendar_id = ? AND event_id = ?`,
      )
      .run(calendarId, eventId);
  }

  /**
   * Founder confirms a suggested/ambiguous match — promotes it to prospect_id
   * and marks match_status 'exact' so it stops appearing in the review queue
   * (it's still surfaced via prospect_id everywhere else).
   */
  confirmMeetingMatch(calendarId: string, eventId: string, prospectId: number): void {
    this.db
      .prepare(
        `UPDATE meetings
         SET prospect_id = ?, match_status = 'exact', suggested_prospect_id = NULL
         WHERE calendar_id = ? AND event_id = ?`,
      )
      .run(prospectId, calendarId, eventId);
  }

  /**
   * Founder dismisses a suggestion. match_status flips to 'dismissed', which
   * the matcher (packages/plays' calendar poll) must treat as "do not
   * re-suggest" UNTIL `attendees_fingerprint` changes — that's the whole
   * point of storing the fingerprint.
   */
  dismissMeetingMatch(calendarId: string, eventId: string): void {
    this.db
      .prepare(
        `UPDATE meetings
         SET match_status = 'dismissed', suggested_prospect_id = NULL
         WHERE calendar_id = ? AND event_id = ?`,
      )
      .run(calendarId, eventId);
  }

  /** Atomically consume a signed webhook replay key. */
  consumeWebhookReplay(replayKey: string, expiresAt: number, now: number): boolean {
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM webhook_replays WHERE expires_at < ?").run(now);
      const result = this.db
        .prepare("INSERT OR IGNORE INTO webhook_replays(replay_key, expires_at) VALUES(?, ?)")
        .run(replayKey, expiresAt);
      return result.changes > 0;
    })();
  }

  /** Test helper for isolating webhook verification cases. */
  clearWebhookReplays(): void {
    this.db.exec("DELETE FROM webhook_replays");
  }

  /**
   * Release a previously-consumed replay key. Used when a webhook was
   * verified but downstream processing (ICP filtering, enqueueing) failed
   * before a success response was sent, so the provider's retry of the same
   * signed payload isn't rejected as a replay.
   */
  releaseWebhookReplay(replayKey: string): void {
    this.db.prepare("DELETE FROM webhook_replays WHERE replay_key = ?").run(replayKey);
  }
}

let singleton: Ledger | null = null;

export function getLedger(): Ledger {
  if (!singleton) singleton = new Ledger();
  return singleton;
}
