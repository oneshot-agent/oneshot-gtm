import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.ts";
import { cn, formatCount, formatUsd } from "../lib/cn.ts";
import { EmptyNote } from "./primitives/EmptyNote.tsx";
import { SkeletonRow } from "./primitives/Skeleton.tsx";

const DAYS = 7;

/**
 * Prospects per day over the last week, all finders summed: found by the runs,
 * queued and approved from what was found that day, sent, and spend. Today's
 * approvals (whenever the rows were found) sit against `volumeGoalPerDay`.
 */
export function ProspectsPerDaySection() {
  const q = useQuery({
    queryKey: ["measure", "funnel", DAYS],
    queryFn: () => api.measureFunnel(DAYS),
    staleTime: 60_000,
    // Polled, so a page left open past midnight moves "today" with the clock.
    refetchInterval: 60_000,
  });
  const rows = (q.data?.days ?? []).map((d) => {
    const sum = (pick: (f: (typeof d.finders)[number]) => number) =>
      d.finders.reduce((a, f) => a + pick(f), 0);
    return {
      day: d.day,
      found: sum((f) => f.candidates),
      queued: sum((f) => f.queued),
      approved: sum((f) => f.approved),
      sent: sum((f) => f.sent),
      spend: sum((f) => f.costUsd),
    };
  });
  const today = q.data?.days[0];
  const goal = q.data?.goalPerDay ?? null;
  const empty = rows.every((r) => r.found + r.queued + r.spend === 0) && !today?.approvedOnDay;

  return (
    <section className="border-b border-ink-rule">
      <div className="flex items-baseline justify-between px-6 pb-2 pt-5">
        <div className="ln-eyebrow">Prospects per day · all finders</div>
        <div className="font-mono text-[11px] text-ink-faint">
          {today
            ? goal != null
              ? `today ${formatCount(today.approvedOnDay)} / ${formatCount(goal)} approved`
              : `today ${formatCount(today.approvedOnDay)} approved`
            : `last ${DAYS}d`}
        </div>
      </div>
      {q.isLoading ? (
        Array.from({ length: 3 }, (_, i) => <SkeletonRow key={i} />)
      ) : q.isError && !q.data ? (
        <div className="px-6 pb-6 text-[13px] text-[color:var(--ink-blocked-2)]" role="alert">
          Could not load prospects per day.{" "}
          <button className="underline" onClick={() => void q.refetch()}>
            Retry
          </button>
        </div>
      ) : empty ? (
        <div className="px-6 pb-6">
          <EmptyNote
            note="No finder runs or queued prospects in the last week."
            cli="oneshot-gtm find watch"
          />
        </div>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">
              <th className="px-6 py-2 text-left font-medium">day</th>
              <th className="py-2 text-right font-medium">found</th>
              <th className="py-2 text-right font-medium">queued</th>
              <th className="py-2 text-right font-medium">approved</th>
              <th className="py-2 text-right font-medium">sent</th>
              <th className="py-2 text-right font-medium">spend</th>
              <th className="px-6 py-2 text-right font-medium">$/approved</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={r.day}
                className={cn("border-t border-ink-rule/60", i % 2 === 1 && "bg-ink-surface/20")}
              >
                <td className="px-6 py-2 font-mono text-ink-cream">{r.day}</td>
                <td className="py-2 text-right font-mono text-ink-muted">{formatCount(r.found)}</td>
                <td className="py-2 text-right font-mono text-ink-muted">
                  {formatCount(r.queued)}
                </td>
                <td className="py-2 text-right font-mono text-[color:var(--ink-receipt-2)]">
                  {formatCount(r.approved)}
                </td>
                <td className="py-2 text-right font-mono text-ink-muted">{formatCount(r.sent)}</td>
                <td className="py-2 text-right font-mono text-ink-cream">{formatUsd(r.spend)}</td>
                <td className="px-6 py-2 text-right font-mono text-ink-cream-2">
                  {r.approved > 0 ? (
                    formatUsd(r.spend / r.approved)
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
