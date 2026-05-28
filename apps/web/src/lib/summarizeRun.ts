/**
 * Compact one-liner for a trigger's most-recent run summary. Reads the
 * `FinderResult`-shaped JSON the server persists in `triggers.last_run_summary`
 * (or `{error: string}` on a thrown run).
 *
 * Returns "—" when nothing's been run yet. Precedence:
 *   1. `error: <msg>`  — thrown / 500
 *   2. `halted · <reason>` — finder returned `halted: "..."`
 *   3. counter breakdown: `cand=N · kept=M · icp=K · low=L · $X.YY`
 *   4. `—` when summary exists but has no usable fields
 *
 * Used by:
 *   - `/queue` Triggers table (run column)
 *   - `/home` SchedulerStrip (last run column)
 */
export function summarizeRun(summary: unknown): string {
  if (!summary || typeof summary !== "object") return "—";
  const s = summary as Record<string, unknown>;
  if (typeof s["error"] === "string") return `error: ${(s["error"] as string).slice(0, 60)}`;
  if (typeof s["halted"] === "string" && s["halted"]) {
    return `halted · ${(s["halted"] as string).slice(0, 80)}`;
  }
  const parts: string[] = [];
  if (typeof s["candidates"] === "number") parts.push(`cand=${s["candidates"]}`);
  if (typeof s["enqueued"] === "number") parts.push(`kept=${s["enqueued"]}`);
  if (typeof s["droppedIcp"] === "number") parts.push(`icp=${s["droppedIcp"]}`);
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
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/**
 * Format the per-cohort sweep breakdown for SchedulerStrip. Cohorts with
 * non-zero records come first (sorted by record count desc), zero-result
 * cohorts collapse into a trailing summary like `+3 empty (spc-2026-1, …)`
 * so the one-line layout doesn't blow out when the sweep is wide.
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
