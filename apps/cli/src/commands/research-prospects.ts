import { getLedger, hasDossierSignal, parallelMap, readPersonHalf } from "@oneshot-gtm/core";
import {
  applyPersonResearchToProspect,
  isCircuitOpen,
  isResearchableUrl,
  newsfeedSeedForProspect,
  personSeedForProspect,
  researchPerson,
  researchUrl,
} from "@oneshot-gtm/find";
import { c, header, note, ok, warn } from "../output.ts";
import { ROW_COST_ESTIMATE_USD } from "./research-queue.ts";
import {
  hasFreshPointer,
  newsfeedEstimateLine,
  type NewsfeedItem,
  reportNewsfeed,
  runNewsfeedPass,
} from "./_newsfeed-pass.ts";

// Keep existing imports compatible with the shared profile-selection helper.
export { isResearchableUrl, researchUrl };

/**
 * Backfill research dossiers onto existing prospects.
 *
 * Persist reusable reply context in `prospects.dossier_json` using the shared
 * person-research record: current LinkedIn role, employer facts, corrected
 * title/company, and a fresh person-gate verdict. Rejection stops cadence follow-ups.
 *
 * Supports dry runs, bounded concurrency, and the circuit breaker. Research can
 * take minutes, so concurrency is lower than enrich-linkedin. Spend is uncapped
 * unless `--max-cost-usd` is set.
 */

/** Person + company research per prospect, the same slice `research-queue` shows. */
const RESEARCH_COST_USD = ROW_COST_ESTIMATE_USD;
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
  /** Skip the live LinkedIn profile read (provider history only). */
  noLive?: boolean;
  /** Re-derive from the shared research cache only; prospects with nothing cached are left alone, nothing is billed. */
  cacheOnly?: boolean;
  /** Skip capturing recent posts after the research. */
  noNewsfeed?: boolean;
  /** Capture recent posts only, no person research (see research-queue's `newsfeedOnly`). */
  newsfeedOnly?: boolean;
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
 * shared gate so this command and the play send-path agree on what counts:
 * they write the same column, and _reply-research.ts reads any non-empty value
 * as a free Tier-1 hit that suppresses paid research.
 */
export function hasSignal(payload: unknown): boolean {
  return hasDossierSignal(payload);
}

/**
 * Cap the person payload at `DOSSIER_SLICE`. An oversized payload degrades to
 * its own sliced JSON text, which `hasDossierSignal` reads as prose (it
 * explicitly treats truncated dossier JSON as context worth keeping), so the
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

  // Apply --limit after filtering so it means rows researched, not rows considered.
  // --id ignores scope and dossier state to target one prospect.
  const rows = opts.id
    ? ledger
        .listProspectsForResearch({ scopes: ["all"], includeResearched: true, limit: 100_000 })
        .filter((row) => row.id === opts.id)
    : ledger.listProspectsForResearch({
        scopes,
        // A newsfeed-only run is for prospects that already carry research.
        includeResearched: opts.refresh || opts.newsfeedOnly === true,
        limit: 100_000,
      });
  if (opts.newsfeedOnly) {
    await prospectNewsfeedOnly(rows, opts);
    return;
  }
  if (opts.id && rows.length === 0) {
    warn(`prospect ${opts.id} not found, or has no email and no profile URL to research.`);
    return;
  }
  // deepResearchPerson requires a social profile; email-only rows fail consistently.
  // An explicit --id still attempts the requested row.
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
      (opts.cacheOnly
        ? `\n${c.dim("Cache only:")} prospects with no cached research are left alone; nothing is billed.\n\n`
        : `\n${c.dim("Est. cost:")} ~$${(candidates.length * RESEARCH_COST_USD).toFixed(2)}` +
          `  ${c.dim("(~2-5 min each, cached 90d)")}\n\n`),
  );

  if (candidates.length === 0) {
    note("Nothing to research.");
    return;
  }

  if (opts.dryRun) {
    if (!opts.noNewsfeed) {
      const items = candidates.flatMap((r) => {
        const url = newsfeedSeedForProspect(r);
        return url
          ? [{ kind: "prospect" as const, id: r.id, playName: "research-prospects", url }]
          : [];
      });
      process.stdout.write(`${newsfeedEstimateLine(items, opts.cacheOnly === true)}\n\n`);
    }
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
  let notCached = 0;
  let titleUpdated = 0;
  let pass = 0;
  let reject = 0;
  let haltedAt: number | null = null;
  const writtenIds: number[] = [];

  let cappedAt: number | null = null;
  await parallelMap(candidates, opts.concurrency ?? 3, async (row, index) => {
    // The wrapper is failure-safe on its own, but bailing here avoids walking
    // hundreds of rows during an outage just to no-op each one.
    if (isCircuitOpen()) {
      haltedAt ??= index;
      return;
    }
    // Check before each call; up to (concurrency - 1) in-flight calls can exceed the cap.
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
    // Share person:<url> cache entries with angle gathering and queue research.
    const researched = await researchPerson({
      seed,
      playName: "research-prospects",
      subject: { prospectId: row.id },
      remainingUsd,
      enrichCompany: !opts.noCompany,
      liveProfile: !opts.noLive,
      ...(opts.cacheOnly ? { cacheOnly: true } : {}),
    });
    if (researched.notCached) {
      notCached++;
      return;
    }
    costUsd += researched.costUsd;
    if (researched.dossier.status === "unavailable") {
      if (/failed/.test(researched.dossier.warning ?? "")) failed++;
      else empty++;
      return;
    }
    // Counted only for calls that returned real data, so `cached` and `failed`
    // stay mutually exclusive (a negative-cache hit is a failure, not a saving).
    if (researched.cached) cached++;
    // Merge inside a write transaction to preserve concurrent product research and
    // the earlier enrichment record. Bound the person slice before merging so
    // truncation cannot corrupt the JSON wrapper or the product half.
    const applied = await applyPersonResearchToProspect(
      ledger,
      {
        ...row,
        ...(prospect?.title !== undefined ? { title: prospect.title } : {}),
        ...(prospect?.icp_verdict !== undefined ? { icp_verdict: prospect.icp_verdict } : {}),
      },
      researched.dossier,
      // Cache only bills nothing, and the re-judge is a paid classifier call.
      {
        rejudge: !opts.noRejudge && !opts.cacheOnly,
        dossierSlice: DOSSIER_SLICE,
        playName: "research-prospects",
      },
    );
    if (applied.outcome !== "written") {
      empty++;
      return;
    }
    written++;
    writtenIds.push(row.id);
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
      `${c.dim("free (cached):")} ${cached}  ` +
      (opts.cacheOnly ? `${c.dim("not cached, left alone:")} ${notCached}  ` : "") +
      `${c.dim("title updated:")} ${titleUpdated}  ` +
      `${c.dim("re-judged pass:")} ${pass}  ${c.dim("re-judged reject:")} ${reject}  ` +
      `${c.dim("spent:")} $${costUsd.toFixed(2)}`,
  );
  if (opts.noNewsfeed) return;
  // After every dossier is written, one at a time: the tool is rate-limited per wallet.
  // A research run that hit its cap still runs this: cached captures attach for
  // free, and the remaining budget (possibly none) bounds the paid ones.
  const items = writtenIds.flatMap((id) => {
    const p = ledger.getProspectById(id);
    const url = p ? newsfeedSeedForProspect(p) : null;
    return url ? [{ kind: "prospect" as const, id, playName: "research-prospects", url }] : [];
  });
  if (items.length === 0) return;
  const newsfeed = await runNewsfeedPass(items, {
    ...(opts.cacheOnly ? { cacheOnly: true } : {}),
    ...(opts.maxCostUsd != null ? { maxCostUsd: opts.maxCostUsd } : {}),
    spentUsd: costUsd,
  });
  reportNewsfeed(newsfeed, opts.maxCostUsd);
}

/**
 * `--newsfeed-only` for prospects: those with a LinkedIn or X profile and no
 * current capture (all of them with `--refresh`), no person research.
 */
