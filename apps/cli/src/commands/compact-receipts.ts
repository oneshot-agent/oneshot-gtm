import { statSync } from "node:fs";
import { getLedger } from "@oneshot-gtm/core";
import { c, header, note, ok, warn } from "../output.ts";

/**
 * Shrink a ledger written before receipts were slimmed at write time (#695).
 * Old `web.read` receipts carried the whole scraped page; this trims every
 * pre-slimming payload to the envelope `recordReceipt` now stores, then
 * VACUUMs so the file actually shrinks. Dry run by default. email.find/verify
 * and direct_mail.order receipts are never touched (see
 * VERBATIM_RECEIPT_CALL_TYPES). Acts on the current workspace's ledger.
 */

export interface CompactReceiptsOpts {
  apply: boolean;
  vacuum: boolean;
}

export interface CompactReceiptsSummary {
  rows: number;
  skipped: number;
  bytesBefore: number;
  bytesAfter: number;
  fileBytesBefore: number;
  fileBytesAfter: number | null;
  vacuumed: boolean;
}

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** The ledger's footprint: recent writes can still sit in the WAL file. */
function databaseSize(path: string): number {
  return fileSize(path) + fileSize(`${path}-wal`);
}

export function commandCompactReceipts(opts: CompactReceiptsOpts): CompactReceiptsSummary {
  header(`compact-receipts ${opts.apply ? "" : c.dim("(dry run)")}`);
  const ledger = getLedger();
  const path = ledger.filePath;
  const fileBytesBefore = databaseSize(path);
  const result = ledger.compactReceiptPayloads({ apply: opts.apply });
  const summary: CompactReceiptsSummary = {
    ...result,
    fileBytesBefore,
    fileBytesAfter: null,
    vacuumed: false,
  };

  note(`ledger: ${path} (${mb(fileBytesBefore)})`);
  if (result.skipped > 0) warn(`${result.skipped} receipt(s) with unparseable JSON left as-is`);
  if (result.rows === 0) {
    ok("no oversized receipt payloads; nothing to trim");
  } else {
    const verb = opts.apply ? "trimmed" : "would trim";
    ok(
      `${verb} ${result.rows} receipt(s): ${mb(result.bytesBefore)} → ${mb(result.bytesAfter)}` +
        " (email.find/verify and direct mail kept whole)",
    );
  }
  if (!opts.apply) {
    if (result.rows > 0) note("run again with --apply to write, then VACUUM to reclaim the space");
    return summary;
  }
  // An earlier `--no-vacuum` run, or a VACUUM that hit a lock, leaves free
  // pages behind with nothing left to trim; still vacuum those.
  if (result.rows === 0 && ledger.freePages() === 0) return summary;
  if (!opts.vacuum) {
    note("skipped VACUUM (--no-vacuum); the file keeps its size until one runs");
    return summary;
  }
  try {
    ledger.vacuum();
  } catch (err) {
    warn(
      `VACUUM failed: ${(err as Error).message}. The trim is saved; stop the dashboard ` +
        "or other CLI runs on this workspace and re-run to reclaim the space.",
    );
    return summary;
  }
  summary.vacuumed = true;
  summary.fileBytesAfter = databaseSize(path);
  ok(`vacuumed: ${mb(fileBytesBefore)} → ${mb(summary.fileBytesAfter)}`);
  return summary;
}
