import { Explain } from "../components/primitives/Explain.tsx";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { ReceiptView } from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { Button } from "../components/primitives/Button.tsx";
import { EmptyNote } from "../components/primitives/EmptyNote.tsx";
import { SkeletonRow } from "../components/primitives/Skeleton.tsx";
import { Sparkline } from "../components/primitives/Sparkline.tsx";
import { cn, formatCount, formatUsd } from "../lib/cn.ts";
import { Pii } from "../components/primitives/Pii.tsx";

export const Route = createFileRoute("/measure")({
  staticData: { title: "Measure" },
  component: MeasurePage,
});

const RANGES = [
  { label: "all-time", value: undefined },
  { label: "30d", value: 30 },
  { label: "7d", value: 7 },
] as const;

function MeasurePage() {
  const [sinceDays, setSinceDays] = useState<number | undefined>(undefined);
  const cac = useQuery({
    queryKey: ["measure", "cac", sinceDays],
    queryFn: () => api.measureCac(sinceDays),
  });
  const rocs = useQuery({
    queryKey: ["measure", "rocs", sinceDays],
    queryFn: () => api.measureRocs(sinceDays),
  });
  // Per-cadence RoCS from OneShot's goal-level rollup. Hits the platform, so it
  // can lag the local tables; degrades to empty when the wallet/network is down.
  const byGoal = useQuery({
    queryKey: ["measure", "rocs-by-goal", sinceDays],
    queryFn: () => api.rocsByGoal(sinceDays),
    staleTime: 30_000,
  });

  // Daily spend per play for the sparklines, bucketed by the server. This used
  // to list 500 receipts and bucket them here, which quietly became a five-hour
  // window on any install carrying tens of thousands of them.
  const sparkDays = Math.min(90, Math.max(7, sinceDays ?? 30));
  const series = useQuery({
    queryKey: ["measure", "spend-series", sparkDays],
    queryFn: () => api.measureSpendSeries(sparkDays),
    staleTime: 60_000,
  });

  const spendSeries = useMemo(() => {
    const out = new Map<string, number[]>();
    for (const s of series.data?.series ?? []) out.set(s.playName, s.spend);
    return out;
  }, [series.data]);

  const totalSpend = cac.data?.spend.reduce((a, s) => a + s.totalUsd, 0) ?? 0;
  const totalReplied = cac.data?.events.reduce((a, e) => a + e.replied, 0) ?? 0;
  const totalSent = cac.data?.events.reduce((a, e) => a + e.sent, 0) ?? 0;
  const totalWon = rocs.data?.outcomes.reduce((a, o) => a + o.won, 0) ?? 0;

  /*
   * The one ratio on this page that divides every dollar spent, not just the
   * winner's own cadence. The RoCS-by-cadence table below is goal-level: it
   * puts a closed deal over the handful of calls that produced it and ignores
   * every prospect the play spent money on and never closed, which is why those
   * multiples run four digits. This one is the program: all closed-won revenue
   * over all signed spend in the window.
   */
  const totalWonValue = rocs.data?.outcomes.reduce((a, o) => a + o.wonValueUsd, 0) ?? 0;
  const programRocs = totalSpend > 0 ? totalWonValue / totalSpend : 0;

  return (
    <div className="-mx-6 -my-6 flex flex-col">
      <section className="flex items-end justify-between gap-4 border-b border-ink-rule px-6 pb-5 pt-6">
        <div>
          <div className="ln-eyebrow">The Ledger · Measure</div>
          <h1
            className="mt-1 text-ink-cream"
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 44,
              fontWeight: 600,
              letterSpacing: "-0.025em",
              lineHeight: 0.98,
            }}
          >
            $ per reply, per meeting, per won.
          </h1>
        </div>
        <div className="flex items-center gap-1.5">
          {RANGES.map((r) => (
            <Button
              key={r.label}
              variant={sinceDays === r.value ? "primary" : "secondary"}
              size="sm"
              onClick={() => setSinceDays(r.value)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-2 divide-x divide-ink-rule border-b border-ink-rule md:grid-cols-5">
        <Summary
          label="Total spend"
          value={cac.data ? formatUsd(totalSpend) : undefined}
          tone="spend"
        />
        <Summary
          label="Sent"
          value={cac.data ? formatCount(totalSent) : undefined}
          caption={cac.data ? `all plays, ${rangeLabel(sinceDays)}` : undefined}
        />
        <Summary
          label="Replied"
          value={cac.data ? formatCount(totalReplied) : undefined}
          caption={
            cac.data && totalSent > 0
              ? `${((totalReplied / totalSent) * 100).toFixed(1)}% reply rate`
              : undefined
          }
          tone="receipt"
        />
        <Summary
          label="Won"
          value={rocs.data ? formatCount(totalWon) : undefined}
          caption={rocs.data ? `${formatUsd(totalWonValue)} closed` : undefined}
        />
        <Summary
          label="Return"
          value={
            rocs.data && cac.data && programRocs > 0 ? `${programRocs.toFixed(1)}×` : undefined
          }
          caption={
            rocs.data && cac.data && totalWon > 0
              ? `${formatUsd(totalSpend / totalWon)} per won deal`
              : undefined
          }
          tone="receipt"
        />
      </section>

      <section className="border-b border-ink-rule">
        <div className="flex items-baseline justify-between px-6 pb-2 pt-5">
          <div className="ln-eyebrow">CAC by play · signed receipts</div>
          <div className="font-mono text-[11px] text-ink-faint">{rangeLabel(sinceDays)}</div>
        </div>
        {cac.isLoading ? (
          Array.from({ length: 3 }, (_, i) => <SkeletonRow key={i} />)
        ) : cac.data?.spend.length === 0 ? (
          <div className="px-6 pb-6">
            <EmptyNote
              note="No spend in this window. Find prospects from /queue's finder flow, or run the watcher; spend appears after calls run."
              cli="oneshot-gtm find watch"
            />
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                <th className="px-6 py-2 text-left font-medium">play</th>
                <th className="py-2 text-left font-medium">spend · {sparkDays}d</th>
                <th className="py-2 text-right font-medium">spend</th>
                <th className="py-2 text-right font-medium">calls</th>
                <th className="py-2 text-right font-medium">sent</th>
                <th className="py-2 text-right font-medium">replied</th>
                <th className="py-2 text-right font-medium">$/send</th>
                <th className="px-6 py-2 text-right font-medium">$/reply</th>
              </tr>
            </thead>
            <tbody>
              {cac.data?.spend.map((s, i) => {
                const ev = cac.data.events.find((e) => e.playName === s.playName);
                const sent = ev?.sent ?? 0;
                const replied = ev?.replied ?? 0;
                const series = spendSeries.get(s.playName) ?? [];
                return (
                  <tr
                    key={s.playName}
                    className={cn(
                      "border-t border-ink-rule/60",
                      i % 2 === 1 && "bg-ink-surface/20",
                    )}
                  >
                    <td className="px-6 py-2 text-ink-cream">{s.playName}</td>
                    <td className="py-2">
                      {series.length > 1 ? (
                        <Sparkline
                          values={series}
                          tone="spend"
                          width={96}
                          height={22}
                          aria-label={`${s.playName} spend over last ${sparkDays} days`}
                        />
                      ) : (
                        <span className="font-mono text-[11px] text-ink-faint">—</span>
                      )}
                    </td>
                    <td className="py-2 text-right font-mono text-ink-cream">
                      {formatUsd(s.totalUsd)}
                    </td>
                    <td className="py-2 text-right font-mono text-ink-muted">
                      {formatCount(s.calls)}
                    </td>
                    <td className="py-2 text-right font-mono text-ink-muted">
                      {formatCount(sent)}
                    </td>
                    <td className="py-2 text-right font-mono text-ink-muted">
                      {formatCount(replied)}
                    </td>
                    <td className="py-2 text-right font-mono text-ink-cream-2">
                      {sent > 0 ? (
                        formatUsd(s.totalUsd / sent)
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td className="px-6 py-2 text-right font-mono text-[color:var(--ink-receipt-2)]">
                      {replied > 0 ? (
                        formatUsd(s.totalUsd / replied)
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="border-b border-ink-rule">
        <div className="flex items-baseline justify-between px-6 pb-2 pt-5">
          <div className="ln-eyebrow">
            RoCS · return on cognitive spend <Explain concept="rocs" />
          </div>
          <div className="font-mono text-[11px] text-ink-faint">{rangeLabel(sinceDays)}</div>
        </div>
        {rocs.isLoading ? (
          Array.from({ length: 3 }, (_, i) => <SkeletonRow key={i} />)
        ) : rocs.data?.spend.length === 0 ? (
          <div className="px-6 pb-6">
            <EmptyNote note="No spend in this window to attribute to outcomes yet." />
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                <th className="px-6 py-2 text-left font-medium">play</th>
                <th className="py-2 text-left font-medium">spend · {sparkDays}d</th>
                <th className="py-2 text-right font-medium">spend</th>
                <th className="py-2 text-right font-medium">meetings</th>
                <th className="py-2 text-right font-medium">
                  SQLs <Explain concept="sql" />
                </th>
                <th className="py-2 text-right font-medium">won</th>
                <th className="py-2 text-right font-medium">
                  $/meeting <Explain concept="costMeeting" />
                </th>
                <th className="px-6 py-2 text-right font-medium">
                  $/won <Explain concept="costWon" />
                </th>
              </tr>
            </thead>
            <tbody>
              {rocs.data?.spend.map((s, i) => {
                const oc = rocs.data.outcomes.find((o) => o.playName === s.playName);
                const meet = oc?.meetings ?? 0;
                const sql = oc?.sqls ?? 0;
                const won = oc?.won ?? 0;
                const series = spendSeries.get(s.playName) ?? [];
                return (
                  <tr
                    key={s.playName}
                    className={cn(
                      "border-t border-ink-rule/60",
                      i % 2 === 1 && "bg-ink-surface/20",
                    )}
                  >
                    <td className="px-6 py-2 text-ink-cream">{s.playName}</td>
                    <td className="py-2">
                      {series.length > 1 ? (
                        <Sparkline
                          values={series}
                          tone="spend"
                          width={96}
                          height={22}
                          aria-label={`${s.playName} spend over last ${sparkDays} days`}
                        />
                      ) : (
                        <span className="font-mono text-[11px] text-ink-faint">—</span>
                      )}
                    </td>
                    <td className="py-2 text-right font-mono text-ink-cream">
                      {formatUsd(s.totalUsd)}
                    </td>
                    <td className="py-2 text-right font-mono text-ink-muted">
                      {formatCount(meet)}
                    </td>
                    <td className="py-2 text-right font-mono text-ink-muted">{formatCount(sql)}</td>
                    <td className="py-2 text-right font-mono text-[color:var(--ink-receipt-2)]">
                      {formatCount(won)}
                    </td>
                    <td className="py-2 text-right font-mono text-ink-cream-2">
                      {meet > 0 ? (
                        formatUsd(s.totalUsd / meet)
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td className="px-6 py-2 text-right font-mono text-[color:var(--ink-receipt-2)]">
                      {won > 0 ? (
                        formatUsd(s.totalUsd / won)
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* RoCS by cadence — OneShot's goal-level rollup (spend vs tagged value) */}
      <section className="border-b border-ink-rule">
        <div className="flex items-baseline justify-between px-6 pb-2 pt-5">
          <div className="ln-eyebrow">RoCS by cadence · goal-level</div>
          <div className="font-mono text-[11px] text-ink-faint">{rangeLabel(sinceDays)}</div>
        </div>
        {byGoal.isLoading ? (
          Array.from({ length: 3 }, (_, i) => <SkeletonRow key={i} />)
        ) : (byGoal.data?.goals.length ?? 0) === 0 ? (
          <div className="px-6 pb-6">
            <EmptyNote note="No cadence value attributed yet. As replies and deals get tagged, each cadence's spend-vs-value lands here." />
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                <th className="px-6 py-2 text-left font-medium">cadence</th>
                <th className="py-2 text-right font-medium">spend</th>
                <th className="py-2 text-right font-medium">value</th>
                <th className="py-2 text-right font-medium">pending</th>
                <th className="py-2 text-right font-medium">calls</th>
                <th className="px-6 py-2 text-right font-medium">RoCS</th>
              </tr>
            </thead>
            <tbody>
              {[...(byGoal.data?.goals ?? [])]
                .toSorted((a, b) => b.value - a.value || b.rocs - a.rocs)
                .map((g, i) => (
                  <tr
                    key={g.goalId}
                    className={cn(
                      "border-t border-ink-rule/60",
                      i % 2 === 1 && "bg-ink-surface/20",
                    )}
                  >
                    <td className="px-6 py-2 text-ink-cream">
                      <span>{g.playName ?? "—"}</span>
                      {g.prospect && (
                        <span className="ml-1.5 font-mono text-[11px] text-ink-muted">
                          → <Pii kind="auto">{g.prospect}</Pii>
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right font-mono text-ink-cream">
                      {formatUsd(g.spend)}
                    </td>
                    <td className="py-2 text-right font-mono text-[color:var(--ink-receipt-2)]">
                      {g.value > 0 ? formatUsd(g.value) : <span className="text-ink-faint">—</span>}
                    </td>
                    <td className="py-2 text-right font-mono text-ink-muted">
                      {g.pendingValue > 0 ? (
                        formatUsd(g.pendingValue)
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td className="py-2 text-right font-mono text-ink-muted">
                      {formatCount(g.receiptCount)}
                    </td>
                    <td className="px-6 py-2 text-right font-mono text-[color:var(--ink-receipt-2)]">
                      {g.spend > 0 && g.rocs > 0 ? (
                        `${g.rocs.toFixed(1)}×`
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
    </div>
  );
}

/**
 * Group receipts by play and compute a daily spend histogram (oldest → newest).
 * Returns a Map keyed by playName. Receipts without a `costUsd` value are
 * skipped. Days beyond `windowDays` are dropped.
 */
function buildSpendSeries(receipts: ReceiptView[], windowDays: number): Map<string, number[]> {
  const days = Math.max(7, Math.min(windowDays, 90));
  const now = Date.now();
  const DAY_MS = 24 * 3600 * 1000;
  const out = new Map<string, number[]>();

  for (const r of receipts) {
    if (r.costUsd == null) continue;
    const ts = new Date(r.createdAt).getTime();
    if (Number.isNaN(ts)) continue;
    const daysAgo = Math.floor((now - ts) / DAY_MS);
    if (daysAgo < 0 || daysAgo >= days) continue;
    const idx = days - 1 - daysAgo;
    let arr = out.get(r.playName);
    if (!arr) {
      arr = Array.from({ length: days }, () => 0);
      out.set(r.playName, arr);
    }
    arr[idx] = (arr[idx] ?? 0) + r.costUsd;
  }
  return out;
}

function Summary({
  label,
  value,
  caption,
  tone = "neutral",
}: {
  label: string;
  value: string | undefined;
  caption?: string;
  /** Caption tint only; the number itself stays cream. */
  tone?: "neutral" | "receipt" | "spend";
}) {
  const captionColor =
    tone === "spend"
      ? "var(--ink-spend-2)"
      : tone === "receipt"
        ? "var(--ink-receipt-2)"
        : "var(--ink-faint)";
  return (
    <div className="px-5 py-4">
      <div className="ln-eyebrow">{label}</div>
      <div
        className="mt-1 truncate text-ink-cream ln-numeral"
        style={{ fontSize: 34, lineHeight: 1 }}
      >
        {value ?? <span className="text-ink-faint">—</span>}
      </div>
      {caption && (
        <div className="mt-2 truncate font-mono text-[11px]" style={{ color: captionColor }}>
          {caption}
        </div>
      )}
    </div>
  );
}

function rangeLabel(s: number | undefined): string {
  if (s === undefined) return "all-time";
  return `last ${s}d`;
}
