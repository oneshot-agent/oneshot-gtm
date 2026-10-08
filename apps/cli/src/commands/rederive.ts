import { getLedger } from "@oneshot-gtm/core";
import { rederiveQueueRow } from "@oneshot-gtm/find";
import { header, note, ok, warn } from "../output.ts";

/**
 * Re-derive, for this workspace, the edge and verdicts a move stripped from
 * a queue row (packages/find/src/queue-rederive.ts). Imports do this on
 * their own; this is for rows moved before that existed, or whose background
 * run timed out. At most two small model calls per row; never changes status.
 */

export interface RederiveOpts {
  id?: number;
  moved: boolean;
  dryRun: boolean;
}

/** Open rows that arrived through a move (their payload carries `movedFrom`). */
export function movedOpenRowIds(): number[] {
  const ledger = getLedger();
  const ids: number[] = [];
  for (const status of ["pending", "approved"] as const) {
    for (const row of ledger.listQueue({ status })) {
      try {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        if (payload && payload["movedFrom"] != null) ids.push(row.id);
      } catch {
        /* unreadable payload: not ours to fix here */
      }
    }
  }
  return ids.toSorted((a, b) => a - b);
}

export async function commandRederive(opts: RederiveOpts): Promise<void> {
  if ((opts.id === undefined) === !opts.moved) {
    throw new Error("pass exactly one of --id <n> or --moved");
  }
  const ids = opts.id !== undefined ? [opts.id] : movedOpenRowIds();
  header(`rederive${opts.dryRun ? " (dry run)" : ""}: ${ids.length} row(s)`);
  let done = 0;
  for (const id of ids) {
    const outcome = await rederiveQueueRow(getLedger(), id, { dryRun: opts.dryRun });
    if (!outcome.ok) {
      warn(`#${id}: ${outcome.reason}`);
      continue;
    }
    done++;
    const p = outcome.patch;
    const verdict = typeof p["icpVerdict"] === "string" ? p["icpVerdict"] : "—";
    const edge = String(p["yourEdge"] ?? p["yourClaim"] ?? "").slice(0, 90);
    const fit = typeof p["fitReason"] === "string" ? p["fitReason"] : "";
    note(`#${id} edge ${p.yourEdgeSource}${edge ? `: ${edge}` : ""}`);
    note(`    verdict ${verdict}${fit ? ` · fit: ${fit}` : ""}`);
  }
  ok(`${opts.dryRun ? "would update" : "updated"} ${done} of ${ids.length}`);
}
