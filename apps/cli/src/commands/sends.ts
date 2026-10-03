import { getLedger, runDeliveryChecks, runOutboundConfirmations } from "@oneshot-gtm/core";
import { header, note, ok, warn } from "../output.ts";

/**
 * `sends check`: keyed sends (one fixed Message-ID each, `outbound_sends`) are
 * looked up in Sent and settled first, then listed by state. Unkeyed
 * Smartlead/Gmail sends get the copy count: expected vs observed in the
 * mailbox's Sent folder (read-only). The scheduler runs both every few minutes;
 * this backfills further back and re-checks sends that already have a result.
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
  const ledger = getLedger();
  const confirmed = await runOutboundConfirmations({
    outbound: ledger.outboundSends,
    delivery: ledger.sendDelivery,
    nowMs: now,
    limit: opts.limit ?? 500,
    dryRun: opts.dryRun,
  });
  const settled = new Map(confirmed.map((r) => [r.key, r]));
  const keyed = ledger.outboundSends.listSince(sinceIso, opts.limit ?? 500);
  if (keyed.length > 0) note(`keyed sends (${keyed.length}), one Message-ID each:`);
  const tallyKeyed = new Map<string, number>();
  for (const k of keyed) {
    const r = settled.get(k.key);
    const status = r && r.after !== "unchanged" ? r.after : k.status;
    tallyKeyed.set(status, (tallyKeyed.get(status) ?? 0) + 1);
    const when = k.firstAttemptAt.slice(0, 16).replace("T", " ");
    const seen = r?.observed ?? k.observed;
    const kind = k.kind === "reply" ? "reply" : "send";
    const line = `${when}  ${k.transport.padEnd(9)} ${kind.padEnd(5)} ${k.identityId}  → ${k.recipient}  ${status}${seen == null ? "" : `, observed ${seen}`}${k.attempts > 1 ? `, ${k.attempts} attempts` : ""}`;
    const error = r?.error ?? k.error;
    if (status === "uncertain" || status === "not_found" || (seen ?? 0) > 1 || r?.error) {
      warn(`${line}${error ? `  — ${error}` : ""}`);
    } else {
      note(line);
    }
  }
  if (keyed.length > 0) {
    note(
      [...tallyKeyed.entries()]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k} ${v}`)
        .join("  "),
    );
  }
  const summary = await runDeliveryChecks({
    store: ledger.sendDelivery,
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
