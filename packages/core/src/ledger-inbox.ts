import type { Database } from "bun:sqlite";
import type { ReplyKind } from "./reply-classify.ts";
import type { InboxReplyRecord } from "./types.ts";

/**
 * Inbound-message recording, conversation/thread reads, reply classification
 * state, archive/reopen operations, and inbox-specific transactions — the
 * inbox domain slice of the ledger split tracked in ROADMAP.md (issue #634,
 * the last named domain, following the receipt (#616), cache (#618), and
 * delivery-health (#617) extractions). Named `InboxStore` (like `LedgerCache`
 * and `ReceiptStore`) rather than a set of pure functions (like
 * `delivery-health.ts`) because several methods here call each other
 * (`recordInboxReply` → `restoreInboxConversation`,
 * `archiveInboxConversation` → `listInboxRepliesForProspect`) and a class
 * keeps those call sites as plain `this.` calls instead of threading `db`
 * through every helper.
 *
 * Covers `inbox_drafts` (single mutable draft per thread), `inbox_sent`
 * (append-only sent-reply history), `inbox_archives` (per-prospect
 * archive/reopen state), and `inbox_replies` (persisted inbound replies,
 * their deliverability `kind` and sentiment `intent` classifications, and
 * the triage claim marker). `Ledger`'s own upsertInboxDraft /
 * setInboxDraftSteer / setInboxDraftBody / clearInboxDraft / recordInboxSent
 * / getInboxThreads / listRepliedProspectEmails / listInboxArchives /
 * archiveInboxConversation / restoreInboxConversation / recordInboxReply /
 * setInboxReplyIntent / claimInboxReplyForTriage / sweepStaleInboxReplyTriage
 * / listInboxReplyIntents / listInboxRepliesForProspect / listInboxReplyIds /
 * listUntriagedHumanReplies / listProspectIdsWithReplies methods (ledger.ts)
 * are now thin delegates to the methods below — same names, same signatures,
 * same SQL — so every call site and the exported `Ledger` surface are
 * unchanged. Mailbox (Gmail/Smartlead IMAP) message storage lives separately
 * in `mailbox-store.ts`'s `MailboxStore`; this module owns only the
 * ledger-native inbox tables layered on top of it.
 */

/**
 * Canonical form for matching prospect/reply emails — trim + lowercase.
 * Mirrors `Ledger`'s own `canonEmail` (ledger.ts) so inbox replies stay keyed
 * identically to the rest of the ledger (prospects, bounces, sender
 * assignments). Duplicated rather than imported/exported across the module
 * boundary — same call this codebase already made for `delivery-health.ts`'s
 * copy: it's a 3-line pure helper, and re-exporting it from ledger.ts would
 * widen that file's public surface for no benefit.
 */
function canonEmail(email: string): string {
  return email.trim().toLowerCase();
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

export class InboxStore {
  constructor(private readonly db: Database) {}

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
   * #558): every other claim-marker in this ledger split (claimCadenceSendingMarker/
   * sweepStaleCadenceSends, claimQueueSendingMarker/sweepStaleQueueSends,
   * claimRunningTrigger/sweepStaleRunningTriggers, all ledger.ts) has a
   * paired sweep so a crash between the claim UPDATE and the try/catch's
   * release doesn't strand the marker forever. This one didn't: a process
   * death mid-triage left `intent = '__triage_pending__'` permanently on the
   * row — it could never be re-claimed (the claim UPDATE only matches
   * `intent IS NULL`) or classified again, and the non-`ReplyIntent` sentinel
   * was exposed to every reader of `intent` (`listInboxReplyIntents`, the
   * /inbox route). Unlike the other markers, the claim here has no
   * `started_at` column to age against — it's held only for the duration of
   * one in-process `await triageEmails(...)`, which cannot survive past that
   * process's death — so there's no `maxAgeMs`: cold boot (called once, like
   * the other sweeps, from apps/server/src/bin.ts) is the only moment a
   * stranded claim can be told apart from one a live process still holds.
   * Returns the number of rows reset so the caller can log it.
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
}
