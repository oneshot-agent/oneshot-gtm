import { getLedger, parallelMap, type QueueRow } from "@oneshot-gtm/core";
import {
  applyPersonResearch,
  COMPANY_RESEARCH_COST_ESTIMATE_USD,
  isCircuitOpen,
  newsfeedSeedForPayload,
  PERSON_RESEARCH_COST_ESTIMATE_USD,
  personResearchOf,
  personSeedFor,
  researchPerson,
  type PersonSeed,
} from "@oneshot-gtm/find";
import { c, header, note, ok, warn } from "../output.ts";
import {
  dedupeItems,
  hasFreshPointer,
  newsfeedEstimateLine,
  type NewsfeedItem,
  reportNewsfeed,
  runNewsfeedPass,
} from "./_newsfeed-pass.ts";

/**
 * Backfill person research onto live queue rows (pending + approved).
 *
 * The post-finder step researches only the rows a finder just created; every
 * row queued before it existed still carries the guest-list title and the
 * company the finder saw. This command runs the same derivation over the
 * existing backlog: `deepResearchPerson` from the profile URL, the current
 * role from the organisation history, `enrichCompany` for the current
 * employer, and the person gate re-judged on real facts. Spend is uncapped
 * by default; use `--max-cost-usd` for a bounded run.
 *
 * Sibling of `research-prospects` (which does the same for sent prospects);
 * rows here have no prospect row yet, so the research lands on the payload.
 */

export const ROW_COST_ESTIMATE_USD =
  PERSON_RESEARCH_COST_ESTIMATE_USD + COMPANY_RESEARCH_COST_ESTIMATE_USD;

export type QueueResearchStatus = "pending" | "approved" | "live";
const STATUSES: QueueResearchStatus[] = ["pending", "approved", "live"];

export interface ResearchQueueOpts {
  dryRun: boolean;
  play?: string;
  status?: string;
  id?: number;
  limit?: number;
  concurrency?: number;
  maxCostUsd?: number;
  /** Re-research rows that already carry `personResearch`. */
  refresh: boolean;
  /** Skip the person-gate re-judge. */
  noRejudge?: boolean;
  /** Skip the company lookup for the current employer. */
  noCompany?: boolean;
  /** Skip the live LinkedIn profile read (provider history only). */
  noLive?: boolean;
  /**
   * Re-derive from the shared research cache only: rows with nothing cached
   * are left alone, and no paid call runs (no provider, live, company or
   * product lookup outside its cache). The free way to pick up a new field
   * from results already bought.
   */
  cacheOnly?: boolean;
  /** Skip capturing recent posts after the research. */
  noNewsfeed?: boolean;
  /**
   * Capture recent posts only: no person research. Rows with a LinkedIn or X
   * profile whose capture is missing or older than 14 days (all of them with
   * `--refresh`).
   */
  newsfeedOnly?: boolean;
}

/**
 * Parse `--status`. Unknown names are rejected rather than ignored, for the
 * same reason `parseScopes` does it: silently widening a paid run is worse
 * than a usage error.
 */
export function parseQueueStatuses(raw: string | undefined): Array<"pending" | "approved"> {
  const value = (raw ?? "live").trim().toLowerCase();
  if (!STATUSES.includes(value as QueueResearchStatus)) {
    throw new Error(`unknown --status value: ${value}. Valid: ${STATUSES.join(", ")}`);
  }
  return value === "live" ? ["pending", "approved"] : [value as "pending" | "approved"];
}

/** Mirrors research-prospects' resolveCap: a bad `--limit` never widens a paid run. */
export function resolveQueueCap(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit)) return 0;
  return Math.max(0, Math.floor(limit));
}

export type CandidateRow = Pick<
  QueueRow,
  | "id"
  | "play_name"
  | "source"
  | "notes"
  | "payload_json"
  | "status"
  | "prospect_id"
  | "sent_at"
  | "send_started_at"
>;

export interface Candidate {
  row: CandidateRow;
  payload: Record<string, unknown>;
  seed: PersonSeed;
}

