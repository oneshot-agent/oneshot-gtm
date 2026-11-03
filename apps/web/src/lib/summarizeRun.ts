/**
 * Compact one-liner for a trigger's most-recent run summary. Reads the
 * `FinderResult`-shaped JSON the server persists in `triggers.last_run_summary`
 * (or `{error: string}` on a thrown run).
 *
 * Returns "—" when nothing's been run yet. Precedence:
 *   1. `paused · <reason> · retry HH:MM`: a OneShot outage hit the run
 *      (beats both a thrown error and a halt)
 *   2. `error: <msg>`: thrown / 500
 *   3. `halted · <reason>`: finder returned `halted: "..."`
 *   4. Counter breakdown: `cand=N · kept=M · icp=K · low=L · $X.YY`
 *   5. `—` when summary exists but has no usable fields
 *
 * The per-source part is grouped (`17 of 41 sources read (812 companies) ·
 * 24 failed: payment did not settle`) once there are more than three sources;
 * `runSummaryDetail` carries the full per-source list for a tooltip.
 */
export function summarizeRun(summary: unknown): string {
  if (!summary || typeof summary !== "object") return "—";
  const s = summary as Record<string, unknown>;
  const paused = typeof s["paused"] === "string" && s["paused"] ? (s["paused"] as string) : null;
  const pausedHead = paused
    ? [`paused · ${paused.slice(0, 80)}`, formatRetry(s["retryAt"])].filter(Boolean).join(" · ")
    : null;
  if (typeof s["error"] === "string") {
    return pausedHead ?? `error: ${(s["error"] as string).slice(0, 60)}`;
  }
  const sources = formatPerSource(s["perSource"]);
  const halted = typeof s["halted"] === "string" && s["halted"] ? (s["halted"] as string) : null;
  if (pausedHead) {
    return [pausedHead, sources, halted && halted !== paused ? halted.slice(0, 80) : ""]
      .filter(Boolean)
      .join(" · ");
  }
  if (halted) {
    return [`halted · ${halted.slice(0, 80)}`, sources].filter(Boolean).join(" · ");
  }
  const parts: string[] = [];
  if (typeof s["candidates"] === "number") parts.push(`cand=${s["candidates"]}`);
  if (typeof s["enqueued"] === "number") parts.push(`kept=${s["enqueued"]}`);
  if (typeof s["droppedIcp"] === "number") parts.push(`icp=${s["droppedIcp"]}`);
  if (typeof s["droppedRole"] === "number" && s["droppedRole"] > 0)
    parts.push(`role=${s["droppedRole"]}`);
  if (typeof s["droppedLowSignal"] === "number" && (s["droppedLowSignal"] as number) > 0) {
    parts.push(`low=${s["droppedLowSignal"]}`);
  }
  if (typeof s["costUsd"] === "number") {
    parts.push(`$${(s["costUsd"] as number).toFixed(2)}`);
  }
  // Per-cohort breakdown for the accelerator-batch sweep (set only by that
  // finder). Renders cohorts with hits first, then a tail count of zeros so
  // the operator's eye lands on signal first. Truncated to keep
  // SchedulerStrip's one-line layout intact.
  const perCohort = s["perCohort"];
  if (Array.isArray(perCohort) && perCohort.length > 0) {
    const cohortLine = formatPerCohort(perCohort as unknown[]);
    if (cohortLine.length > 0) parts.push(cohortLine);
  }
  if (sources) parts.push(sources);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/**
 * Full per-source list, one source per line, for a hover tooltip behind the
 * grouped one-liner. Null when the summary carries no per-source entries.
 */
export function runSummaryDetail(summary: unknown): string | null {
  if (!summary || typeof summary !== "object") return null;
  const rows = sourceRows((summary as Record<string, unknown>)["perSource"]);
  if (rows.length === 0) return null;
  return rows
    .map((r) => {
      if (r.skipped) return `${r.label}: not searched`;
      if (r.error != null) return `${r.label}: error: ${r.error.slice(0, 200)}`;
      return `${r.label}: ${r.records} records`;
    })
    .join("\n");
}

/** `retry HH:MM` in local 24h time, or "" when retryAt is absent or unparseable. */
function formatRetry(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "";
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return "";
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `retry ${hh}:${mm}`;
}

/**
 * Per-cohort sweep breakdown: non-zero cohorts first (desc), zero-result
 * cohorts collapse into a trailing `+3 empty (…)` summary.
 */
function formatPerCohort(perCohort: unknown[]): string {
  type Row = { cohort: string; records: number; error: string | null };
  const rows: Row[] = [];
  for (const entry of perCohort) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const cohort = typeof e["cohort"] === "string" ? e["cohort"] : null;
    if (!cohort) continue;
    const records = typeof e["records"] === "number" ? e["records"] : 0;
    const error =
      typeof e["error"] === "string" && (e["error"] as string).length > 0
        ? (e["error"] as string).slice(0, 30)
        : null;
    rows.push({ cohort, records, error });
  }
  if (rows.length === 0) return "";
  const hits = rows.filter((r) => r.records > 0).toSorted((a, b) => b.records - a.records);
  const zeros = rows.filter((r) => r.records === 0);
  const segs: string[] = [];
  for (const r of hits) segs.push(`${r.cohort}: ${r.records}`);
  if (zeros.length > 0) {
    const tags = zeros
      .slice(0, 3)
      .map((r) => r.cohort)
      .join(", ");
    const overflow = zeros.length > 3 ? `, …` : "";
    segs.push(`+${zeros.length} empty (${tags}${overflow})`);
  }
  const joined = segs.join(", ");
  return joined.length > 200 ? `${joined.slice(0, 197)}…` : joined;
}

