import { getLedger, hasDossierSignal, parallelMap } from "@oneshot-gtm/core";
import {
  applyPersonResearchToProspect,
  isCircuitOpen,
  isResearchableUrl,
  personSeedForProspect,
  researchPerson,
  researchUrl,
} from "@oneshot-gtm/find";
import { c, header, note, ok, warn } from "../output.ts";

// Re-exported for existing test/call-site imports; the real implementation
// now lives in packages/find/src/_profile-url.ts so packages/find/src/angle.ts
// (issue #355 evidence gather) can reuse the same profile-preference logic
// instead of re-deriving it and reintroducing the luma.com-over-LinkedIn bug.
export { isResearchableUrl, researchUrl };

/**
 * Backfill research dossiers onto existing prospects.
 *
 * `prospects.dossier_json` is READ as free Tier-1 context when drafting a reply
 * (apps/server/src/api/_reply-research.ts) but nothing in production ever wrote
 * it — so every reply draft fell through to paid enrich + webRead, and the
 * research the finders already bought was computed and discarded. This fills
 * the column so that work is done once and reused.
 *
 * Since 2026-09-11 it writes the same record the post-finder person research
 * step writes on queue rows (`packages/find/src/_person-research.ts`): the
 * current role derived from the LinkedIn organisation history, facts about
 * the current employer, the `title` / `company` columns corrected when they
 * were stale, and the person gate re-judged on those facts. A `reject` on a
 * prospect in cadence stops its follow-ups through the existing off-ICP gate.
 *
 * Sibling of `enrich-linkedin`: same shape (dry-runnable, bounded
 * concurrency, breaker-aware), different call. Concurrency defaults lower
 * because deepResearchPerson runs minutes, not seconds. Uncapped by default;
 * `--max-cost-usd` bounds a rehearsal.
 */

const RESEARCH_COST_USD = 0.05;
/** Matches the slice the finders already use for a queued dossier. */
const DOSSIER_SLICE = 6000;

export type ResearchScope = "active" | "replied" | "unjudged" | "all";
const SCOPES: ResearchScope[] = ["active", "replied", "unjudged", "all"];

export interface ResearchProspectsOpts {
  dryRun: boolean;
  limit?: number;
  concurrency?: number;
  /** Re-research rows that already hold a dossier. */
  refresh: boolean;
  scope?: string;
  /** Research exactly this prospect, ignoring scope and dossier state. */
  id?: number;
  /** Hard ceiling on billed spend for this run. Stops cleanly when reached. */
  maxCostUsd?: number;
  /** Skip the person-gate re-judge. */
  noRejudge?: boolean;
  /** Skip the company lookup for the current employer. */
  noCompany?: boolean;
}

/**
 * Parse `--scope`. Unknown names are rejected rather than ignored: silently
 * dropping a typo'd scope would change which rows a PAID run touches.
 */
export function parseScopes(raw: string | undefined): ResearchScope[] {
  if (!raw || raw.trim() === "") return ["active", "replied", "unjudged"];
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  const bad = parts.filter((s) => !SCOPES.includes(s as ResearchScope));
  if (bad.length > 0) {
    throw new Error(`unknown --scope value(s): ${bad.join(", ")}. Valid: ${SCOPES.join(", ")}`);
  }
  return [...new Set(parts)] as ResearchScope[];
}

/**
 * How many rows this run may research, or undefined for "no cap". Mirrors
 * enrich-linkedin's resolveCap: a bad `--limit` must never WIDEN a paid run,
 * so NaN collapses to 0 rather than to the whole ledger.
 */
export function resolveCap(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit)) return 0;
  return Math.max(0, Math.floor(limit));
}

/**
 * True when the payload carries something worth persisting. Delegates to the
 * shared gate so this command and the play send-path agree on what counts —
 * they write the same column, and _reply-research.ts reads any non-empty value
 * as a free Tier-1 hit that suppresses paid research.
 */
export function hasSignal(payload: unknown): boolean {
  return hasDossierSignal(payload);
}

