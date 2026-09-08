import { getLedger, parallelMap } from "@oneshot-gtm/core";
import { gatherAngleEvidence, isCircuitOpen, synthesizePersonAngle } from "@oneshot-gtm/find";
import { c, header, note, ok, warn } from "../output.ts";
import { parseScopes, resolveCap, type ResearchScope } from "./research-prospects.ts";

/**
 * Backfill the per-prospect angle (issue #355) onto existing prospects.
 *
 * Sibling of `research-prospects`: same shape (scoped selector, capped,
 * dry-runnable, bounded concurrency, breaker-aware, resumable), different
 * artifact. Where `research-prospects` buys raw research, this command
 * SYNTHESIZES from research already on hand (plus live GitHub and reply
 * history) into one durable, evidence-cited angle — the value every hand-run
 * qualification pass produces and today throws away.
 */

/** Same shape as research-prospects' RESEARCH_COST_USD — this call may also
 *  buy a fresh dossier or a webRead when nothing free exists, atop the LLM
 *  synthesis call itself (BYO key, not billed through a OneShot receipt). */
const SYNTHESIS_COST_USD = 0.05;

export interface SynthesizeAnglesOpts {
  dryRun: boolean;
  limit?: number;
  concurrency?: number;
  /** Re-synthesize rows that already hold an angle. */
  refresh: boolean;
  scope?: string;
  /** Skip paid evidence-gathering (deepResearchPerson / webRead); free tiers only. */
  cheap?: boolean;
  maxCostUsd?: number;
}

export async function commandSynthesizeAngles(opts: SynthesizeAnglesOpts): Promise<void> {
  header(`synthesize-angles ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const ledger = getLedger();
  const scopes = parseScopes(opts.scope) as ResearchScope[];

  const rows = ledger.listProspectsForAngle({
    scopes,
    includeSynthesized: opts.refresh,
    limit: 100_000,
  });
  const cap = resolveCap(opts.limit);
  const candidates = cap === undefined ? rows : rows.slice(0, cap);

  process.stdout.write(
    `${c.dim("scope:")} ${scopes.join(",")}` +
      `  ${c.dim("without an angle:")} ${rows.length}` +
      `  ${c.dim("to synthesize:")} ${candidates.length}` +
      (cap !== undefined && rows.length > candidates.length
        ? `  ${c.dim("held back by --limit:")} ${rows.length - candidates.length}`
        : "") +
      `\n${c.dim("Est. cost:")} ~$${(candidates.length * SYNTHESIS_COST_USD).toFixed(2)}` +
      `  ${c.dim("(upper bound — free when a dossier/reply history already exists)")}\n\n`,
  );

  if (candidates.length === 0) {
    note("Nothing to synthesize.");
    return;
  }

  if (opts.dryRun) {
    for (const r of candidates.slice(0, 30)) {
      process.stdout.write(
        `  ${c.dim("·")} ${(r.name ?? "").slice(0, 26).padEnd(28)} ` +
          `${c.dim(r.source_profile_url ?? r.linkedin_url ?? r.email ?? "")}\n`,
      );
    }
    if (candidates.length > 30) note(`… and ${candidates.length - 30} more`);
    process.stdout.write("\n");
    ok("dry run — nothing synthesized, nothing written.");
    return;
  }

  let costUsd = 0;
  let written = 0;
  let empty = 0;
  let failed = 0;
  let haltedAt: number | null = null;
  let cappedAt: number | null = null;

  await parallelMap(candidates, opts.concurrency ?? 3, async (row, index) => {
    if (isCircuitOpen()) {
      haltedAt ??= index;
      return;
    }
    if (opts.maxCostUsd != null && costUsd >= opts.maxCostUsd) {
      cappedAt ??= index;
      return;
    }
    const evidence = await gatherAngleEvidence(row.id, { allowPaidResearch: !opts.cheap });
    if (!evidence) {
      failed++;
      return;
    }
    costUsd += evidence.costUsd;
    const { angle } = await synthesizePersonAngle({
      prospect: { id: row.id, name: row.name, company: row.company, email: row.email },
      evidence,
    });
    if (!angle) {
      empty++;
      return;
    }
    ledger.setProspectAngle(row.id, JSON.stringify(angle));
    written++;
    process.stdout.write(
      `  ${c.green("→")} ${(row.name ?? "").slice(0, 26).padEnd(28)} ${c.dim(angle.hook.slice(0, 60))}\n`,
    );
  });

  process.stdout.write("\n");
  if (cappedAt !== null) {
    warn(
      `Stopped at the $${opts.maxCostUsd?.toFixed(2)} ceiling after ~${cappedAt} rows. ` +
        `Re-run to continue — synthesized rows are skipped.`,
    );
  }
  if (haltedAt !== null) {
    warn(
      `Circuit breaker opened after ~${haltedAt} rows — the research backend is failing. ` +
        `Re-run to pick up where this left off.`,
    );
  }
  ok(
    `synthesized ${written}  ${c.dim("no signal:")} ${empty}  ${c.dim("failed:")} ${failed}  ` +
      `${c.dim("spent:")} $${costUsd.toFixed(2)}`,
  );
}
