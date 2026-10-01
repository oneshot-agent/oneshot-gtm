import { getLedger, runDeliveryChecks } from "@oneshot-gtm/core";
import { header, note, ok, warn } from "../output.ts";

/**
 * `sends check`: count each recent Smartlead/Gmail send's copies in its
 * mailbox's Sent folder (read-only) and report expected vs observed. The
 * scheduler runs the same check every few minutes over the last 48 h; this
 * backfills further back and re-checks sends that already have a result.
 */

export interface SendsCheckOpts {
  since?: string;
  limit?: number;
  dryRun: boolean;
}

/** `7d`, `48h`, `90m`, or an ISO date. */
export function parseSince(raw: string | undefined, nowMs: number): string {
  const v = (raw ?? "7d").trim();
  const m = /^(\d+)\s*([dhm])$/i.exec(v);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    const ms = unit === "d" ? n * 86_400_000 : unit === "h" ? n * 3_600_000 : n * 60_000;
    return new Date(nowMs - ms).toISOString();
  }
  const t = Date.parse(v);
  if (!Number.isFinite(t))
    throw new Error(`--since must look like 7d, 48h, 90m or a date (got "${v}")`);
  return new Date(t).toISOString();
}

export async function commandSendsCheck(opts: SendsCheckOpts): Promise<void> {
  const now = Date.now();
  const sinceIso = parseSince(opts.since, now);
  header(
    `delivery check · sends since ${sinceIso.slice(0, 16).replace("T", " ")} UTC${opts.dryRun ? " · dry run (nothing recorded)" : ""}`,
  );
  const summary = await runDeliveryChecks({
    store: getLedger().sendDelivery,
    nowMs: now,
    sinceIso,
    untilIso: new Date(now - 60_000).toISOString(),
    limit: opts.limit ?? 500,
    includeChecked: true,
    dryRun: opts.dryRun,
  });
  for (const r of summary.results) {
    const c = r.candidate;
    const row = c.queueId != null ? `#${c.queueId}` : `receipt ${c.receiptId}`;
    const when = c.sentAt.slice(0, 16).replace("T", " ");
    const seen = r.observed == null ? "?" : String(r.observed);
    const line = `${when}  ${row.padEnd(12)} ${c.identity}  → ${c.recipient}  expected 1, observed ${seen}  ${r.outcome}`;
    if (r.outcome === "duplicate") {
      warn(`${line}  (${r.deliveredAt.map((t) => t.slice(11, 19)).join(", ")} UTC)`);
    } else if (r.outcome === "not_found" || r.outcome === "transient" || r.outcome === "skipped") {
      warn(`${line}${r.error ? `  — ${r.error}` : ""}`);
    } else {
      note(line);
    }
  }
  const tally = `checked ${summary.checked}  ok ${summary.ok}  duplicate ${summary.duplicate}  not-found ${summary.notFound}  pending ${summary.pending}  unreadable ${summary.transient}  skipped ${summary.skipped}`;
  if (summary.duplicate > 0 || summary.notFound > 0) warn(tally);
  else ok(tally);
}
