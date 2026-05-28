import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { TriggerView } from "@oneshot-gtm/shared-types";
import { api } from "../../api/client.ts";
import { cn, timeAgo } from "../../lib/cn.ts";
import { humanInterval } from "../../lib/humanInterval.ts";
import { summarizeRun } from "../../lib/summarizeRun.ts";
import { Badge } from "../primitives/Badge.tsx";
import { EmptyNote } from "../primitives/EmptyNote.tsx";
import { SkeletonRow } from "../primitives/Skeleton.tsx";

/**
 * Compact per-trigger status strip on /home. Answers the three questions
 * a founder asks when they suspect the scheduler is dead:
 *   1. Did anything run recently? — "show-hn ran 4h ago"
 *   2. Is anything due soon? — "github-topics next in 2h"
 *   3. What happened on the last run? — "cand=50 · kept=0 · icp=5 · $0.05"
 *
 * Read-only, no new API. Refetches every 30s alongside the other /home
 * sections. Drill-down is via the strip header → /queue, where the full
 * trigger management UI lives (toggle / run-now / edit config).
 */

interface Row {
  trigger: TriggerView;
  state: "running" | "enabled" | "disabled" | "not-ready";
  // Positive = due in N ms; negative = overdue N ms; null = no schedule
  // (disabled or never-polled-and-not-due).
  dueInMs: number | null;
}

