import { getLedger, parallelMap, type QueueRow, type QueueStatus } from "@oneshot-gtm/core";
import {
  needsCompanyResearch,
  researchQueueRowProduct,
  writeLiveQueueProductResearch,
} from "@oneshot-gtm/find";
import { c, header, note, ok } from "../output.ts";
import { parseScopes, resolveCap } from "./research-prospects.ts";

export interface ResearchProductsOpts {
  dryRun: boolean;
  refresh: boolean;
  /** Pending queue rows (the default). */
  includePending: boolean;
  /** Pending and approved queue rows: every row not yet sent. Wins over `includePending`. */
  includeUnsent?: boolean;
  limit?: number;
  concurrency?: number;
  maxCostUsd?: number;
  externalResearch?: boolean;
  scope?: string;
}

function productAlreadyPresent(value: string | null | undefined): boolean {
  if (!value?.trim()) return false;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Boolean(parsed && typeof parsed === "object" && parsed["product"]);
  } catch {
    return false;
  }
}

/** Whether a queue payload already carries product research. */
export function hasProductResearch(payloadJson: string): boolean {
  try {
    const payload = recordPayload(JSON.parse(payloadJson) as unknown);
    return Boolean(payload?.["productResearch"]);
  } catch {
    return false;
  }
}

function recordPayload(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The queue statuses a run covers. */
export function productQueueStatuses(
  opts: Pick<ResearchProductsOpts, "includePending" | "includeUnsent">,
): QueueStatus[] {
  if (opts.includeUnsent) return ["pending", "approved"];
  return opts.includePending ? ["pending"] : [];
}

/**
 * Queue rows to research: never one sent or mid-send, and, unless
 * refreshing, only one with no company research or with research that has
 * none of the company's own pages while it has a company domain to read.
 */
export function selectProductQueueRows<
  R extends Pick<QueueRow, "play_name" | "payload_json" | "sent_at" | "send_started_at">,
>(rows: readonly R[], opts: { refresh: boolean }): R[] {
  return rows.filter((row) => {
    if (row.sent_at != null || row.send_started_at != null) return false;
    try {
      const payload = recordPayload(JSON.parse(row.payload_json) as unknown);
      if (!payload) return true;
      if (opts.refresh || !payload["productResearch"]) return true;
      return needsCompanyResearch(row.play_name, payload);
    } catch {
      return false;
    }
  });
}

export async function commandResearchProducts(opts: ResearchProductsOpts): Promise<void> {
  header(`research-products ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const ledger = getLedger();
  const scopes = parseScopes(opts.scope);
  const prospectRows = ledger
    .listProspectsForResearch({
      scopes,
      includeResearched: true,
      limit: 100_000,
    })
    .filter((row) => opts.refresh || !productAlreadyPresent(row.dossier_json));
  const statuses = productQueueStatuses(opts);
  const queueRows = selectProductQueueRows(
    statuses.flatMap((status) => ledger.listQueue({ status, limit: 100_000 })),
    { refresh: opts.refresh },
  );
  const combined = [
    ...prospectRows.map((row) => ({ kind: "prospect" as const, row })),
    ...queueRows.map((row) => ({ kind: "queue" as const, row })),
  ];
  const cap = resolveCap(opts.limit);
  const candidates = cap === undefined ? combined : combined.slice(0, cap);
  process.stdout.write(
    `${c.dim("scope:")} ${scopes.join(",")}  ${c.dim("prospects:")} ${prospectRows.length}` +
      `  ${c.dim(`${statuses.join("+") || "queue"}:`)} ${queueRows.length}  ${c.dim("to research:")} ${candidates.length}\n`,
  );
  if (candidates.length === 0) {
    note("Nothing to research.");
    return;
  }
  if (opts.dryRun) {
    for (const item of candidates.slice(0, 30)) {
      const label = item.kind === "prospect" ? item.row.name : `queue #${item.row.id}`;
      process.stdout.write(`  ${c.dim("·")} ${item.kind.padEnd(8)} ${label ?? "(unknown)"}\n`);
    }
    ok("dry run — nothing researched, nothing written.");
    return;
  }

  let costUsd = 0;
  let written = 0;
  let unavailable = 0;
  let cached = 0;
  let heldByBudget = 0;
  // An unknown per-call price cannot be reserved safely across workers.
  // Serialize capped runs; uncapped callers may still opt into concurrency.
  const concurrency = opts.maxCostUsd == null ? (opts.concurrency ?? 3) : 1;
  await parallelMap(candidates, concurrency, async (item) => {
    const cap =
      opts.maxCostUsd === undefined
        ? Number.POSITIVE_INFINITY
        : Number.isFinite(opts.maxCostUsd)
          ? Math.max(0, opts.maxCostUsd)
          : 0;
    const remainingUsd = cap - costUsd;
    if (item.kind === "prospect") {
      const row = item.row;
      const researched = await researchQueueRowProduct(
        {
          id: -row.id,
          play_name: row.source ?? "research-products",
          source: row.source ?? "research-products",
          notes: null,
          payload_json: JSON.stringify({
            name: row.name,
            company: row.company,
            email: row.email,
            sourceProfileUrl: row.source_profile_url ?? row.linkedin_url,
          }),
        },
        { remainingUsd, externalResearch: opts.externalResearch },
      );
      costUsd += researched.costUsd;
      if (researched.cached) cached++;
      if (!researched.cached && researched.dossier.warning?.includes("cost cap reached")) {
        heldByBudget++;
        return;
      }
      if (researched.dossier.status === "unavailable") unavailable++;
      // Atomic re-read + merge: `research-prospects` owns the `person` half of
      // this same column and runs independently, so a read-modify-write on a
      // value fetched earlier can silently revert it.
      ledger.mergeProspectDossierHalf(row.id, "product", researched.dossier);
      written++;
      return;
    }

    const row = item.row;
    const researched = await researchQueueRowProduct(row, {
      remainingUsd,
      externalResearch: opts.externalResearch,
    });
    costUsd += researched.costUsd;
    if (researched.cached) cached++;
    if (!researched.cached && researched.dossier.warning?.includes("cost cap reached")) {
      heldByBudget++;
      return;
    }
    if (researched.dossier.status === "unavailable") {
      unavailable++;
      // A failed lookup never replaces research the row already has.
      if (!opts.refresh && hasProductResearch(row.payload_json)) return;
    }
    // Live rows only: an approved row can be sent while its research runs.
    if (writeLiveQueueProductResearch(row.id, researched.dossier)) written++;
  });
  ok(
    `researched ${written}  ${c.dim("unavailable:")} ${unavailable}  ` +
      `${c.dim("cached:")} ${cached}  ${c.dim("held by budget:")} ${heldByBudget}  ` +
      `${c.dim("spent:")} $${costUsd.toFixed(2)}`,
  );
}
