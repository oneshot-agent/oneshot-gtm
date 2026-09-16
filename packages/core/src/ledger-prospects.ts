import type { Database } from "bun:sqlite";
import type { PostalAddress } from "./direct-mail.ts";
import { hasPersonSignal, mergePersonDossier, mergeProductDossier } from "./dossier.ts";
import type { ProductResearchDossier } from "./dossier.ts";
import type { ProspectRecord } from "./types.ts";

/**
 * Prospect CRUD, research-backlog queries, dossier merge/update operations,
 * person/company facts, and stored ICP-verdict persistence — extracted from
 * `Ledger` (#643, re-filed from #632) as the next slice of the ledger split
 * tracked in ROADMAP.md, following the receipts (#616), cache (#618),
 * delivery-health (#617), inbox (#634), queue (#641) and cadence (#642)
 * extractions.
 *
 * Scope is deliberately narrow: only methods whose SQL touches the
 * `prospects` table alone (a bare `FROM prospects`/`WHERE`/correlated EXISTS
 * subquery, never a JOIN against cadence_state/sequence_events/inbox_replies/
 * channel_events/target_queue) live here. Cross-domain prospect queries —
 * `listActiveCadences`, `listColdProspects`, `listRepliedProspectEmails`,
 * `recordLinkedInReply`, everything keyed by target_queue — stay in
 * `ledger.ts`.
 *
 * The shared-people cross-workspace identity resolution (`SharedPeople`,
 * `bindSharedPerson`/`withSharedIdentity`/`refreshSharedPeople`) also stays
 * in `Ledger`: it needs the `Ledger` instance's own `path` and `people`
 * fields, which are unrelated to raw SQL against `prospects`. `Ledger`'s
 * `findProspectByEmail`, `getProspectById` and `upsertProspect` wrap the
 * shared-identity resolution around the plain SQL calls below.
 *
 * Pure wrapper around a raw `Database` handle plus the minimal mail-address
 * accessor `getProspectById`/`upsertProspect` need for the `businessAddress`
 * fields — mirroring `ledger-cache.ts`'s and `ledger-receipts.ts`'s shape so
 * this domain can be constructed and exercised without the rest of Ledger's
 * surface. `Ledger` owns exactly one instance (constructed after `migrate()`
 * runs) and delegates every prospect method to it, preserving each method's
 * existing signature, return value, null handling, ordering and transaction
 * boundary — an observer of the public surface sees no difference.
 */
export interface ProspectMailAddress {
  get(key: string): PostalAddress | null;
  set(key: string, address: PostalAddress, source?: string): void;
  getMetadata(key: string): Record<string, unknown> | null;
}

/**
 * Canonical form for matching prospect emails — trim + lowercase. Inbound reply
 * addresses (cadence inbox poll) are normalized the same way, so a prospect
 * stored from a mixed-case address still matches when they reply. Applied on
 * both store (upsertProspect) and every lookup so the two never diverge.
 *
 * Duplicated (not imported/exported across the module boundary) rather than
 * shared with `ledger.ts`'s own copy — mirrors the precedent already set by
 * `delivery-health.ts`'s `canonEmail`: a 3-line pure helper, and re-exporting
 * it from either module would widen that module's public surface for no
 * benefit. Every call site keeps behaving identically either way.
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

/**
 * The identity columns `Ledger.refreshSharedPeople`/`bindSharedPerson`
 * backfill from a resolved shared person. Kept as its own union (not
 * imported from `shared-people.ts`) so this module's SQL surface stays
 * self-contained; `Ledger` picks the fields off its own `SharedPerson`
 * value, which is a structural superset.
 */
export type ProspectSharedIdentityField =
  | "name"
  | "email"
  | "phone"
  | "company"
  | "linkedin_url"
  | "title";

export class ProspectStore {
  constructor(
    private readonly db: Database,
    private readonly mailAddress: ProspectMailAddress,
  ) {}

  findProspectByEmail(email: string): { id: number } | null {
    return (
      (this.db.query("SELECT id FROM prospects WHERE email = ?").get(canonEmail(email)) as {
        id: number;
      }) ?? null
    );
  }

  /**
   * `Ledger.findProspectByEmail`'s shared-person fallback — the same SQL
   * shape as `findExistingForUpsert`'s shared_person_id branch, kept as its
   * own method since it's keyed by a resolved shared-person id, not an email.
   */
  findProspectBySharedPersonId(personId: string): { id: number } | null {
    return (
      (this.db
        .query("SELECT id FROM prospects WHERE shared_person_id=? ORDER BY id LIMIT 1")
        .get(personId) as { id: number }) ?? null
    );
  }

