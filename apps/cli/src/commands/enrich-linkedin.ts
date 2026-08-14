import { getLedger, parallelMap } from "@oneshot-gtm/core";
import { findLinkedInUrl, isCircuitOpen, looksLikeOrgName } from "@oneshot-gtm/find";
import { c, header, note, ok, warn } from "../output.ts";

/**
 * Backfill LinkedIn URLs onto prospects that were emailed before the finders
 * captured them.
 *
 * Why this exists: `upsertProspect` is insert-or-return-existing, so a prospect
 * created without a LinkedIn URL could never acquire one — the finder fixes
 * only help people found from now on. This walks the existing rows and fills
 * the gap via the same `findLinkedInUrl` resolver the finders use, so results
 * are cached and billed identically.
 */

export interface EnrichLinkedInOpts {
  dryRun: boolean;
  limit?: number;
  play?: string;
  /** Skip names that don't look like a real person (handles, single tokens). */
  skipHandles: boolean;
  concurrency?: number;
}

/**
 * True when a name looks like something a LinkedIn profile search could match.
 *
 * GitHub display names are frequently handles (`yijin840`), single tokens
 * (`Demin`) or non-Latin (`麦奇`). Searching those burns ~$0.01 for a
 * near-certain miss — roughly 90 of the 317 unresolved repo-interest rows.
 * Requires two Latin-script tokens.
 */
