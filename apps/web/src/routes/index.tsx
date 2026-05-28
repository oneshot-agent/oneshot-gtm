import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { api } from "../api/client.ts";
import { NextStep } from "../components/home/NextStep.tsx";
import { SchedulerStrip } from "../components/home/SchedulerStrip.tsx";
import { SignalFeed } from "../components/home/SignalFeed.tsx";
import { EmptyNote } from "../components/primitives/EmptyNote.tsx";
import { SkeletonRow } from "../components/primitives/Skeleton.tsx";
import { cn, formatUsd, timeAgo } from "../lib/cn.ts";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const home = useQuery({ queryKey: ["home"], queryFn: api.home, refetchInterval: 30_000 });
  const recent = useQuery({
    queryKey: ["receipts", "recent"],
    queryFn: () => api.receipts({ limit: 16 }),
    refetchInterval: 15_000,
  });
  const queueRecent = useQuery({
    queryKey: ["queue", "recent", "home"],
    queryFn: () => api.queue({ limit: 16 }),
    refetchInterval: 30_000,
  });
  const d = home.data;

  return (
    <div className="-mx-6 -my-6 flex flex-col">
      {/* Masthead — newspaper-style, no card */}
      <section className="border-b border-ink-rule px-6 pb-5 pt-6">
        <div className="flex items-end justify-between gap-6">
          <div>
            <div className="ln-eyebrow">The Ledger · Today</div>
            <h1
              className="mt-1 text-ink-cream"
              style={{
                fontFamily: "var(--font-display)",
                fontSize: 44,
                letterSpacing: "-0.025em",
                lineHeight: 0.98,
                fontWeight: 600,
              }}
            >
              Signed, in ink.
            </h1>
          </div>
          <div className="hidden text-right font-mono text-[11px] text-ink-faint md:block">
            {new Date().toLocaleDateString(undefined, {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
            <div className="mt-0.5">refresh · 30s</div>
          </div>
        </div>
      </section>

      {/* Onboarding nudge — disappears when ICP set + finder run + drain done. */}
      <NextStep />

      {/* KPI strip — 4 columns divided by vertical hairlines. No cards. */}
      <section className="grid grid-cols-2 divide-x divide-ink-rule border-b border-ink-rule lg:grid-cols-4">
        <LedgerNumber
          label="Replied · 7d"
          value={d ? String(d.repliedLast7d) : undefined}
          caption="reply · the only metric that matters"
          tone="receipt"
        />
        <LedgerNumber
          label="Sent · 7d"
          value={d ? String(d.sentLast7d) : undefined}
          caption="drafts, linted, stamped"
        />
        <LedgerNumber
          label="Spend · 7d"
          value={d ? formatUsd(d.spendUsd7d) : undefined}
          caption={d ? `${d.callsLast7d} OneShot calls` : undefined}
          tone="spend"
        />
        <LedgerNumber
          label="Active cadences"
          value={d ? String(d.activeCadences) : undefined}
          caption="in flight, awaiting reply"
        />
      </section>

      {/* Signal feed — reverse-chron timeline mixing receipts and queue events */}
      <SignalFeed
        receipts={recent.data?.receipts ?? []}
        queue={queueRecent.data?.rows ?? []}
        loading={recent.isLoading || queueRecent.isLoading}
        limit={10}
      />

      {/* Scheduler — per-trigger last-run + next-due strip */}
      <SchedulerStrip />

      {/* Receipts ledger — full-bleed table, no card, newspaper-style */}
      <section className="flex flex-col border-b border-ink-rule">
        <div className="flex items-baseline justify-between px-6 pb-2 pt-5">
          <div className="ln-eyebrow">Recent receipts</div>
          <Link
            to="/receipts"
            className="flex items-center gap-1 font-mono text-[11px] text-ink-muted transition-colors hover:text-ink-cream"
          >
            all <ArrowRight size={10} />
          </Link>
        </div>
        {recent.isLoading ? (
          <div>
            {Array.from({ length: 5 }, (_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : recent.data?.receipts.length === 0 ? (
          <div className="px-6 pb-6">
            <EmptyNote
              note="No receipts yet. Every call the agent makes leaves one — a short ledger is an honest ledger."
              cli="oneshot-gtm motion show-hn"
            />
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                <th className="px-6 py-2 text-left font-medium">id</th>
                <th className="py-2 text-left font-medium">play</th>
                <th className="py-2 text-left font-medium">type</th>
                <th className="py-2 text-right font-medium">cost</th>
                <th className="px-6 py-2 text-right font-medium">when</th>
              </tr>
            </thead>
            <tbody>
              {recent.data?.receipts.map((r, i) => (
                <tr
                  key={r.id}
                  className={cn(
                    "border-t border-ink-rule/60 transition-colors duration-[var(--dur-stamp)]",
                    "hover:bg-ink-surface/50",
                    i % 2 === 1 && "bg-ink-surface/20",
                  )}
                >
                  <td className="px-6 py-2 font-mono text-[11px] text-ink-faint">#{r.id}</td>
                  <td className="py-2 text-ink-cream">{r.playName}</td>
                  <td className="py-2 font-mono text-[12px] text-ink-muted">{r.callType}</td>
                  <td className="py-2 text-right font-mono text-ink-cream">
                    {r.costUsd != null ? (
                      formatUsd(r.costUsd)
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                  <td className="px-6 py-2 text-right font-mono text-[12px] text-ink-faint">
                    {timeAgo(r.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Editorial footnote — the "why" of spend, no card */}
      <section className="grid grid-cols-1 gap-8 px-6 py-8 lg:grid-cols-[1fr_280px]">
        <div className="max-w-[58ch]">
          <div className="ln-eyebrow">Editor's note</div>
          <p className="ln-prose mt-2 max-w-[58ch] text-[14.5px] text-ink-cream-2">
            Spend is the cost of proof. Every send came with a signed receipt; every receipt keeps
            you honest with yourself. A short ledger is an honest ledger — one send always beats
            zero.
          </p>
        </div>
        <div className="border-l border-ink-rule pl-6">
          <div className="ln-eyebrow">Spend · 30d</div>
          <div className="mt-1 text-ink-cream ln-numeral" style={{ fontSize: 36, lineHeight: 1 }}>
            {d ? formatUsd(d.spendUsd30d) : <span className="text-ink-faint">$—</span>}
          </div>
          <div className="mt-2 font-mono text-[11px] text-ink-muted">
            {d ? `${d.callsLast7d} calls this week` : "…"}
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * A single KPI in ledger-column style. No card chrome — just a column of
 * eyebrow label, big numeral, and caption underneath, separated from
 * neighbours by the vertical hairline on the parent grid.
 */
function LedgerNumber({
  label,
  value,
  caption,
  tone = "neutral",
}: {
  label: string;
  value: string | undefined;
  caption?: string;
  /** A subtle caption tint — the number itself stays cream. */
  tone?: "neutral" | "spend" | "receipt";
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
        style={{ fontSize: 44, lineHeight: 1 }}
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