  /** Full prospect record by any verified email alias of the shared person. */
  getProspectByEmail(email: string): ProspectRecord | null {
    return (
      (this.db
        .query("SELECT * FROM prospects WHERE email = ?")
        .get(canonEmail(email)) as ProspectRecord) ?? null
    );
  }

  /**
   * The LinkedIn-URL half of `Ledger.resolveProspectForLinkedInReply`'s
   * matching: prospect ids whose `linkedin_url`/`source_profile_url` resolve
   * to the same canonical LinkedIn profile key. The email half needs
   * `Ledger`'s shared-identity-aware `findProspectByEmail`, so the caller
   * (`Ledger.resolveProspectForLinkedInReply`) combines this with its own
   * email lookup rather than this store re-deriving it.
   */
  resolveProspectForLinkedInReply(
    input: { email?: string; linkedinUrl?: string },
    emailId: number | null,
  ): { status: "matched"; prospectId: number } | { status: "unmatched" } | { status: "conflict" } {
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

  /**
   * Raw prospect row by id (PK seek) — no mail address, no shared-identity
   * resolution. `Ledger.getProspectById` wraps this with `withSharedIdentity`
   * then `attachMailAddress`.
   */
  getProspectRow(id: number): ProspectRecord | null {
    return this.db.query("SELECT * FROM prospects WHERE id = ?").get(id) as ProspectRecord | null;
  }

  /**
   * Every prospect row, unfiltered — `Ledger.refreshSharedPeople`'s backfill
   * sweep needs to walk the whole table once per shared-people version bump.
   * Read OUTSIDE any transaction, matching the original inline call: the
   * sweep itself (each row's resolve + write) is what needs the write lock,
   * not this initial snapshot.
   */
  listAllProspects(): ProspectRecord[] {
    return this.db.query("SELECT * FROM prospects").all() as ProspectRecord[];
  }

  /**
   * True when some OTHER prospect already holds `email` — the guard
   * `Ledger.refreshSharedPeople` checks before backfilling a shared person's
   * email onto a row, so two legacy aliases with distinct historical IDs
   * that happen to resolve to the same shared person never collide on
   * `prospects.email`'s implicit uniqueness.
   */
  hasOtherProspectWithEmail(email: string, excludingId: number): boolean {
    return (
      this.db.query("SELECT id FROM prospects WHERE email=? AND id<>?").get(email, excludingId) !=
      null
    );
  }

  /**
   * Backfill one shared-identity column onto a prospect row.
   * `Ledger.refreshSharedPeople` calls this per changed field, inside its own
   * `db.transaction(...).immediate()` — this method issues a single bound
   * UPDATE and does not open its own transaction, so the caller's lock
   * boundary is unaffected.
   */
  setSharedIdentityField(
    id: number,
    field: ProspectSharedIdentityField,
    value: string | null,
  ): void {
    this.db.query(`UPDATE prospects SET ${field}=? WHERE id=?`).run(value, id);
  }

  /**
   * Link a prospect row to its resolved shared person. The `IS NOT ?` guard
   * makes the write a no-op when the row already points at this person —
   * `Ledger.bindSharedPerson` relies on that to avoid a WAL write (and a
   * `peopleVersion` bump upstream) for rows that are already correct.
   */
  setProspectSharedPersonId(id: number, personId: string): void {
    this.db
      .query("UPDATE prospects SET shared_person_id=? WHERE id=? AND shared_person_id IS NOT ?")
      .run(personId, id, personId);
  }

  /**
   * `getProspectRow` + `attachMailAddress`, no shared-identity resolution.
   * `Ledger.getProspectById` doesn't call this — it needs `withSharedIdentity`
   * in between the two steps — but the pair is useful together for
   * exercising `ProspectStore` standalone (no `Ledger`), same reason
   * `upsertProspect` exists on this store.
   */
  getProspectById(id: number): ProspectRecord | null {
    return this.attachMailAddress(this.getProspectRow(id), id);
  }

  /** Merge the stored business mail address (if any) onto a prospect record. */
  attachMailAddress(prospect: ProspectRecord | null, id: number): ProspectRecord | null {
    return this.withMailAddress(prospect, id);
  }

  private withMailAddress(prospect: ProspectRecord | null, id: number): ProspectRecord | null {
    const address = prospect && this.mailAddress.get(`prospect:${id}`);
    return prospect
      ? {
          ...prospect,
          ...(address
            ? {
                businessAddress: address,
                businessAddressSource: String(
                  this.mailAddress.getMetadata(`prospect:${id}`)?.source ?? "saved address",
                ),
              }
            : {}),
        }
      : null;
  }

  /**
   * Lookup an existing prospect by shared_person_id or email, for the
   * shared-identity resolution in `Ledger.upsertProspect`. Returns the row id
   * only — `Ledger` handles the business-address seeding and shared-person
   * binding around it.
   */
  findExistingForUpsert(
    sharedPersonId: string | null | undefined,
    email: string | null | undefined,
  ): { id: number } | null {
    if (sharedPersonId) {
      const membership = this.db
        .query("SELECT id FROM prospects WHERE shared_person_id=? ORDER BY id LIMIT 1")
        .get(sharedPersonId) as { id: number } | null;
      if (membership) return membership;
    }
    if (email) {
      const canon = canonEmail(email);
      const existing = this.db.query("SELECT id FROM prospects WHERE email = ?").get(canon) as
        | { id: number }
        | undefined;
      if (existing) return existing;
    }
    return null;
  }

  /**
   * Plain INSERT of a new prospect row — no shared-identity resolution, no
   * existing-row lookup (the caller, `Ledger.upsertProspectInTransaction`,
   * already checked via `findExistingForUpsert`). Business-address seeding
   * also stays with the caller, which needs the freshly-inserted id first.
   */
  insertProspect(input: Partial<ProspectRecord> & { email?: string | null }): number {
    const email = input.email ? canonEmail(input.email) : null;
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
    return Number(result.lastInsertRowid);
  }

  /**
   * Plain upsert with no shared-identity resolution — the composition of
   * `findExistingForUpsert` + `insertProspect` + `seedBusinessAddress` that
   * `Ledger.upsertProspectInTransaction` performs around the shared-person
   * merge. Exposed on the store itself (not just as private plumbing) so
   * `ProspectStore` remains exercisable standalone, without constructing a
   * `Ledger` — same precedent as `ledger-receipts.ts`'s "pure function of a
   * raw Database handle" tests. `Ledger.upsertProspect` does NOT call this;
   * it has its own transaction wrapping the shared-identity resolution.
   */
  upsertProspect(input: Partial<ProspectRecord> & { email?: string | null }): number {
    return this.db
      .transaction(() => {
        const existing = this.findExistingForUpsert(input.shared_person_id, input.email);
        if (existing) {
          this.seedBusinessAddress(existing.id, input.businessAddress, input.businessAddressSource);
          return existing.id;
        }
        const id = this.insertProspect(input);
        this.seedBusinessAddress(id, input.businessAddress, input.businessAddressSource);
        return id;
      })
      .immediate();
  }

  /** Seed a prospect's business mail address if it isn't set yet — best-effort helper for upsertProspect callers. */
  seedBusinessAddress(
    id: number,
    address: PostalAddress | null | undefined,
    source: string | undefined,
  ): void {
    if (!address) return;
    if (this.mailAddress.get(`prospect:${id}`)) return;
    this.mailAddress.set(`prospect:${id}`, address, source ?? "prospect input");
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
   * Correct a prospect's current role from research. `updateProspectIdentity`
   * is write-once by design (COALESCE), which is right for identity fields
   * captured at finder time but wrong for a title the LinkedIn history says
   * has changed since. Plain overwrite of the given keys only; the finder's
   * originals live inside the dossier person record, not in new columns.
   */
  setProspectCurrentRole(id: number, patch: { title?: string; company?: string }): boolean {
    const set: string[] = [];
    const args: Array<string | number> = [];
    for (const col of ["title", "company"] as const) {
      const value = patch[col];
      if (typeof value !== "string" || value.trim() === "") continue;
      set.push(`${col} = ?`);
      args.push(value.trim());
    }
    if (set.length === 0) return false;
    args.push(id);
    const result = this.db
      .prepare(`UPDATE prospects SET ${set.join(", ")} WHERE id = ?`)
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
   * `.immediate()` takes the write lock (`BEGIN IMMEDIATE`, a RESERVED lock)
   * BEFORE the re-read runs, not on the first write inside the transaction —
   * the default `db.transaction(...)()` call opens a DEFERRED transaction,
   * which only escalates to a write lock at the first write statement, so a
   * second writer's SELECT can still land in the gap between this
   * transaction's own SELECT and its UPDATE. `.immediate()` closes that gap:
   * once this call's SELECT runs, it already holds the write lock, so no
   * other connection's transaction can interleave a write until this one
   * commits. Same pattern as `ledger-queue.ts`'s `dequeueApproved` and
   * `ledger.ts`'s `reserveSpendIfUnderCeiling` (see `daily-spend.test.ts`'s
   * "cross-connection atomicity" tests) — proven the same way in
   * `ledger-prospects.test.ts`'s "two independent connections racing"
   * cases below, which open a SECOND real connection to the same on-disk
   * file rather than just calling the method twice on one connection.
   */
  mergeProspectDossierHalf(
    id: number,
    half: "person" | "product",
    value: unknown,
    slice?: number,
  ): void {
    this.db
      .transaction(() => {
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
      })
      .immediate();
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
}