export interface CandidateSelection {
  candidates: Candidate[];
  /** Rows with nothing `deepResearchPerson` can build a person from. */
  noProfile: number;
  /** Rows that already carry research (skipped unless `--refresh`). */
  researched: number;
  /** Sent or mid-send rows, refused even under `--id`. */
  notLive: number;
}

function parsePayload(row: CandidateRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Pure: which rows this run may research. A sent or mid-send row is never a
 * candidate: `patchLiveQueuePayload` would refuse the write anyway, but the
 * research call would already have been paid for. `explicit` (from `--id`)
 * bypasses the play, status and already-researched filters only.
 */
export function selectCandidates(
  rows: readonly CandidateRow[],
  opts: { refresh: boolean; explicit?: boolean },
): CandidateSelection {
  const out: CandidateSelection = { candidates: [], noProfile: 0, researched: 0, notLive: 0 };
  for (const row of rows) {
    if (row.sent_at != null || row.send_started_at != null) {
      out.notLive++;
      continue;
    }
    if (row.status !== "pending" && row.status !== "approved") {
      out.notLive++;
      continue;
    }
    const payload = parsePayload(row);
    if (!opts.explicit && !opts.refresh && personResearchOf(payload)) {
      out.researched++;
      continue;
    }
    const seed = personSeedFor(payload);
    if (!seed) {
      out.noProfile++;
      continue;
    }
    out.candidates.push({ row, payload, seed });
  }
  return out;
}

function nameOf(payload: Record<string, unknown>): string {
  for (const key of ["name", "founderName", "guestName", "hostName"]) {
    const v = payload[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function currentLine(payload: Record<string, unknown>): string {
  const title = typeof payload["title"] === "string" ? payload["title"].trim() : "";
  const company = typeof payload["company"] === "string" ? payload["company"].trim() : "";
  return [title, company].filter(Boolean).join(" · ") || "(no title on row)";
}

export async function commandResearchQueue(opts: ResearchQueueOpts): Promise<void> {
  header(`research-queue ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const ledger = getLedger();
  const statuses = parseQueueStatuses(opts.status);

  let rows: CandidateRow[];
  if (opts.id !== undefined) {
    rows = ledger.listQueue({ ids: [opts.id], limit: 1 });
    if (rows.length === 0) {
      warn(`queue row ${opts.id} not found.`);
      return;
    }
  } else {
    rows = statuses.flatMap((status) =>
      ledger.listQueue({
        status,
        limit: 100_000,
        ...(opts.play ? { playName: opts.play } : {}),
      }),
    );
  }
  if (opts.newsfeedOnly) {
    await newsfeedOnly(rows, opts);
    return;
  }
  const selection = selectCandidates(rows, {
    refresh: opts.refresh,
    explicit: opts.id !== undefined,
  });
  const cap = resolveQueueCap(opts.limit);
  const candidates = cap === undefined ? selection.candidates : selection.candidates.slice(0, cap);

  process.stdout.write(
    `${c.dim("status:")} ${opts.status ?? "live"}` +
      (opts.play ? `  ${c.dim("play:")} ${opts.play}` : "") +
      `  ${c.dim("rows:")} ${rows.length}` +
      (selection.researched > 0
        ? `  ${c.dim("already researched:")} ${selection.researched}`
        : "") +
      (selection.noProfile > 0 ? `  ${c.dim("no profile:")} ${selection.noProfile}` : "") +
      (selection.notLive > 0 ? `  ${c.dim("not live:")} ${selection.notLive}` : "") +
      `  ${c.dim("to research:")} ${candidates.length}` +
      (cap !== undefined && selection.candidates.length > candidates.length
        ? `  ${c.dim("held back by --limit:")} ${selection.candidates.length - candidates.length}`
        : "") +
      (opts.cacheOnly
        ? `\n${c.dim("Cache only:")} rows with no cached research are left alone; nothing is billed.\n\n`
        : `\n${c.dim("Est. cost:")} ~$${(candidates.length * ROW_COST_ESTIMATE_USD).toFixed(2)}` +
          `  ${c.dim("(~2-5 min each, cached 90d across workspaces)")}\n\n`),
  );

  if (candidates.length === 0) {
    if (opts.id !== undefined && selection.notLive > 0) {
      warn(`queue row ${opts.id} is sent or mid-send; research lands on the prospect instead.`);
    }
    note("Nothing to research.");
    return;
  }

  if (opts.dryRun) {
    if (!opts.noNewsfeed) {
      const items = candidates.flatMap(({ row, payload }) => {
        const url = newsfeedSeedForPayload(payload);
        return url ? [{ kind: "queue" as const, id: row.id, playName: row.play_name, url }] : [];
      });
      process.stdout.write(`${newsfeedEstimateLine(items, opts.cacheOnly === true)}\n\n`);
    }
    for (const { row, payload, seed } of candidates.slice(0, 40)) {
      process.stdout.write(
        `  ${c.dim("·")} #${String(row.id).padEnd(6)} ${nameOf(payload).slice(0, 24).padEnd(26)} ` +
          `${currentLine(payload).slice(0, 44).padEnd(46)} ${c.dim(seed.url ?? seed.email ?? "")}\n`,
      );
    }
    if (candidates.length > 40) note(`… and ${candidates.length - 40} more`);
    process.stdout.write("\n");
    ok("dry run — nothing researched, nothing written.");
    return;
  }

  const tally = {
    researched: 0,
    cached: 0,
    notCached: 0,
    unavailable: 0,
    skipped: 0,
    titleUpdated: 0,
    pass: 0,
    reject: 0,
    rejectedRows: 0,
  };
  const spend = { costUsd: 0 };
  let haltedAt: number | null = null;
  let cappedAt: number | null = null;
  const researchedRows: CandidateRow[] = [];

  await parallelMap(candidates, opts.concurrency ?? 3, async ({ row, seed }, index) => {
    if (isCircuitOpen()) {
      haltedAt ??= index;
      return;
    }
    // Same accounting as research-prospects: checked before the call, so the
    // cap can be exceeded by at most (concurrency - 1) in-flight calls.
    if (opts.maxCostUsd != null && spend.costUsd >= opts.maxCostUsd) {
      cappedAt ??= index;
      return;
    }
    const remainingUsd =
      opts.maxCostUsd != null
        ? Math.max(0, opts.maxCostUsd - spend.costUsd)
        : Number.POSITIVE_INFINITY;
    const researched = await researchPerson({
      seed,
      playName: row.play_name,
      subject: { queueId: row.id },
      remainingUsd,
      enrichCompany: !opts.noCompany,
      liveProfile: !opts.noLive,
      ...(opts.cacheOnly ? { cacheOnly: true } : {}),
    });
    if (researched.notCached) {
      tally.notCached++;
      return;
    }
    spend.costUsd += researched.costUsd;
    if (researched.cached) tally.cached++;
    const applied = await applyPersonResearch(ledger, row, researched.dossier, {
      // Cache only bills nothing, and the re-judge is a paid classifier call.
      rejudge: !opts.noRejudge && !opts.cacheOnly,
      // Cache only: a moved domain may re-read product research from its cache, never buy it.
      remainingUsd: opts.cacheOnly ? 0 : Math.max(0, remainingUsd - researched.costUsd),
      result: spend,
    });
    if (applied.outcome === "unavailable") {
      tally.unavailable++;
      return;
    }
    if (applied.outcome === "skipped") {
      tally.skipped++;
      return;
    }
    tally.researched++;
    if (applied.outcome === "patched") researchedRows.push(row);
    if (applied.patch["title"] !== undefined) tally.titleUpdated++;
    if (applied.verdict === "pass") tally.pass++;
    if (applied.verdict === "reject") tally.reject++;
    if (applied.outcome === "rejected") tally.rejectedRows++;
    const role =
      typeof applied.patch["currentRole"] === "string"
        ? (applied.patch["currentRole"] as string)
        : "(no current role)";
    process.stdout.write(
      `  ${c.green("→")} #${String(row.id).padEnd(6)} ${nameOf(parsePayload(row)).slice(0, 24).padEnd(26)} ` +
        `${c.dim(role.slice(0, 70))}${applied.verdict ? `  ${c.dim(`verdict: ${applied.verdict}`)}` : ""}\n`,
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
    `researched ${tally.researched}  ${c.dim("free (cached):")} ${tally.cached}  ` +
      (opts.cacheOnly ? `${c.dim("not cached, left alone:")} ${tally.notCached}  ` : "") +
      `${c.dim("unavailable:")} ${tally.unavailable}  ${c.dim("not live:")} ${tally.skipped}  ` +
      `${c.dim("title updated:")} ${tally.titleUpdated}  ` +
      `${c.dim("re-judged pass:")} ${tally.pass}  ${c.dim("re-judged reject:")} ${tally.reject}` +
      (tally.rejectedRows > 0 ? `  ${c.dim("rows auto-rejected:")} ${tally.rejectedRows}` : "") +
      `  ${c.dim("spent:")} $${spend.costUsd.toFixed(2)}`,
  );
  note(
    "Rows already drafted keep their draft — Regenerate on /queue to redraft from the researched facts.",
  );
  if (opts.noNewsfeed) return;
  // After every dossier is written, one at a time: the tool is rate-limited per wallet.
  // A research run that hit its cap still runs this: cached captures attach for
  // free, and the remaining budget (possibly none) bounds the paid ones.
  const items = researchedRows.flatMap((row) => {
    const fresh = ledger.getQueueRow(row.id);
    const url = fresh ? newsfeedSeedForPayload(parsePayload(fresh)) : null;
    return url ? [{ kind: "queue" as const, id: row.id, playName: row.play_name, url }] : [];
  });
  if (items.length === 0) return;
  const newsfeed = await runNewsfeedPass(items, {
    ...(opts.cacheOnly ? { cacheOnly: true } : {}),
    ...(opts.maxCostUsd != null ? { maxCostUsd: opts.maxCostUsd } : {}),
    spentUsd: spend.costUsd,
  });
  reportNewsfeed(newsfeed, opts.maxCostUsd);
}

/**
 * `--newsfeed-only`: live rows with a LinkedIn or X profile, no person
 * research. A row whose dossier already points at a capture younger than the
 * cache TTL is skipped unless `--refresh` (the cache answers it for free anyway).
 */
async function newsfeedOnly(rows: CandidateRow[], opts: ResearchQueueOpts): Promise<void> {
  let current = 0;
  let noProfile = 0;
  let notLive = 0;
  const items: NewsfeedItem[] = [];
  for (const row of rows) {
    if (row.sent_at != null || row.send_started_at != null) {
      notLive++;
      continue;
    }
    if (row.status !== "pending" && row.status !== "approved") {
      notLive++;
      continue;
    }
    const payload = parsePayload(row);
    const url = newsfeedSeedForPayload(payload);
    if (!url) {
      noProfile++;
      continue;
    }
    if (
      !opts.refresh &&
      opts.id === undefined &&
      hasFreshPointer(personResearchOf(payload)?.newsfeed, url)
    ) {
      current++;
      continue;
    }
    items.push({ kind: "queue", id: row.id, playName: row.play_name, url });
  }
  const cap = resolveQueueCap(opts.limit);
  const deduped = dedupeItems(items);
  const selected = cap === undefined ? deduped : deduped.slice(0, cap);
  process.stdout.write(
    `${c.dim("newsfeed only")}  ${c.dim("rows:")} ${rows.length}` +
      (current > 0 ? `  ${c.dim("capture current:")} ${current}` : "") +
      (noProfile > 0 ? `  ${c.dim("no LinkedIn/X profile:")} ${noProfile}` : "") +
      (notLive > 0 ? `  ${c.dim("not live:")} ${notLive}` : "") +
      `  ${c.dim("to capture:")} ${selected.length}\n` +
      `${newsfeedEstimateLine(selected, opts.cacheOnly === true)}\n\n`,
  );
  if (selected.length === 0) {
    note("Nothing to capture.");
    return;
  }
  if (opts.dryRun) {
    for (const item of selected.slice(0, 40)) {
      process.stdout.write(`  ${c.dim("·")} #${String(item.id).padEnd(6)} ${c.dim(item.url)}\n`);
    }
    if (selected.length > 40) note(`… and ${selected.length - 40} more`);
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
