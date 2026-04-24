import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { ReceiptView } from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { EmptyNote } from "../components/primitives/EmptyNote.tsx";
import { Modal } from "../components/primitives/Modal.tsx";
import { Skeleton, SkeletonRow } from "../components/primitives/Skeleton.tsx";
import { cn, formatUsd, timeAgo } from "../lib/cn.ts";

export const Route = createFileRoute("/receipts")({
  component: ReceiptsPage,
});

interface DayGroup {
  key: string;
  label: string;
  count: number;
  totalCost: number;
  rows: ReceiptView[];
}

function ReceiptsPage() {
  const [activeId, setActiveId] = useState<number | null>(null);
  const receipts = useQuery({
    queryKey: ["receipts", "list"],
    queryFn: () => api.receipts({ limit: 200 }),
    refetchInterval: 20_000,
  });
  const detail = useQuery({
    queryKey: ["receipts", "detail", activeId],
    queryFn: () => (activeId == null ? Promise.resolve(null) : api.receipt(activeId)),
    enabled: activeId != null,
  });

  const groups = useMemo(() => groupByDay(receipts.data?.receipts ?? []), [receipts.data]);
  const totalCost = useMemo(
    () => (receipts.data?.receipts ?? []).reduce((a, r) => a + (r.costUsd ?? 0), 0),
    [receipts.data],
  );

  return (
    <div className="-mx-6 -my-6 flex flex-col">
      {/* Masthead */}
      <section className="flex items-end justify-between gap-4 border-b border-ink-rule px-6 pb-5 pt-6">
        <div>
          <div className="ln-eyebrow">The Ledger · Receipts</div>
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
            Signed, most recent first.
          </h1>
        </div>
        <div className="text-right font-mono text-[11px] text-ink-faint">
          {receipts.data ? (
            <>
              <div>
                <span className="text-ink-cream-2">{receipts.data.receipts.length}</span>{" "}
                <span className="text-ink-muted">shown</span>
              </div>
              <div className="mt-0.5">
                <span className="text-[color:var(--ink-spend-2)]">{formatUsd(totalCost)}</span>{" "}
                <span className="text-ink-muted">total</span>
              </div>
            </>
          ) : (
            <Skeleton lines={2} widths={["96px", "64px"]} />
          )}
        </div>
      </section>

      {/* Receipts timeline — grouped by day, newest day first */}
      <section>
        {receipts.isLoading ? (
          <div>
            {Array.from({ length: 8 }, (_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : receipts.data?.receipts.length === 0 ? (
          <div className="px-6 py-8">
            <EmptyNote
              note="No receipts yet. Every call the agent makes leaves one; one always beats zero."
              cli="oneshot-gtm motion show-hn"
            />
          </div>
        ) : (
          <div>
            {groups.map((g) => (
              <DaySection key={g.key} group={g} onClickRow={(id) => setActiveId(id)} />
            ))}
          </div>
        )}
      </section>

      <Modal
        open={activeId != null}
        title={detail.data?.receipt.playName ?? "receipt"}
        subtitle={detail.data ? `#${activeId} · ${detail.data.receipt.callType}` : `#${activeId}`}
        onClose={() => setActiveId(null)}
        width={720}
      >
        {detail.isLoading ? (
          <Skeleton lines={8} />
        ) : (
          <pre className="max-h-[60vh] overflow-auto rounded-[var(--radius-md)] border border-ink-rule bg-ink-bg-deep p-3 font-mono text-[12px] leading-[1.55] text-ink-cream-2">
            {JSON.stringify(detail.data?.receipt.signedReceipt ?? {}, null, 2)}
          </pre>
        )}
      </Modal>
    </div>
  );
}

function DaySection({ group, onClickRow }: { group: DayGroup; onClickRow: (id: number) => void }) {
  return (
    <div>
      {/* Day header — sticky so you always know which day you're scrolling through. */}
      <div className="sticky top-0 z-10 flex items-baseline justify-between border-b border-ink-rule/80 bg-ink-bg/95 px-6 py-2.5 backdrop-blur-[2px]">
        <div className="ln-eyebrow text-ink-cream-2">{group.label}</div>
        <div className="font-mono text-[11px] text-ink-faint">
          <span className="text-ink-cream-2">{group.count}</span> call
          {group.count === 1 ? "" : "s"}
          {group.totalCost > 0 && (
            <>
              {" · "}
              <span className="text-[color:var(--ink-spend-2)]">{formatUsd(group.totalCost)}</span>
            </>
          )}
        </div>
      </div>
      <table className="w-full text-[13px]">
        <tbody>
          {group.rows.map((r, i) => (
            <tr
              key={r.id}
              onClick={() => onClickRow(r.id)}
              className={cn(
                "cursor-pointer border-b border-ink-rule/50",
                "transition-colors duration-[var(--dur-stamp)]",
                "hover:bg-ink-surface/60",
                i % 2 === 1 && "bg-ink-surface/15",
              )}
            >
              <td className="w-[72px] px-6 py-2 font-mono text-[11px] text-ink-faint">#{r.id}</td>
              <td className="py-2 text-ink-cream">{r.playName}</td>
              <td className="py-2 font-mono text-[12px] text-ink-muted">{r.callType}</td>
              <td className="w-[88px] py-2 text-right font-mono text-ink-cream">
                {r.costUsd != null ? (
                  formatUsd(r.costUsd)
                ) : (
                  <span className="text-ink-faint">—</span>
                )}
              </td>
              <td className="w-[72px] py-2 text-right font-mono text-[12px] text-ink-muted">
                {timeAgo(r.createdAt)}
              </td>
              <td className="w-[200px] px-6 py-2 text-right font-mono text-[11px] text-ink-faint truncate">
                {r.oneshotRequestId ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Bucket receipts by local-calendar day. Assumes `receipts` is already in
 * reverse-chron order from the server; within a bucket we preserve that
 * order so the first row is the most recent.
 */
function groupByDay(receipts: ReceiptView[]): DayGroup[] {
  const now = new Date();
  const today = dayKey(now);
  const yesterday = (() => {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return dayKey(d);
  })();

  const groups: DayGroup[] = [];
  const byKey = new Map<string, DayGroup>();

  for (const r of receipts) {
    const d = new Date(r.createdAt);
    if (Number.isNaN(d.getTime())) continue;
    const key = dayKey(d);
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        label: formatDayLabel(d, key, today, yesterday),
        count: 0,
        totalCost: 0,
        rows: [],
      };
      byKey.set(key, g);
      groups.push(g);
    }
    g.rows.push(r);
    g.count++;
    g.totalCost += r.costUsd ?? 0;
  }
  return groups;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDayLabel(d: Date, key: string, today: string, yesterday: string): string {
  if (key === today) return "Today";
  if (key === yesterday) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}