export function looksLikeRealName(name: string | null | undefined): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.length < 3) return false;
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length < 2) return false;
  // At least one token has to carry real signal. "A B" is two valid tokens but
  // searching bare initials is indistinguishable from noise.
  if (!tokens.some((t) => t.length >= 2)) return false;
  // Every token must start with a Latin letter — filters CJK/emoji handles that
  // happen to contain a space.
  return tokens.every((t) => /^[A-Za-z][A-Za-z.'-]*$/.test(t));
}

/**
 * Turn a stored `company` into a search token, or null if it isn't usable.
 *
 * Each disambiguator becomes a *quoted* token in the query, so it's an exact
 * phrase requirement. A GitHub `company` field is free text — "Co-Founder/CTO @
 * Floramis | Product @ Vilota", "Open to Work 😎", "Software Enginneer at
 * @iFood" — and requiring any of those verbatim guarantees zero results, i.e. a
 * paid call that could never have hit. Take the first company-looking segment
 * and drop anything still too free-form to be a company name.
 */
export function cleanCompanyToken(company: string | null | undefined): string | null {
  if (!company) return null;
  let s = company.trim();
  if (s === "" || s === "(unknown)") return null;
  // "Co-Founder/CTO @ Floramis | Product @ Vilota" → first segment only.
  const firstSegment = s.split(/[|,;]/)[0];
  if (firstSegment === undefined) return null;
  s = firstSegment.trim();
  // "Software Enginneer at @iFood" / "Co-Founder/CTO @ Floramis" → the employer
  // is whatever follows the "at"/"@" marker.
  const employer = /(?:\bat\b|@)\s*@?\s*(.+)$/i.exec(s);
  if (employer?.[1]) s = employer[1].trim();
  s = s.replace(/^@+/, "").trim();
  // Trailing parenthetical (a URL, usually).
  s = s.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (s.length < 2) return null;
  // Anything outside the character set a company name actually uses — emoji,
  // CJK, a stray sigil — means this is a bio line, not an employer.
  if (!/^[A-Za-z0-9 .,&'/-]+$/.test(s)) return null;
  s = s.replace(/[.,]+$/, "").trim();
  // Still a sentence rather than a name → not a usable exact-match constraint.
  if (s.split(/\s+/).length > 4) return null;
  return s.length >= 2 ? s : null;
}

export async function commandEnrichLinkedIn(opts: EnrichLinkedInOpts): Promise<void> {
  header(`enrich-linkedin ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const ledger = getLedger();

  // Read the whole backlog, then cap. Pushing `--limit` into the query would
  // make it mean "consider N rows" rather than "search N" — with
  // `--skip-handles` a `--limit 5` would then search however many of the first
  // five rows happened to be real names.
  const rows = ledger.listProspectsMissingLinkedIn({
    limit: 100_000,
    ...(opts.play ? { play: opts.play } : {}),
  });

  // Org rows are dropped regardless of --skip-handles: searching one always
  // "succeeds" and always writes the wrong person.
  const orgs = rows.filter((r) => looksLikeOrgName(r.name));
  const people = rows.filter((r) => !looksLikeOrgName(r.name));
  const skipped = opts.skipHandles ? people.filter((r) => !looksLikeRealName(r.name)) : [];
  const searchable = opts.skipHandles ? people.filter((r) => looksLikeRealName(r.name)) : people;
  const candidates = opts.limit ? searchable.slice(0, opts.limit) : searchable;

  process.stdout.write(
    `${c.dim("Missing LinkedIn:")} ${rows.length}` +
      `  ${c.dim("to search:")} ${candidates.length}` +
      (orgs.length > 0 ? `  ${c.dim("skipped (org):")} ${orgs.length}` : "") +
      (opts.skipHandles ? `  ${c.dim("skipped (handle-like):")} ${skipped.length}` : "") +
      (opts.limit && searchable.length > candidates.length
        ? `  ${c.dim("held back by --limit:")} ${searchable.length - candidates.length}`
        : "") +
      `\n${c.dim("Est. cost:")} ~$${(candidates.length * 0.01).toFixed(2)}\n\n`,
  );

  if (candidates.length === 0) {
    note("Nothing to enrich.");
    return;
  }

  if (opts.dryRun) {
    for (const r of candidates.slice(0, 30)) {
      process.stdout.write(
        `  ${c.dim("·")} ${(r.name ?? "").slice(0, 28).padEnd(30)} ${c.dim(r.company ?? "")}\n`,
      );
    }
    if (candidates.length > 30) note(`… and ${candidates.length - 30} more`);
    process.stdout.write("\n");
    ok("dry run — nothing searched, nothing written.");
    return;
  }

  let costUsd = 0;
  let found = 0;
  let missed = 0;
  let written = 0;
  let rejected = 0;
  let haltedAt: number | null = null;

  await parallelMap(candidates, opts.concurrency ?? 4, async (row, index) => {
    // The resolver checks the breaker itself, but bailing here too avoids
    // walking thousands of rows during an outage just to no-op each one.
    if (isCircuitOpen()) {
      haltedAt ??= index;
      return;
    }
    const company = cleanCompanyToken(row.company);
    const url = await findLinkedInUrl({
      fullName: row.name ?? "",
      disambiguators: company ? [company] : [],
      accumCost: (cost) => {
        costUsd += cost ?? 0;
      },
      errKindPrefix: "enrich-linkedin",
      onTitleMismatch: () => {
        rejected++;
      },
    });
    if (!url) {
      missed++;
      return;
    }
    found++;
    // COALESCE semantics — this can only fill an empty column, never clobber a
    // URL a finder already resolved.
    if (ledger.updateProspectIdentity(row.id, { linkedin_url: url })) {
      written++;
      process.stdout.write(
        `  ${c.green("→")} ${(row.name ?? "").slice(0, 28).padEnd(30)} ${url}\n`,
      );
    }
  });

  process.stdout.write("\n");
  if (haltedAt !== null) {
    warn(
      `Circuit breaker opened after ~${haltedAt} rows — the search backend is failing. ` +
        `Re-run later; cached results mean you won't pay twice.`,
    );
  }
  process.stdout.write(
    `${c.dim("Found:")} ${found}  ${c.dim("written:")} ${written}  ` +
      // Counts results, not candidates — one search can discard several before
      // finding the right person (or none).
      `${c.dim("no profile:")} ${missed}  ${c.dim("wrong-person results skipped:")} ${rejected}  ` +
      `${c.dim("spent:")} $${costUsd.toFixed(2)}\n\n`,
  );
  ok("done.");
}
