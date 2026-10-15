import { readFileSync } from "node:fs";
import {
  getSharedDb,
  importLedgerInvites,
  importTouchedProfiles,
  parseTouchedFile,
} from "@oneshot-gtm/core";
import { continueCadencesOntoLinkedIn } from "@oneshot-gtm/plays";
import { c, header, note } from "../output.ts";

export interface ImportTouchedOptions {
  source?: string;
  dryRun?: boolean;
  verbose?: boolean;
  fromLedgers?: boolean;
}

/**
 * `linkedin import-touched`: record profiles already contacted on LinkedIn so
 * the invite guard refuses them. Sends nothing, touches no cadence.
 */
export async function commandLinkedInImportTouched(
  file: string | undefined,
  opts: ImportTouchedOptions,
): Promise<void> {
  if (opts.fromLedgers === true) {
    if (file) throw new Error("pass either a file or --from-ledgers, not both");
    header(`linkedin import-touched --from-ledgers ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
    const results = importLedgerInvites(getSharedDb(), { dryRun: opts.dryRun === true });
    if (results.length === 0) note("No other workspace has a ledger.");
    for (const r of results) {
      if (r.error) note(`${r.workspace}: ${c.red("failed")} · ${r.error}`);
      else note(`${r.workspace}: imported ${r.imported} · already present ${r.present}`);
    }
    if (results.some((r) => r.error)) {
      throw new Error("a workspace ledger could not be read (see above)");
    }
    return;
  }
  if (!file) throw new Error("pass a CSV or JSON file, or --from-ledgers");
  header(`linkedin import-touched ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  const result = importTouchedProfiles(getSharedDb(), parseTouchedFile(text), {
    ...(opts.source ? { source: opts.source } : {}),
    dryRun: opts.dryRun === true,
  });
  note(
    `imported ${result.imported} · already present ${result.present} · not a LinkedIn profile ${result.rejected.length}`,
  );
  if (opts.verbose) for (const r of result.rejected) note(`  rejected: ${r || "(empty)"}`);
}

/**
 * `linkedin continue-cadences`: give email cadences enrolled before
 * `linkedinContinuation` was on their LinkedIn steps. Without `--write` it only
 * counts. Sends nothing: every LinkedIn step is still previewed on /cadences.
 */
export async function commandLinkedInContinueCadences(opts: {
  write?: boolean;
  verbose?: boolean;
}): Promise<void> {
  header(`linkedin continue-cadences ${opts.write ? "" : c.dim("(dry-run)")}`);
  const result = continueCadencesOntoLinkedIn({ write: opts.write === true });
  const byStatus = new Map<string, number>();
  for (const e of result.extended) byStatus.set(e.status, (byStatus.get(e.status) ?? 0) + 1);
  const statuses = [...byStatus].map(([s, n]) => `${s} ${n}`).join(" · ") || "none";
  note(`${opts.write ? "continued" : "would continue"} ${result.extended.length} (${statuses})`);
  const last = result.extended
    .map((e) => e.dueAt)
    .filter((d): d is string => Boolean(d))
    .toSorted()
    .at(-1);
  if (last) note(`last connection request due ${last.slice(0, 10)}`);
  const skipped = Object.entries(result.skipped)
    .toSorted((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason} ${n}`)
    .join(" · ");
  if (skipped) note(`left alone: ${skipped}`);
  if (opts.verbose)
    for (const e of result.extended)
      note(`  #${e.prospectId} ${e.playName} (${e.status}) due ${e.dueAt?.slice(0, 10) ?? "-"}`);
}
