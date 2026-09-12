import type { Database } from "bun:sqlite";
import type { PostalAddress } from "./direct-mail.ts";
import { hasPersonSignal, mergePersonDossier, mergeProductDossier } from "./dossier.ts";
import type { ProductResearchDossier } from "./dossier.ts";
import type { ProspectRecord } from "./types.ts";

/**
 * Prospect CRUD, research-backlog queries, dossier merge/update operations,
 * and stored ICP-verdict persistence — extracted from `Ledger` (#632) as the
 * next slice of the ledger split tracked in ROADMAP.md, following the
 * receipts (#616), cache (#618) and delivery-health (#617) extractions.
 *
 * Scope is deliberately narrow: only methods whose SQL touches the
 * `prospects` table alone (a bare `FROM prospects`/`WHERE`/correlated EXISTS
 * subquery, never a JOIN against cadence_state/sequence_events/inbox_replies/
 * channel_events/target_queue) live here. Cross-domain prospect queries —
 * `listActiveCadences`, `listColdProspects`, `listRepliedProspectEmails`,
 * `recordLinkedInReply`, everything keyed by target_queue — stay in
 * `ledger.ts` for the cadence (#633) and queue (#631) slices.
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

  /** Full prospect record by id (PK seek). Avoids loading every prospect to find one. */
  getProspectById(id: number): ProspectRecord | null {
    const prospect = this.db
      .query("SELECT * FROM prospects WHERE id = ?")
      .get(id) as ProspectRecord | null;
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

  upsertProspect(input: Partial<ProspectRecord> & { email?: string | null }): number {
    // Store the canonical (lowercased) email so reply matching — which
    // normalizes the inbound from-address the same way — always lands.
    const email = input.email ? canonEmail(input.email) : null;
    if (email) {
      const existing = this.db.query("SELECT id FROM prospects WHERE email = ?").get(email) as
        | { id: number }
        | undefined;
      if (existing) {
        if (input.businessAddress && !this.mailAddress.get(`prospect:${existing.id}`))
          this.mailAddress.set(
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
      this.mailAddress.set(
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