export function SchedulerStrip(): React.ReactElement {
  const triggersQuery = useQuery({
    queryKey: ["triggers"],
    queryFn: () => api.triggers(),
    refetchInterval: 30_000,
  });
  const [showDisabled, setShowDisabled] = useState(false);

  const triggers = triggersQuery.data?.triggers ?? [];
  const now = Date.now();

  const rows: Row[] = triggers.map((t) => {
    const state: Row["state"] = t.running
      ? "running"
      : !t.enabled
        ? "disabled"
        : !t.ready
          ? "not-ready"
          : "enabled";
    // Compute next-due only for enabled+ready triggers that have polled
    // at least once. Never-polled rows would otherwise compute
    // `intervalMs - now()` (a ~57-year-overdue number) — they're not really
    // overdue, the scheduler just hasn't reached them yet, so render "—".
    let dueInMs: number | null = null;
    if (t.enabled && t.ready && !t.running && t.lastPolledAt) {
      const lastMs = new Date(t.lastPolledAt).getTime();
      const nextMs = lastMs + t.intervalMs;
      dueInMs = nextMs - now;
    }
    return { trigger: t, state, dueInMs };
  });

  // Enabled-first sort, with overdue floating above due-soon. Disabled
  // / not-ready sink to the bottom and get collapsed behind the chip.
  const visible = rows
    .filter((r) => r.state !== "disabled")
    .toSorted((a, b) => {
      // Running pins to top.
      if (a.state === "running" && b.state !== "running") return -1;
      if (b.state === "running" && a.state !== "running") return 1;
      // Then by due-in ascending (overdue = negative = smallest = top).
      const aDue = a.dueInMs ?? Number.POSITIVE_INFINITY;
      const bDue = b.dueInMs ?? Number.POSITIVE_INFINITY;
      return aDue - bDue;
    });
  const disabled = rows.filter((r) => r.state === "disabled");

  const enabledCount = rows.filter((r) => r.trigger.enabled).length;
  const overdueCount = rows.filter((r) => r.dueInMs != null && r.dueInMs < 0).length;

  return (
    <section className="flex flex-col border-b border-ink-rule">
      <div className="flex items-baseline justify-between px-6 pb-2 pt-5">
        <div className="flex items-baseline gap-3">
          <div className="ln-eyebrow">Scheduler</div>
          <div className="font-mono text-[11px] text-ink-faint">
            {enabledCount} enabled
            {overdueCount > 0 && (
              <span className="ml-2 text-[color:var(--ink-blocked-2)]">
                · {overdueCount} overdue
              </span>
            )}
          </div>
        </div>
        <Link
          to="/queue"
          className="flex items-center gap-1 font-mono text-[11px] text-ink-muted transition-colors hover:text-ink-cream"
        >
          manage <ArrowRight size={10} />
        </Link>
      </div>

      {triggersQuery.isLoading ? (
        <div>
          {Array.from({ length: 3 }, (_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="px-6 pb-6">
          <EmptyNote
            note="No triggers stored yet. Enable one on /queue and it bootstraps on the next watch tick."
            cli="open http://127.0.0.1:3030/queue"
          />
        </div>
      ) : (
        // Single table so visible + disabled rows share computed column
        // widths (a second standalone table doesn't align with the first).
        // Disabled rows render inside the same tbody, gated by `showDisabled`.
        // The toggle chip is a colspan row so semantically the disclosure
        // sits between the two row groups, not below the entire table.
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">
              <th className="px-6 py-2 text-left font-medium">trigger</th>
              <th className="py-2 text-left font-medium">state</th>
              <th className="py-2 text-left font-medium">last run</th>
              <th className="py-2 text-right font-medium">last polled</th>
              <th className="px-6 py-2 text-right font-medium">next due</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => (
              <SchedulerRow key={r.trigger.name} row={r} zebra={i % 2 === 1} />
            ))}
            {disabled.length > 0 && (
              <tr className="border-t border-ink-rule/60">
                <td colSpan={5} className="p-0">
                  <button
                    type="button"
                    onClick={() => setShowDisabled((v) => !v)}
                    aria-expanded={showDisabled}
                    aria-label={`${showDisabled ? "hide" : "show"} ${disabled.length} disabled trigger${disabled.length === 1 ? "" : "s"}`}
                    className="flex w-full items-center gap-1.5 px-6 py-2 text-left font-mono text-[11px] text-ink-faint transition-colors hover:bg-ink-surface/40 hover:text-ink-muted"
                  >
                    {showDisabled ? (
                      <ChevronDown size={11} aria-hidden="true" />
                    ) : (
                      <ChevronRight size={11} aria-hidden="true" />
                    )}
                    {disabled.length} disabled
                  </button>
                </td>
              </tr>
            )}
            {showDisabled &&
              disabled.map((r, i) => (
                <SchedulerRow key={r.trigger.name} row={r} zebra={i % 2 === 1} />
              ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function SchedulerRow({ row, zebra }: { row: Row; zebra: boolean }): React.ReactElement {
  const { trigger, state, dueInMs } = row;
  return (
    <tr
      className={cn(
        "border-t border-ink-rule/60 transition-colors duration-[var(--dur-stamp)]",
        "hover:bg-ink-surface/50",
        zebra && "bg-ink-surface/20",
      )}
    >
      <td className="px-6 py-2 font-mono text-[12px]">
        <span className={trigger.enabled ? "text-ink-cream" : "text-ink-faint"}>
          {trigger.name}
        </span>
      </td>
      <td className="py-2">
        <StatePill state={state} reason={trigger.notReadyReason} />
      </td>
      <td className="py-2 font-mono text-[11.5px] text-ink-muted">
        {summarizeRun(trigger.lastRunSummary)}
      </td>
      <td className="py-2 text-right font-mono text-[11.5px] text-ink-faint">
        {trigger.lastPolledAt ? timeAgo(trigger.lastPolledAt) : "never"}
      </td>
      <td className="px-6 py-2 text-right font-mono text-[11.5px]">
        <NextDuePill dueInMs={dueInMs} />
      </td>
    </tr>
  );
}

function StatePill({
  state,
  reason,
}: {
  state: Row["state"];
  reason: string | null;
}): React.ReactElement {
  switch (state) {
    case "running":
      return <Badge tone="signal">running</Badge>;
    case "enabled":
      return <Badge tone="receipt">enabled</Badge>;
    case "not-ready":
      return (
        <Badge tone="blocked" title={reason ?? undefined}>
          not ready
        </Badge>
      );
    case "disabled":
      return <Badge tone="neutral">disabled</Badge>;
  }
}

function NextDuePill({ dueInMs }: { dueInMs: number | null }): React.ReactElement {
  if (dueInMs == null) return <span className="text-ink-faint">—</span>;
  if (dueInMs <= 0) {
    return (
      <span className="text-[color:var(--ink-blocked-2)]">overdue {humanInterval(-dueInMs)}</span>
    );
  }
  // Soon-ish (<30m): neutral cream. Otherwise: faint. Cheap visual nudge
  // that something's about to happen.
  const cls = dueInMs < 30 * 60_000 ? "text-ink-cream-2" : "text-ink-faint";
  return <span className={cls}>in {humanInterval(dueInMs)}</span>;
}
