import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { api } from "../api/client.ts";
import { CurrentRunsStrip } from "../components/home/CurrentRunsStrip.tsx";
import { HealthCard } from "../components/home/HealthCard.tsx";
import { NextStep } from "../components/home/NextStep.tsx";
import { SchedulerStrip } from "../components/home/SchedulerStrip.tsx";
import { SignalFeed } from "../components/home/SignalFeed.tsx";
import { formatUsd } from "../lib/cn.ts";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  // Drop the poll to 5s while any /run dispatch is in flight so the In-flight
  // strip's counters tick visibly (drafted/sent climb 0/N → N/N as targets
  // complete). Idle pages stay at 30s to avoid hammering the server.
  const home = useQuery({
    queryKey: ["home"],
    queryFn: api.home,
    refetchInterval: (q): number => {
      const data = q.state.data as { currentRuns?: unknown[] } | null | undefined;
      return data?.currentRuns && data.currentRuns.length > 0 ? 5_000 : 30_000;
    },
  });
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
          caption={d ? `${d.callsLast7d} agent calls · ${formatUsd(d.spendUsd30d)} 30d` : undefined}
          tone="spend"
        />
        <LedgerNumber
          label="Active cadences"
          value={d ? String(d.activeCadences) : undefined}
          caption="in flight, awaiting reply"
        />
      </section>

      {/* Install health — one line, expandable to the full grouped doctor panel */}
      <HealthCard />

      {/* In-flight /run dispatches — Resume link back to /run/<play>?runId=N */}
      <CurrentRunsStrip runs={home.data?.currentRuns ?? []} />

      {/* Signal feed — reverse-chron timeline mixing receipts and queue events */}
      <SignalFeed
        receipts={recent.data?.receipts ?? []}
        queue={queueRecent.data?.rows ?? []}
        loading={recent.isLoading || queueRecent.isLoading}
        limit={10}
      />

      <SchedulerStrip />
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
