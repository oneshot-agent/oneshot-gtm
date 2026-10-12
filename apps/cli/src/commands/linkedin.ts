import { readFileSync } from "node:fs";
import {
  getSharedDb,
  importLedgerInvites,
  importTouchedProfiles,
  parseTouchedFile,
} from "@oneshot-gtm/core";
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