async function prospectNewsfeedOnly(
  rows: Array<{
    id: number;
    linkedin_url: string | null;
    source_profile_url: string | null;
    dossier_json: string | null;
  }>,
  opts: ResearchProspectsOpts,
): Promise<void> {
  let current = 0;
  let noProfile = 0;
  const items: NewsfeedItem[] = [];
  for (const row of rows) {
    const url = newsfeedSeedForProspect(row);
    if (!url) {
      noProfile++;
      continue;
    }
    const half = readPersonHalf(row.dossier_json);
    const pointer =
      half && typeof half === "object" ? (half as Record<string, unknown>)["newsfeed"] : null;
    if (!opts.refresh && !opts.id && hasFreshPointer(pointer, url)) {
      current++;
      continue;
    }
    items.push({ kind: "prospect", id: row.id, playName: "research-prospects", url });
  }
  const cap = resolveCap(opts.limit);
  const selected = cap === undefined ? items : items.slice(0, cap);
  process.stdout.write(
    `${c.dim("newsfeed only")}  ${c.dim("prospects:")} ${rows.length}` +
      (current > 0 ? `  ${c.dim("capture current:")} ${current}` : "") +
      (noProfile > 0 ? `  ${c.dim("no LinkedIn/X profile:")} ${noProfile}` : "") +
      `  ${c.dim("to capture:")} ${selected.length}\n` +
      `${newsfeedEstimateLine(selected, opts.cacheOnly === true)}\n\n`,
  );
  if (selected.length === 0) {
    note("Nothing to capture.");
    return;
  }
  if (opts.dryRun) {
    for (const item of selected.slice(0, 30)) {
      process.stdout.write(`  ${c.dim("·")} ${String(item.id).padEnd(7)} ${c.dim(item.url)}\n`);
    }
    if (selected.length > 30) note(`… and ${selected.length - 30} more`);
    process.stdout.write("\n");
    ok("dry run — nothing captured, nothing written.");
    return;
  }
  const tally = await runNewsfeedPass(selected, {
    ...(opts.cacheOnly ? { cacheOnly: true } : {}),
    ...(opts.maxCostUsd != null ? { maxCostUsd: opts.maxCostUsd } : {}),
  });
  process.stdout.write("\n");
  reportNewsfeed(tally, opts.maxCostUsd);
}