type SourceRow = { label: string; records: number; error: string | null; skipped: boolean };

function sourceRows(raw: unknown): SourceRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const entry = value as Record<string, unknown>;
    if (typeof entry.label !== "string") return [];
    return [
      {
        label: entry.label,
        records: typeof entry.records === "number" ? entry.records : 0,
        error: typeof entry.error === "string" ? entry.error : null,
        skipped: entry.status === "skipped",
      },
    ];
  });
}

/**
 * Plain-words key for grouping source failures: drops the price/attempt/ref
 * noise a payment error carries, then maps the known outage texts.
 */
function normalizeSourceError(raw: string): string {
  const text = raw
    .replace(/\s*—\s*expected \$[\s\S]*$/, "")
    .replace(/\[payment attempt[^\]]*\]/gi, "")
    .replace(/\(ref:[^)]*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/settlement_pending|did not confirm in time/i.test(text)) return "payment did not settle";
  if (/invalid_payload|insufficient (credits|funds)/i.test(text)) return "wallet refused payment";
  if (/temporarily unavailable/i.test(text)) return "tool temporarily unavailable";
  return text.slice(0, 60);
}

function formatPerSource(raw: unknown): string {
  const rows = sourceRows(raw);
  if (rows.length === 0) return "";
  // A handful of sources reads fine with labels; past that, group.
  if (rows.length <= 3) {
    return rows
      .map((r) => {
        if (r.skipped) return `${r.label}: not searched`;
        if (r.error != null)
          return `${r.label}: ${r.records} records, error: ${r.error.slice(0, 90)}`;
        return `${r.label}: ${r.records === 0 ? "no matches" : `${r.records} records`}`;
      })
      .join(" · ");
  }
  const read = rows.filter((r) => !r.skipped && r.error == null);
  const companies = read.reduce((sum, r) => sum + r.records, 0);
  const segs = [
    `${read.length} of ${rows.length} sources read (${companies.toLocaleString("en-US")} companies)`,
  ];
  const failures = new Map<string, number>();
  for (const r of rows) {
    if (r.skipped || r.error == null) continue;
    const key = normalizeSourceError(r.error);
    failures.set(key, (failures.get(key) ?? 0) + 1);
  }
  for (const [error, count] of [...failures].toSorted((a, b) => b[1] - a[1])) {
    segs.push(`${count} failed: ${error}`);
  }
  const skipped = rows.filter((r) => r.skipped).length;
  if (skipped > 0) segs.push(`${skipped} not searched`);
  return segs.join(" · ");
}
