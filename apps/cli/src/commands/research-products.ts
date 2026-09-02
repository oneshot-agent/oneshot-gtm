import { getLedger, mergeProductDossier, parallelMap } from "@oneshot-gtm/core";
import { researchQueueRowProduct } from "@oneshot-gtm/find";
import { c, header, note, ok } from "../output.ts";
import { parseScopes, resolveCap } from "./research-prospects.ts";

export interface ResearchProductsOpts {
  dryRun: boolean;
  refresh: boolean;
  includePending: boolean;
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

function recordPayload(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
  const queueRows = opts.includePending
    ? ledger.listQueue({ status: "pending", limit: 100_000 }).filter((row) => {
        try {
          const payload = recordPayload(JSON.parse(row.payload_json) as unknown);
          if (!payload) return true;
          return opts.refresh || !payload["productResearch"];
        } catch {
          return false;
        }
      })
    : [];
  const combined = [
    ...prospectRows.map((row) => ({ kind: "prospect" as const, row })),
    ...queueRows.map((row) => ({ kind: "queue" as const, row })),
  ];
  const cap = resolveCap(opts.limit);
  const candidates = cap === undefined ? combined : combined.slice(0, cap);
  process.stdout.write(
    `${c.dim("scope:")} ${scopes.join(",")}  ${c.dim("prospects:")} ${prospectRows.length}` +
      `  ${c.dim("pending:")} ${queueRows.length}  ${c.dim("to research:")} ${candidates.length}\n`,
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
      const latestDossier = ledger.getProspectById(row.id)?.dossier_json ?? row.dossier_json;
      ledger.setProspectDossier(row.id, mergeProductDossier(latestDossier, researched.dossier));
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
    if (researched.dossier.status === "unavailable") unavailable++;
    const payload = recordPayload(JSON.parse(row.payload_json) as unknown) ?? {};
    payload["productResearch"] = researched.dossier;
    ledger.updateQueuePayload({ id: row.id, payload });
    written++;
  });
  ok(
    `researched ${written}  ${c.dim("unavailable:")} ${unavailable}  ` +
      `${c.dim("cached:")} ${cached}  ${c.dim("held by budget:")} ${heldByBudget}  ` +
      `${c.dim("spent:")} $${costUsd.toFixed(2)}`,
  );
}
