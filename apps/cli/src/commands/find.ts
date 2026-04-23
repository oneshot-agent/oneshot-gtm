import { getLedger, type QueueRow, type QueueStatus } from "@oneshot-gtm/core";
import {
  drainQueue,
  nextSleepMs,
  runAcceleratorBatchFinder,
  runDueTriggers,
  runHiringSignalFinder,
  runJobChangeFinder,
  runPodcastGuestFinder,
  runPostFundingFinder,
  runShowHnFinder,
  type FinderResult,
} from "@oneshot-gtm/find";
import { box, c, fail, header, note, ok, warn } from "../output.ts";

export async function commandFindShowHn(opts: {
  sinceDays?: number;
  limit?: number;
  maxCost?: number;
  dryRun: boolean;
}): Promise<void> {
  header(`find show-hn ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const result = await runShowHnFinder({
    dryRun: opts.dryRun,
    sinceDays: opts.sinceDays ?? 1,
    limit: opts.limit ?? 25,
    ...(opts.maxCost != null ? { maxCostUsd: opts.maxCost } : {}),
  });
  printFinderResult(result);
}

export async function commandFindPostFunding(opts: {
  sourceUrls?: string;
  auto: boolean;
  autoIndustry?: string;
  autoRounds?: string;
  autoSinceDays?: number;
  limit?: number;
  maxCost?: number;
  dryRun: boolean;
}): Promise<void> {
  if (!opts.sourceUrls && !opts.auto) {
    fail("post-funding requires --source-urls <file> or --auto");
    process.exit(1);
  }
  const tag = opts.auto ? c.dim("(auto)") : "";
  header(`find post-funding ${tag} ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const rounds = opts.autoRounds
    ? opts.autoRounds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const result = await runPostFundingFinder({
    dryRun: opts.dryRun,
    auto: opts.auto,
    ...(opts.sourceUrls ? { sourceUrlsFile: opts.sourceUrls } : {}),
    ...(opts.autoIndustry ? { autoIndustry: opts.autoIndustry } : {}),
    ...(rounds ? { autoRounds: rounds } : {}),
    ...(opts.autoSinceDays != null ? { autoSinceDays: opts.autoSinceDays } : {}),
    limit: opts.limit ?? 25,
    ...(opts.maxCost != null ? { maxCostUsd: opts.maxCost } : {}),
  });
  printFinderResult(result);
}

export async function commandFindAcceleratorBatch(opts: {
  cohort: string;
  indexUrl?: string;
  limit?: number;
  maxCost?: number;
  dryRun: boolean;
}): Promise<void> {
  header(
    `find accelerator-batch ${c.dim(`(${opts.cohort})`)} ${opts.dryRun ? c.dim("(dry-run)") : ""}`,
  );
  const result = await runAcceleratorBatchFinder({
    dryRun: opts.dryRun,
    cohort: opts.cohort,
    ...(opts.indexUrl ? { indexUrl: opts.indexUrl } : {}),
    limit: opts.limit ?? 25,
    ...(opts.maxCost != null ? { maxCostUsd: opts.maxCost } : {}),
  });
  printFinderResult(result);
}

export async function commandFindJobChange(opts: {
  personas?: string;
  companies?: string;
  sinceDays?: number;
  limit?: number;
  maxCost?: number;
  dryRun: boolean;
}): Promise<void> {
  header(`find job-change ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const personas = splitCsv(opts.personas);
  const companies = splitCsv(opts.companies);
  const result = await runJobChangeFinder({
    dryRun: opts.dryRun,
    ...(personas ? { personas } : {}),
    ...(companies ? { companies } : {}),
    ...(opts.sinceDays != null ? { sinceDays: opts.sinceDays } : {}),
    limit: opts.limit ?? 25,
    ...(opts.maxCost != null ? { maxCostUsd: opts.maxCost } : {}),
  });
  printFinderResult(result);
}

export async function commandFindHiringSignal(opts: {
  roles?: string;
  companies?: string;
  yourClaim?: string;
  sinceDays?: number;
  limit?: number;
  maxCost?: number;
  dryRun: boolean;
}): Promise<void> {
  header(`find hiring-signal ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const roles = splitCsv(opts.roles);
  const companies = splitCsv(opts.companies);
  const result = await runHiringSignalFinder({
    dryRun: opts.dryRun,
    ...(roles ? { roles } : {}),
    ...(companies ? { companies } : {}),
    ...(opts.yourClaim ? { yourClaim: opts.yourClaim } : {}),
    ...(opts.sinceDays != null ? { sinceDays: opts.sinceDays } : {}),
    limit: opts.limit ?? 25,
    ...(opts.maxCost != null ? { maxCostUsd: opts.maxCost } : {}),
  });
  printFinderResult(result);
}

export async function commandFindPodcastGuest(opts: {
  podcasts?: string;
  sinceDays?: number;
  skipRead: boolean;
  limit?: number;
  maxCost?: number;
  dryRun: boolean;
}): Promise<void> {
  header(`find podcast-guest ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const podcasts = splitCsv(opts.podcasts);
  const result = await runPodcastGuestFinder({
    dryRun: opts.dryRun,
    ...(podcasts ? { podcasts } : {}),
    ...(opts.sinceDays != null ? { sinceDays: opts.sinceDays } : {}),
    skipRead: opts.skipRead,
    limit: opts.limit ?? 25,
    ...(opts.maxCost != null ? { maxCostUsd: opts.maxCost } : {}),
  });
  printFinderResult(result);
}

function splitCsv(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export function commandFindQueue(opts: {
  play?: string;
  status?: QueueStatus;
  limit?: number;
}): void {
  header(
    `find queue ${opts.play ? c.dim(`(${opts.play})`) : ""} ${opts.status ? c.dim(`[${opts.status}]`) : ""}`,
  );
  const ledger = getLedger();
  const filterArgs: { playName?: string; status?: QueueStatus; limit?: number } = {
    limit: opts.limit ?? 50,
  };
  if (opts.play) filterArgs.playName = opts.play;
  if (opts.status) filterArgs.status = opts.status;
  const rows = ledger.listQueue(filterArgs);
  if (rows.length === 0) {
    note("Queue empty for the current filter.");
    const counts = ledger.queueCounts();
    note(
      `${c.dim("totals:")} ${Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join("  ")}`,
    );
    return;
  }
  for (const row of rows) {
    printQueueRow(row);
  }
  process.stdout.write(`\n${c.dim(`${rows.length} row(s) shown`)}\n`);
}

export function commandFindApprove(opts: { id?: string; all: boolean; play?: string }): void {
  header(`find approve ${opts.all ? c.dim("(all pending)") : (opts.id ?? "")}`);
  const ledger = getLedger();
  if (opts.all) {
    const n = ledger.approveAllPending(opts.play ? { playName: opts.play } : {});
    ok(`approved ${n} pending row(s)${opts.play ? ` for play=${opts.play}` : ""}.`);
    return;
  }
  if (!opts.id) {
    fail("either pass <id> or --all [--play <name>]");
    process.exit(1);
  }
  const id = Number.parseInt(opts.id, 10);
  if (!Number.isFinite(id)) {
    fail(`invalid id: ${opts.id}`);
    process.exit(1);
  }
  const row = ledger.getQueueRow(id);
  if (!row) {
    fail(`row #${id} not found`);
    process.exit(1);
  }
  ledger.setQueueStatus({ id, status: "approved" });
  ok(`#${id} approved.`);
}

export function commandFindReject(opts: { id: string; reason?: string }): void {
  header(`find reject ${opts.id}`);
  const id = Number.parseInt(opts.id, 10);
  if (!Number.isFinite(id)) {
    fail(`invalid id: ${opts.id}`);
    process.exit(1);
  }
  const ledger = getLedger();
  const row = ledger.getQueueRow(id);
  if (!row) {
    fail(`row #${id} not found`);
    process.exit(1);
  }
  ledger.setQueueStatus(
    opts.reason ? { id, status: "rejected", notes: opts.reason } : { id, status: "rejected" },
  );
  ok(`#${id} rejected${opts.reason ? ` (${opts.reason})` : ""}.`);
}

export async function commandFindDrain(opts: {
  play: string;
  limit?: number;
  dryRun: boolean;
  senderCohort?: string;
  offer?: string;
}): Promise<void> {
  header(`find drain ${opts.play} ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const result = await drainQueue({
    playName: opts.play,
    limit: opts.limit ?? 10,
    dryRun: opts.dryRun,
    ...(opts.senderCohort ? { senderCohort: opts.senderCohort } : {}),
    ...(opts.offer ? { freeForCohortOffer: opts.offer } : {}),
  });
  if (result.drained === 0) {
    note(`No approved rows for ${c.cyan(opts.play)}. Run: oneshot-gtm find approve <id>`);
    return;
  }
  ok(`drained ${result.drained} row(s); ${result.sent} ${opts.dryRun ? "would be sent" : "sent"}.`);
  if (result.errors.length > 0) {
    for (const e of result.errors) warn(`#${e.id}: ${e.message}`);
  }
}

export async function commandFindWatch(opts: { once: boolean; quiet: boolean }): Promise<void> {
  header(`find watch ${opts.once ? c.dim("(--once)") : c.dim("(daemon)")}`);
  let cancelled = false;
  const shutdown = (): void => {
    cancelled = true;
    process.stdout.write(`\n${c.dim("watch: stopping after current iteration...")}\n`);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  for (;;) {
    const outcomes = await runDueTriggers();
    for (const o of outcomes) {
      if (!o.fired) {
        if (!opts.quiet) note(`${o.name}: skipped (next due in ${humanMs(o.nextDueInMs)})`);
        continue;
      }
      if (o.error) {
        fail(`${o.name}: error — ${o.error}`);
      } else if (o.result) {
        ok(
          `${o.name}: candidates=${o.result.candidates} kept=${o.result.enqueued} icp-dropped=${o.result.droppedIcp} dup=${o.result.droppedDuplicate} enrich-failed=${o.result.droppedEnrichment} cost=$${o.result.costUsd.toFixed(2)}${o.result.halted ? ` (halted: ${o.result.halted})` : ""}`,
        );
      }
    }

    if (opts.once || cancelled) break;
    const sleepMs = nextSleepMs(outcomes);
    if (!opts.quiet) note(`watch: sleeping ${humanMs(sleepMs)}`);
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
}

function printFinderResult(r: FinderResult): void {
  process.stdout.write("\n");
  const tag = r.enqueued > 0 ? c.green : c.dim;
  process.stdout.write(`  ${tag("enqueued:")}            ${r.enqueued}\n`);
  process.stdout.write(`  ${c.dim("candidates seen:")}     ${r.candidates}\n`);
  process.stdout.write(`  ${c.dim("dropped (ICP):")}       ${r.droppedIcp}\n`);
  process.stdout.write(`  ${c.dim("dropped (dedupe):")}    ${r.droppedDuplicate}\n`);
  process.stdout.write(`  ${c.dim("dropped (enrich):")}    ${r.droppedEnrichment}\n`);
  process.stdout.write(`  ${c.dim("OneShot spend:")}       $${r.costUsd.toFixed(2)}\n`);
  if (r.halted) warn(`halted: ${r.halted}`);
  process.stdout.write(
    `\n${c.dim("review with:")} ${c.cyan("oneshot-gtm find queue")}  ${c.dim("then:")} ${c.cyan("oneshot-gtm find approve <id>")}  ${c.dim("then:")} ${c.cyan("oneshot-gtm find drain <play>")}\n`,
  );
}

function printQueueRow(row: QueueRow): void {
  let payload: {
    name?: string;
    founderName?: string;
    email?: string;
    founderEmail?: string;
    company?: string;
  } = {};
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    // ignore
  }
  const name = payload.name ?? payload.founderName ?? "(unknown)";
  const email = payload.email ?? payload.founderEmail ?? "(no email)";
  const company = payload.company ?? "";
  const tag = statusTag(row.status);
  box(
    `#${row.id}  ${tag}  ${row.play_name}`,
    [
      `${c.bold("name:")}    ${name}`,
      `${c.bold("email:")}   ${c.cyan(email)}`,
      company ? `${c.bold("company:")} ${company}` : null,
      `${c.bold("source:")}  ${c.dim(row.source)}`,
      `${c.bold("found:")}   ${c.dim(row.found_at)}`,
      row.notes ? `${c.bold("notes:")}   ${c.dim(row.notes)}` : null,
    ]
      .filter((s): s is string => !!s)
      .join("\n"),
  );
}

function statusTag(status: QueueStatus): string {
  switch (status) {
    case "pending":
      return c.yellow("[pending]");
    case "approved":
      return c.green("[approved]");
    case "rejected":
      return c.red("[rejected]");
    case "sent":
      return c.cyan("[sent]");
    case "expired":
      return c.dim("[expired]");
  }
}

function humanMs(ms: number): string {
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.ceil(ms / 60_000)}m`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}