/**
 * Cap the person payload at `DOSSIER_SLICE`. An oversized payload degrades to
 * its own sliced JSON text, which `hasDossierSignal` reads as prose (it
 * explicitly treats truncated dossier JSON as context worth keeping) — so the
 * bound never costs us the research, and the wrapper around it stays parseable.
 */
export function bounded(payload: unknown): unknown {
  const text = JSON.stringify(payload, null, 2);
  if (typeof text !== "string") return payload;
  return text.length <= DOSSIER_SLICE ? payload : text.slice(0, DOSSIER_SLICE);
}

export async function commandResearchProspects(opts: ResearchProspectsOpts): Promise<void> {
  header(`research-prospects ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const ledger = getLedger();
  const scopes = parseScopes(opts.scope);

  // Read the backlog, then cap in memory — same reasoning as enrich-linkedin:
  // pushing --limit into SQL would make it mean "consider N" not "research N".
  // `--id` researches one named prospect regardless of scope or dossier state.
  // Diagnosing a single bad row was otherwise impossible: the scopes are broad
  // and `--refresh` would re-buy the whole backlog to reach one prospect.
  const rows = opts.id
    ? ledger
        .listProspectsForResearch({ scopes: ["all"], includeResearched: true, limit: 100_000 })
        .filter((row) => row.id === opts.id)
    : ledger.listProspectsForResearch({
        scopes,
        includeResearched: opts.refresh,
        limit: 100_000,
      });
  if (opts.id && rows.length === 0) {
    warn(`prospect ${opts.id} not found, or has no email and no profile URL to research.`);
    return;
  }
  // deepResearchPerson builds a person from a social profile. Handed only an
  // email it fails — deterministically, not transiently: a 536-row backfill
  // produced 281 failures, and re-running produced exactly 281 again, each
  // spending minutes of wall clock to arrive at the same nothing. Skip those
  // rows here rather than paying the latency to rediscover it one at a time.
  // `--id` is exempt: an explicit request should try whatever it has.
  const skipped = opts.id ? [] : rows.filter((row) => !isResearchableUrl(researchUrl(row)));
  const eligible = opts.id ? rows : rows.filter((row) => isResearchableUrl(researchUrl(row)));
  const cap = resolveCap(opts.limit);
  const candidates = cap === undefined ? eligible : eligible.slice(0, cap);

  process.stdout.write(
    `${c.dim("scope:")} ${scopes.join(",")}` +
      `  ${c.dim("without a dossier:")} ${rows.length}` +
      (skipped.length > 0 ? `  ${c.dim("no profile URL:")} ${skipped.length}` : "") +
      `  ${c.dim("to research:")} ${candidates.length}` +
      (cap !== undefined && eligible.length > candidates.length
        ? `  ${c.dim("held back by --limit:")} ${eligible.length - candidates.length}`
        : "") +
      `\n${c.dim("Est. cost:")} ~$${(candidates.length * RESEARCH_COST_USD).toFixed(2)}` +
      `  ${c.dim("(~2-5 min each, cached 90d)")}\n\n`,
  );

  if (candidates.length === 0) {
    note("Nothing to research.");
    return;
  }

  if (opts.dryRun) {
    for (const r of candidates.slice(0, 30)) {
      process.stdout.write(
        `  ${c.dim("·")} ${(r.name ?? "").slice(0, 26).padEnd(28)} ` +
          `${c.dim(researchUrl(r) ?? r.email ?? "")}\n`,
      );
    }
    if (candidates.length > 30) note(`… and ${candidates.length - 30} more`);
    process.stdout.write("\n");
    ok("dry run — nothing researched, nothing written.");
    return;
  }

  let costUsd = 0;
  let written = 0;
  let empty = 0;
  let failed = 0;
  let cached = 0;
  let titleUpdated = 0;
  let pass = 0;
  let reject = 0;
  let haltedAt: number | null = null;

  let cappedAt: number | null = null;
  await parallelMap(candidates, opts.concurrency ?? 3, async (row, index) => {
    // The wrapper is failure-safe on its own, but bailing here avoids walking
    // hundreds of rows during an outage just to no-op each one.
    if (isCircuitOpen()) {
      haltedAt ??= index;
      return;
    }
    // Spend ceiling. Checked before the call, so the cap can be exceeded by at
    // most (concurrency - 1) in-flight calls — the same accounting the finders
    // use for `maxCostUsd`. A backfill across the whole ledger is the one place
    // a typo'd flag could bill three figures.
    if (opts.maxCostUsd != null && costUsd >= opts.maxCostUsd) {
      cappedAt ??= index;
      return;
    }
    const url = researchUrl(row);
    const email = row.email?.trim();
    // The row from the backlog query lacks the columns the derivation
    // compares against (title, verdict); read the live prospect for them.
    const prospect = ledger.getProspectById(row.id);
    const seed = personSeedForProspect({
      ...row,
      ...(prospect?.title !== undefined ? { title: prospect.title } : {}),
      ...(prospect?.icp_verdict !== undefined ? { icp_verdict: prospect.icp_verdict } : {}),
    });
    const remainingUsd =
      opts.maxCostUsd != null ? Math.max(0, opts.maxCostUsd - costUsd) : Number.POSITIVE_INFINITY;
    // Same cache key as before (`person:<url>`), so a prospect researched by
    // the older code, the angle gather or the queue backfill is a free hit.
    const researched = await researchPerson({
      seed,
      playName: "research-prospects",
      subject: { prospectId: row.id },
      remainingUsd,
      enrichCompany: !opts.noCompany,
    });
    costUsd += researched.costUsd;
    if (researched.dossier.status === "unavailable") {
      if (/failed/.test(researched.dossier.warning ?? "")) failed++;
      else empty++;
      return;
    }
    // Counted only for calls that returned real data, so `cached` and `failed`
    // stay mutually exclusive (a negative-cache hit is a failure, not a saving).
    if (researched.cached) cached++;
    // Merge, never replace: `research-products` owns the `product` half of the
    // same column and the two commands run independently; the earlier enrich
    // record is kept under `enrichment`. The merge re-reads inside a write
    // transaction rather than reusing `row.dossier_json`, which was read when
    // the backlog was selected — minutes earlier. The PERSON half is bounded
    // (DOSSIER_SLICE) before merging: truncating the wrapper would make it
    // invalid JSON and take the product half down with it.
    const applied = await applyPersonResearchToProspect(
      ledger,
      {
        ...row,
        ...(prospect?.title !== undefined ? { title: prospect.title } : {}),
        ...(prospect?.icp_verdict !== undefined ? { icp_verdict: prospect.icp_verdict } : {}),
      },
      researched.dossier,
      { rejudge: !opts.noRejudge, dossierSlice: DOSSIER_SLICE, playName: "research-prospects" },
    );
    if (applied.outcome !== "written") {
      empty++;
      return;
    }
    written++;
    if (applied.roleChanged) titleUpdated++;
    if (applied.verdict === "pass") pass++;
    if (applied.verdict === "reject") reject++;
    process.stdout.write(
      `  ${c.green("→")} ${(row.name ?? "").slice(0, 26).padEnd(28)} ${c.dim(url ?? email ?? "")}` +
        (applied.verdict ? `  ${c.dim(`verdict: ${applied.verdict}`)}` : "") +
        `\n`,
    );
  });

  process.stdout.write("\n");
  if (cappedAt !== null) {
    warn(
      `Stopped at the $${opts.maxCostUsd?.toFixed(2)} ceiling after ~${cappedAt} rows. ` +
        `Re-run to continue — researched rows are skipped.`,
    );
  }
  if (haltedAt !== null) {
    warn(
      `Circuit breaker opened after ~${haltedAt} rows — the research backend is failing. ` +
        `Re-run to pick up where this left off.`,
    );
  }
  ok(
    `researched ${written}  ${c.dim("no signal:")} ${empty}  ${c.dim("failed:")} ${failed}  ` +
      `${c.dim("free (cached):")} ${cached}  ${c.dim("title updated:")} ${titleUpdated}  ` +
      `${c.dim("re-judged pass:")} ${pass}  ${c.dim("re-judged reject:")} ${reject}  ` +
      `${c.dim("spent:")} $${costUsd.toFixed(2)}`,
  );
}
