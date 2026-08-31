import { getLedger, hasDossierSignal, parallelMap } from "@oneshot-gtm/core";
import { isCircuitOpen, safeDeepResearchPerson } from "@oneshot-gtm/find";
import { c, header, note, ok, warn } from "../output.ts";

/**
 * Backfill research dossiers onto existing prospects.
 *
 * `prospects.dossier_json` is READ as free Tier-1 context when drafting a reply
 * (apps/server/src/api/_reply-research.ts) but nothing in production ever wrote
 * it — so every reply draft fell through to paid enrich + webRead, and the
 * research the finders already bought was computed and discarded. This fills
 * the column so that work is done once and reused.
 *
 * Sibling of `enrich-linkedin`: same shape (capped, dry-runnable, bounded
 * concurrency, breaker-aware), different call. Concurrency defaults lower
 * because deepResearchPerson runs minutes, not seconds.
 */

const RESEARCH_COST_USD = 0.05;
/** Matches the slice the finders already use for a queued dossier. */
const DOSSIER_SLICE = 6000;

export type ResearchScope = "active" | "replied" | "unjudged" | "all";
const SCOPES: readonly ResearchScope[] = ["active", "replied", "unjudged", "all"];

export interface ResearchProspectsOpts {
  dryRun: boolean;
  limit?: number;
  concurrency?: number;
  /** Re-research rows that already hold a dossier. */
  refresh: boolean;
  scope?: string;
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

/** The social URL deepResearchPerson should chase, if any. */
export function researchUrl(row: {
  source_profile_url: string | null;
  linkedin_url: string | null;
}): string | null {
  const source = row.source_profile_url?.trim();
  if (source) return source;
  const linkedin = row.linkedin_url?.trim();
  return linkedin ? linkedin : null;
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

export async function commandResearchProspects(opts: ResearchProspectsOpts): Promise<void> {
  header(`research-prospects ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const ledger = getLedger();
  const scopes = parseScopes(opts.scope);

  // Read the backlog, then cap in memory — same reasoning as enrich-linkedin:
  // pushing --limit into SQL would make it mean "consider N" not "research N".
  const rows = ledger.listProspectsForResearch({
    scopes,
    includeResearched: opts.refresh,
    limit: 100_000,
  });
  const cap = resolveCap(opts.limit);
  const candidates = cap === undefined ? rows : rows.slice(0, cap);

  process.stdout.write(
    `${c.dim("scope:")} ${scopes.join(",")}` +
      `  ${c.dim("without a dossier:")} ${rows.length}` +
      `  ${c.dim("to research:")} ${candidates.length}` +
      (cap !== undefined && rows.length > candidates.length
        ? `  ${c.dim("held back by --limit:")} ${rows.length - candidates.length}`
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
  let haltedAt: number | null = null;

  await parallelMap(candidates, opts.concurrency ?? 3, async (row, index) => {
    // The wrapper is failure-safe on its own, but bailing here avoids walking
    // hundreds of rows during an outage just to no-op each one.
    if (isCircuitOpen()) {
      haltedAt ??= index;
      return;
    }
    const url = researchUrl(row);
    const email = row.email?.trim();
    const res = await safeDeepResearchPerson(
      {
        ...(url ? { socialMediaUrl: url } : {}),
        ...(email ? { email } : {}),
        ...(row.name ? { name: row.name } : {}),
        ...(row.company && row.company !== "(unknown)" ? { company: row.company } : {}),
      },
      {
        playName: "research-prospects",
        memo: `backfill dossier for prospect ${row.id}`,
        decisionContext: { source: "research-prospects", prospectId: row.id, scope: scopes },
      },
    );
    // receiptId 0 = served without billing (cache hit, or the failure
    // sentinel). The cached payload still carries the ORIGINAL call's `cost`,
    // so adding it unconditionally would report spend that never happened.
    const billed = res.receiptId !== 0;
    if (billed) costUsd += res.result?.cost ?? 0;

    const payload = res.result?.result;
    if (res.result?.status === "failed") {
      failed++;
      return;
    }
    // Counted only for calls that returned real data, so `cached` and `failed`
    // stay mutually exclusive (a negative-cache hit is a failure, not a saving).
    if (!billed) cached++;
    if (!hasSignal(payload)) {
      empty++;
      return;
    }
    ledger.setProspectDossier(row.id, JSON.stringify(payload, null, 2).slice(0, DOSSIER_SLICE));
    written++;
    process.stdout.write(
      `  ${c.green("→")} ${(row.name ?? "").slice(0, 26).padEnd(28)} ${c.dim(url ?? email ?? "")}\n`,
    );
  });

  process.stdout.write("\n");
  if (haltedAt !== null) {
    warn(
      `Circuit breaker opened after ~${haltedAt} rows — the research backend is failing. ` +
        `Re-run to pick up where this left off.`,
    );
  }
  ok(
    `researched ${written}  ${c.dim("no signal:")} ${empty}  ${c.dim("failed:")} ${failed}  ` +
      `${c.dim("free (cached):")} ${cached}  ${c.dim("spent:")} $${costUsd.toFixed(2)}`,
  );
}
