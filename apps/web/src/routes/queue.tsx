import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, ChevronDown, ChevronRight, Pencil, Play, Send, Target, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { QueueRowView, QueueStatusView, TriggerView } from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { Badge } from "../components/primitives/Badge.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { EmptyNote } from "../components/primitives/EmptyNote.tsx";
import { Field, Input, Textarea } from "../components/primitives/Field.tsx";
import { Modal } from "../components/primitives/Modal.tsx";
import { SkeletonRow } from "../components/primitives/Skeleton.tsx";
import { Toggle } from "../components/primitives/Toggle.tsx";
import { cn, timeAgo } from "../lib/cn.ts";
import {
  clearTriggerRunning,
  hasAnyRunningTrigger,
  humanDuration,
  markTriggerRunning,
  useRunningTriggers,
} from "../lib/triggerRunState.ts";

export const Route = createFileRoute("/queue")({
  component: QueuePage,
});

const STATUSES: Array<QueueStatusView | "all"> = [
  "all",
  "pending",
  "approved",
  "rejected",
  "sent",
  "expired",
];

const DRAINABLE_PLAYS = [
  "show-hn",
  "job-change",
  "post-funding",
  "accelerator-batch",
  "hiring-signal",
  "podcast-guest",
];

function statusTone(
  status: QueueStatusView,
): "receipt" | "spend" | "blocked" | "signal" | "neutral" {
  switch (status) {
    case "pending":
      return "spend";
    case "approved":
      return "receipt";
    case "rejected":
      return "blocked";
    case "sent":
      return "signal";
    case "expired":
      return "neutral";
  }
}

interface RejectModalState {
  id: number;
  email: string;
}

interface DrainModalState {
  playName: string;
  approvedCount: number;
}

interface EditingState {
  name: string;
  text: string;
  defaultConfig: Record<string, unknown> | null;
}

function QueuePage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<QueueStatusView | "all">("pending");
  const [playFilter, setPlayFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [rejectModal, setRejectModal] = useState<RejectModalState | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [drainModal, setDrainModal] = useState<DrainModalState | null>(null);
  const [drainLimit, setDrainLimit] = useState(10);
  const [drainSenderCohort, setDrainSenderCohort] = useState("");
  const [drainOffer, setDrainOffer] = useState("");
  const [drainDryRun, setDrainDryRun] = useState(true);

  const queueQuery = useQuery({
    queryKey: ["queue", statusFilter, playFilter],
    queryFn: () =>
      api.queue({
        ...(statusFilter !== "all" ? { status: statusFilter } : {}),
        ...(playFilter !== "all" ? { play: playFilter } : {}),
        limit: 200,
      }),
    refetchInterval: 20_000,
  });

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ["queue"] });
    void qc.invalidateQueries({ queryKey: ["home"] });
  };

  const approve = useMutation({
    mutationFn: (id: number) => api.approveQueue(id),
    onSuccess: invalidate,
    onError: (err) => toast.error(`couldn't approve · ${err.message}`),
  });
  const reject = useMutation({
    mutationFn: (vars: { id: number; reason?: string }) => api.rejectQueue(vars.id, vars.reason),
    onSuccess: () => {
      setRejectModal(null);
      setRejectReason("");
      invalidate();
    },
    onError: (err) => toast.error(`couldn't reject · ${err.message}`),
  });
  const approveAll = useMutation({
    mutationFn: (play?: string) => api.approveAllQueue(play),
    onSuccess: (data) => {
      invalidate();
      toast.success(`approved ${data.approved} pending`);
    },
    onError: (err) => toast.error(`couldn't approve all · ${err.message}`),
  });

  // Bulk selection mutations — operate over the current `selected` set.
  const bulkApprove = useMutation({
    mutationFn: async (ids: number[]) => {
      let ok = 0;
      for (const id of ids) {
        try {
          await api.approveQueue(id);
          ok++;
        } catch {
          // continue the batch; surface the count at the end
        }
      }
      return { ok, total: ids.length };
    },
    onSuccess: ({ ok, total }) => {
      setSelected(new Set());
      invalidate();
      toast.success(`approved ${ok} of ${total}`);
    },
  });
  const bulkReject = useMutation({
    mutationFn: async (ids: number[]) => {
      let ok = 0;
      for (const id of ids) {
        try {
          await api.rejectQueue(id);
          ok++;
        } catch {
          /* ignore */
        }
      }
      return { ok, total: ids.length };
    },
    onSuccess: ({ ok, total }) => {
      setSelected(new Set());
      invalidate();
      toast.success(`rejected ${ok} of ${total}`);
    },
  });
  const drain = useMutation({
    mutationFn: () => {
      if (!drainModal) throw new Error("no drain modal open");
      return api.drainQueue({
        playName: drainModal.playName,
        limit: drainLimit,
        dryRun: drainDryRun,
        ...(drainSenderCohort ? { senderCohort: drainSenderCohort } : {}),
        ...(drainOffer ? { freeForCohortOffer: drainOffer } : {}),
      });
    },
    onSuccess: () => {
      setDrainModal(null);
      setDrainSenderCohort("");
      setDrainOffer("");
      void qc.invalidateQueries({ queryKey: ["queue"] });
      void qc.invalidateQueries({ queryKey: ["receipts"] });
      void qc.invalidateQueries({ queryKey: ["cadences"] });
      void qc.invalidateQueries({ queryKey: ["home"] });
    },
  });

  const counts = queueQuery.data?.counts ?? {
    pending: 0,
    approved: 0,
    rejected: 0,
    sent: 0,
    expired: 0,
  };
  const rows = queueQuery.data?.rows ?? [];

  const playList = Array.from(new Set(rows.map((r) => r.playName))).toSorted();

  // Selection derived state — stable across renders even if rows refetch.
  const someSelected = selected.size > 0;
  const allSelected = rows.length > 0 && selected.size === rows.length;

  return (
    <div className="-mx-6 -my-6 flex flex-col">
      {/* Masthead */}
      <section className="flex items-end justify-between gap-4 border-b border-ink-rule px-6 pb-5 pt-6">
        <div>
          <div className="ln-eyebrow">The Ledger · Queue</div>
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
            Candidates, for review.
          </h1>
        </div>
        <div className="font-mono text-[11px] text-ink-faint">
          {Object.entries(counts)
            .map(([k, v]) => `${k} ${v}`)
            .join(" · ")}
        </div>
      </section>

      <IcpBanner />

      {/* Filter bar */}
      <section className="flex flex-wrap items-center gap-2 border-b border-ink-rule px-6 py-3">
        <span className="ln-eyebrow">status</span>
        {STATUSES.map((s) => (
          <Button
            key={s}
            variant={statusFilter === s ? "primary" : "ghost"}
            size="sm"
            onClick={() => setStatusFilter(s)}
          >
            {s}
          </Button>
        ))}
        <span className="mx-2 h-4 w-px bg-ink-rule" />
        <span className="ln-eyebrow">play</span>
        <Button
          variant={playFilter === "all" ? "primary" : "ghost"}
          size="sm"
          onClick={() => setPlayFilter("all")}
        >
          all
        </Button>
        {playList.map((p) => (
          <Button
            key={p}
            variant={playFilter === p ? "primary" : "ghost"}
            size="sm"
            onClick={() => setPlayFilter(p)}
          >
            {p}
          </Button>
        ))}
      </section>

      {/* Bulk action bar */}
      <section className="flex flex-wrap items-center gap-2 border-b border-ink-rule bg-ink-surface/30 px-6 py-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={approveAll.isPending || counts.pending === 0}
          onClick={() => approveAll.mutate(playFilter === "all" ? undefined : playFilter)}
        >
          <Check size={12} /> approve all pending{playFilter !== "all" ? ` (${playFilter})` : ""}
        </Button>
        {DRAINABLE_PLAYS.map((p) => (
          <Button
            key={p}
            variant="ghost"
            size="sm"
            disabled={
              counts.approved === 0 ||
              (playFilter !== "all" && playFilter !== p) ||
              !rows.some((r) => r.playName === p && r.status === "approved")
            }
            onClick={() =>
              setDrainModal({
                playName: p,
                approvedCount: rows.filter((r) => r.playName === p && r.status === "approved")
                  .length,
              })
            }
          >
            <Send size={12} /> drain {p}
          </Button>
        ))}
      </section>

      <TriggersCard />

      {/* Queue ledger */}
      <section className="border-b border-ink-rule">
        <div className="flex items-baseline justify-between px-6 pb-2 pt-5">
          <div className="ln-eyebrow">
            {queueQuery.data ? (
              <>
                {rows.length} <span className="text-ink-faint">row(s)</span>
              </>
            ) : (
              <span className="text-ink-faint">…</span>
            )}
          </div>
          <div className="font-mono text-[11px] text-ink-faint">refresh · 20s</div>
        </div>

        {/* 7-day signal strip — enqueues per day from the rows in memory. */}
        {rows.length > 0 && <SignalStrip rows={rows} />}

        {queueQuery.isLoading ? (
          Array.from({ length: 5 }, (_, i) => <SkeletonRow key={i} />)
        ) : rows.length === 0 ? (
          <EmptyQueueHelp filterActive={statusFilter !== "pending" || playFilter !== "all"} />
        ) : (
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 z-10 bg-ink-bg">
              <tr className="border-b border-ink-rule text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                <th className="w-6 py-2" />
                <th className="w-6 py-2">
                  <label className="inline-flex cursor-pointer items-center">
                    <input
                      type="checkbox"
                      className="h-[13px] w-[13px] rounded-[var(--radius-xs)] border border-ink-rule bg-ink-bg-deep accent-[color:var(--ink-signal)]"
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someSelected && !allSelected;
                      }}
                      onChange={(e) =>
                        setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
                      }
                      aria-label={allSelected ? "deselect all" : "select all"}
                    />
                  </label>
                </th>
                <th className="px-6 py-2 text-left font-medium">id</th>
                <th className="py-2 text-left font-medium">prospect</th>
                <th className="py-2 text-left font-medium">play</th>
                <th className="py-2 text-left font-medium">status</th>
                <th className="py-2 text-left font-medium">source</th>
                <th className="py-2 text-right font-medium">found</th>
                <th className="px-6 py-2 text-right font-medium">actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <QueueRow
                  key={row.id}
                  row={row}
                  zebra={i % 2 === 1}
                  expanded={expanded === row.id}
                  selected={selected.has(row.id)}
                  anySelected={someSelected}
                  onToggleSelect={() => {
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(row.id)) next.delete(row.id);
                      else next.add(row.id);
                      return next;
                    });
                  }}
                  onToggle={() => setExpanded(expanded === row.id ? null : row.id)}
                  onApprove={() => approve.mutate(row.id)}
                  onReject={() =>
                    setRejectModal({ id: row.id, email: emailFor(row.payload) ?? `#${row.id}` })
                  }
                  busy={approve.isPending || reject.isPending}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Sticky bulk-action bar — only when something is selected */}
      {someSelected && (
        <div className="sticky bottom-0 z-20 flex items-center justify-between gap-4 border-b border-t border-ink-rule bg-ink-bg/95 px-6 py-3 backdrop-blur-[2px]">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-6 min-w-[24px] items-center justify-center rounded-full bg-[color:var(--ink-signal)]/20 px-2 font-mono text-[12px] text-[color:var(--ink-signal-2)]">
              {selected.size}
            </span>
            <span className="text-[13px] text-ink-cream-2">
              {selected.size === 1 ? "row selected" : "rows selected"}
            </span>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="font-mono text-[11px] text-ink-faint underline decoration-ink-rule underline-offset-2 hover:text-ink-cream hover:decoration-ink-cream-2"
            >
              clear
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              disabled={bulkApprove.isPending || selected.size === 0}
              onClick={() => bulkApprove.mutate([...selected])}
            >
              <Check size={12} /> approve {selected.size}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={bulkReject.isPending || selected.size === 0}
              onClick={() => bulkReject.mutate([...selected])}
            >
              <X size={12} /> reject {selected.size}
            </Button>
          </div>
        </div>
      )}

      <Modal
        open={rejectModal != null}
        onClose={() => setRejectModal(null)}
        title={`Reject #${rejectModal?.id} — ${rejectModal?.email ?? ""}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejectModal(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                rejectModal &&
                reject.mutate({ id: rejectModal.id, reason: rejectReason || undefined })
              }
              disabled={reject.isPending}
            >
              {reject.isPending ? "Rejecting…" : "Reject"}
            </Button>
          </>
        }
      >
        <Field label="Reason (optional, logged for ICP-filter learning)">
          <Textarea
            rows={3}
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="e.g. wrong stage, wrong industry, already a customer"
          />
        </Field>
      </Modal>

      <Modal
        open={drainModal != null}
        onClose={() => setDrainModal(null)}
        title={`Drain ${drainModal?.playName ?? ""} (${drainModal?.approvedCount ?? 0} approved)`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDrainModal(null)}>
              Cancel
            </Button>
            <Button onClick={() => drain.mutate()} disabled={drain.isPending}>
              <Send size={12} />
              {drain.isPending
                ? "Draining…"
                : drainDryRun
                  ? "Preview drain (no send)"
                  : `Send up to ${drainLimit}`}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Limit">
            <Input
              type="number"
              min={1}
              value={drainLimit}
              onChange={(e) => setDrainLimit(Math.max(1, Number.parseInt(e.target.value, 10) || 1))}
            />
          </Field>
          {drainModal?.playName === "accelerator-batch" && (
            <>
              <Field
                label="Sender cohort (required)"
                hint="Your accelerator/cohort tag, e.g. yc-w23"
              >
                <Input
                  value={drainSenderCohort}
                  onChange={(e) => setDrainSenderCohort(e.target.value)}
                  placeholder="yc-w23"
                  required
                />
              </Field>
              <Field label="Free-for-cohort offer (optional)">
                <Input
                  value={drainOffer}
                  onChange={(e) => setDrainOffer(e.target.value)}
                  placeholder="Free for current YC W26 through demo day, just reply with your batch."
                />
              </Field>
            </>
          )}
          <label className="inline-flex cursor-pointer items-center gap-2.5 text-[13px] text-ink-cream-2 hover:text-ink-cream">
            <Toggle checked={drainDryRun} onChange={setDrainDryRun} label="dry run" />
            <span>Dry run — preview drafts, no send, no spend</span>
          </label>
          {drain.isError && (
            <div className="font-mono text-[11.5px] text-[color:var(--ink-blocked-2)]">
              {drain.error.message}
            </div>
          )}
          {drain.data && (
            <div className="font-mono text-[11.5px] text-[color:var(--ink-receipt-2)]">
              {drainDryRun
                ? `would send ${drain.data.sent} of ${drain.data.drained}`
                : `sent ${drain.data.sent} of ${drain.data.drained}`}
              {drain.data.errors.length > 0 && (
                <div className="mt-1 text-[color:var(--ink-blocked-2)]">
                  {drain.data.errors.length} error(s) ·{" "}
                  {drain.data.errors.map((e) => e.message).join(" · ")}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

function QueueRow({
  row,
  zebra,
  expanded,
  selected,
  anySelected,
  onToggleSelect,
  onToggle,
  onApprove,
  onReject,
  busy,
}: {
  row: QueueRowView;
  zebra: boolean;
  expanded: boolean;
  selected: boolean;
  anySelected: boolean;
  onToggleSelect: () => void;
  onToggle: () => void;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  const email = emailFor(row.payload);
  const name = nameFor(row.payload);
  const company = companyFor(row.payload);
  return (
    <>
      <tr
        className={cn(
          "group cursor-pointer border-b border-ink-rule/60",
          "transition-colors duration-[var(--dur-stamp)]",
          "hover:bg-ink-surface/60",
          zebra && "bg-ink-surface/20",
          selected && "bg-[color:var(--ink-signal)]/8",
        )}
        onClick={onToggle}
      >
        <td className="w-6 py-2 pl-4 pr-0 text-ink-faint">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </td>
        <td className="w-6 py-2" onClick={(e) => e.stopPropagation()}>
          <label className="inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              className={cn(
                "h-[13px] w-[13px] rounded-[var(--radius-xs)]",
                "border border-ink-rule bg-ink-bg-deep accent-[color:var(--ink-signal)]",
                // Hide until the row is hovered OR any other row is selected —
                // so the default look stays clean, but once you start selecting
                // the checkboxes stay visible for rapid batch picking.
                "transition-opacity duration-[var(--dur-stamp)]",
                selected || anySelected
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100 focus:opacity-100",
              )}
              checked={selected}
              onChange={onToggleSelect}
              aria-label={selected ? `deselect #${row.id}` : `select #${row.id}`}
            />
          </label>
        </td>
        <td className="px-6 py-2 font-mono text-[11px] text-ink-faint">#{row.id}</td>
        <td className="py-2">
          <div className="text-ink-cream">{name ?? "(unknown)"}</div>
          <div className="font-mono text-[11px] text-ink-faint">
            {email ?? "—"}
            {company ? ` · ${company}` : ""}
          </div>
        </td>
        <td className="py-2 text-ink-cream-2">{row.playName}</td>
        <td className="py-2">
          <Badge tone={statusTone(row.status)}>{row.status}</Badge>
        </td>
        <td className="py-2 font-mono text-[11px] text-ink-faint">{row.source}</td>
        <td className="py-2 text-right font-mono text-[12px] text-ink-muted">
          {timeAgo(row.foundAt)}
        </td>
        <td className="px-6 py-2 text-right" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-end gap-1">
            {row.status === "pending" && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  title="approve"
                  disabled={busy}
                  onClick={onApprove}
                >
                  <Check size={12} />
                </Button>
                <Button variant="ghost" size="sm" title="reject" disabled={busy} onClick={onReject}>
                  <X size={12} />
                </Button>
              </>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-ink-rule/60 bg-ink-bg-deep/50">
          <td colSpan={9} className="px-6 py-3">
            <div className="text-[12px] text-ink-muted">
              {row.notes ? <div className="mb-2 ln-note">{row.notes}</div> : null}
              <pre className="max-h-[300px] overflow-auto rounded-[var(--radius-sm)] border border-ink-rule bg-ink-bg-deep p-3 font-mono text-[11.5px] leading-[1.55] text-ink-cream-2">
                {JSON.stringify(row.payload, null, 2)}
              </pre>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * 7-day signal strip — renders a tight row of daily-enqueue bars computed
 * client-side from `rows`. It's an approximate readout (limited to the
 * rows currently in memory) but gives a quick visual pulse without any
 * new API.
 */
function SignalStrip({ rows }: { rows: QueueRowView[] }) {
  const days = buildSignalDays(rows);
  const max = Math.max(1, ...days.map((d) => d.count));
  const total = days.reduce((a, d) => a + d.count, 0);

  return (
    <div className="flex items-center gap-4 border-b border-ink-rule/60 bg-ink-bg-deep/40 px-6 py-2.5">
      <div className="ln-eyebrow" style={{ fontSize: 10 }}>
        last 7d
      </div>
      <div className="flex items-end gap-1" aria-hidden="true">
        {days.map((d) => {
          const h = Math.round((d.count / max) * 20);
          return (
            <span
              key={d.label}
              title={`${d.label} · ${d.count} enqueued`}
              className={cn(
                "w-[10px] rounded-[1px]",
                d.count === 0 ? "bg-ink-rule" : "bg-[color:var(--ink-signal)]/70",
              )}
              style={{ height: Math.max(2, h) }}
            />
          );
        })}
      </div>
      <div className="font-mono text-[11px] text-ink-muted">
        {total} enqueued
        <span className="ml-2 text-ink-faint">
          · newest <span className="text-ink-cream-2">
            {days[days.length - 1]?.count ?? 0}
          </span>{" "}
          today
        </span>
      </div>
    </div>
  );
}

/** Compute a 7-day histogram (oldest → newest) of enqueues. */
function buildSignalDays(rows: QueueRowView[]): Array<{ label: string; count: number }> {
  const now = new Date();
  const days: Array<{ label: string; count: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push({
      label: d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
      count: 0,
    });
  }
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 6);
  for (const r of rows) {
    const ts = new Date(r.foundAt);
    if (Number.isNaN(ts.getTime())) continue;
    if (ts < cutoff) continue;
    const idx = 6 - Math.floor((now.getTime() - ts.getTime()) / (24 * 3600 * 1000));
    if (idx >= 0 && idx < 7) {
      const day = days[idx];
      if (day) day.count += 1;
    }
  }
  return days;
}

function TriggersCard() {
  const qc = useQueryClient();
  const triggersQuery = useQuery({
    queryKey: ["triggers"],
    queryFn: () => api.triggers(),
    // Poll every 5s whenever any trigger is believed running (localStorage
    // flag set anywhere) so a refresh-resumed spinner clears within seconds
    // of the server writing lastPolledAt. Otherwise a leisurely 30s.
    refetchInterval: () => (hasAnyRunningTrigger() ? 5_000 : 30_000),
  });
  const setEnabled = useMutation({
    mutationFn: (vars: { name: string; enabled: boolean }) =>
      api.setTriggerEnabled(vars.name, vars.enabled),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["triggers"] }),
  });
  const setConfig = useMutation({
    mutationFn: (vars: { name: string; config: unknown }) =>
      api.setTriggerConfig(vars.name, vars.config),
    onSuccess: () => {
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ["triggers"] });
    },
  });
  const runTrigger = useMutation({
    mutationFn: (name: string) => {
      // Persist "this trigger is now running" before the network call so a
      // refresh mid-flight can rebuild the spinner state from localStorage.
      markTriggerRunning(name);
      return api.runTrigger(name);
    },
    onSuccess: (data, name) => {
      clearTriggerRunning(name);
      void qc.invalidateQueries({ queryKey: ["triggers"] });
      void qc.invalidateQueries({ queryKey: ["queue"] });
      void qc.invalidateQueries({ queryKey: ["home"] });
      if (data.error) {
        toast.error(`${name} · ${data.error}`);
        return;
      }
      const r = data.result;
      if (!r) {
        toast.success(`${name} · ran`);
        return;
      }
      const parts = [
        `${r.candidates} candidates`,
        `${r.enqueued} kept`,
        r.droppedIcp ? `${r.droppedIcp} icp-drop` : null,
        r.droppedDuplicate ? `${r.droppedDuplicate} dup` : null,
        r.droppedEnrichment ? `${r.droppedEnrichment} enrich-fail` : null,
        `$${r.costUsd.toFixed(2)}`,
        r.halted ? `halted: ${r.halted}` : null,
      ].filter(Boolean);
      toast.success(`${name} · ${parts.join(" · ")}`);
    },
    onError: (err, name) => {
      clearTriggerRunning(name);
      toast.error(`${name} · ${err.message}`);
    },
  });

  const [editing, setEditing] = useState<EditingState | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const triggers = triggersQuery.data?.triggers ?? [];

  // Cross-refresh "is running" tracker — pulls from localStorage and clears
  // entries whose work the server has already confirmed done.
  const lastPolledByName = new Map<string, string | null>(
    triggers.map((t) => [t.name, t.lastPolledAt]),
  );
  const runningByName = useRunningTriggers(
    triggers.map((t) => t.name),
    lastPolledByName,
  );

  return (
    <>
      <section className="border-b border-ink-rule">
        <div className="flex items-baseline justify-between px-6 pb-2 pt-5">
          <div className="ln-eyebrow">
            Triggers <span className="text-ink-faint">· {triggers.length}</span>
          </div>
          <div className="font-mono text-[11px] text-ink-faint">refresh · 30s</div>
        </div>
        {triggersQuery.isLoading ? (
          Array.from({ length: 3 }, (_, i) => <SkeletonRow key={i} />)
        ) : triggers.length === 0 ? (
          <div className="px-6 pb-6">
            <EmptyNote
              note="No triggers stored yet. Enable one below and it bootstraps itself on the next watch tick — or run the watch loop once to initialise."
              cli="oneshot-gtm find watch --once"
            />
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-ink-rule/60 text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                <th className="px-6 py-2 text-left font-medium">name</th>
                <th className="py-2 text-left font-medium">enabled</th>
                <th className="py-2 text-left font-medium">interval</th>
                <th className="py-2 text-left font-medium">last polled</th>
                <th className="py-2 text-left font-medium">last run</th>
                <th className="px-6 py-2 text-right font-medium">actions</th>
              </tr>
            </thead>
            <tbody>
              {triggers.map((t, i) => {
                const summary = summarizeRun(t.lastRunSummary);
                const inProcess = runTrigger.isPending && runTrigger.variables === t.name;
                const crossRefresh = runningByName.get(t.name);
                const running = inProcess || crossRefresh != null;
                const elapsedMs = crossRefresh?.elapsedMs ?? null;
                const isEditing = editing?.name === t.name;
                return (
                  <TriggerRowFragment
                    key={t.name}
                    trigger={t}
                    zebra={i % 2 === 1}
                    running={running}
                    elapsedMs={elapsedMs}
                    summary={summary}
                    isEditing={Boolean(isEditing)}
                    editing={isEditing ? editing : null}
                    editError={isEditing ? editError : null}
                    onToggleEnabled={(next) => setEnabled.mutate({ name: t.name, enabled: next })}
                    onRun={() => runTrigger.mutate(t.name)}
                    onStartEdit={() => {
                      setEditing({
                        name: t.name,
                        text: JSON.stringify(t.config ?? {}, null, 2),
                        defaultConfig: t.defaultConfig,
                      });
                      setEditError(null);
                    }}
                    onCancelEdit={() => {
                      setEditing(null);
                      setEditError(null);
                    }}
                    onChangeEditText={(text) =>
                      setEditing((prev) => (prev ? { ...prev, text } : prev))
                    }
                    onResetDefaults={() =>
                      setEditing((prev) =>
                        prev
                          ? {
                              ...prev,
                              text: JSON.stringify(prev.defaultConfig ?? {}, null, 2),
                            }
                          : prev,
                      )
                    }
                    onSaveEdit={() => {
                      if (!editing) return;
                      let parsed: unknown;
                      try {
                        parsed = JSON.parse(editing.text);
                      } catch (err) {
                        setEditError(`invalid JSON: ${(err as Error).message}`);
                        return;
                      }
                      if (!parsed || typeof parsed !== "object") {
                        setEditError("config must be a JSON object");
                        return;
                      }
                      setEditError(null);
                      setConfig.mutate({ name: editing.name, config: parsed });
                    }}
                    setEnabledPending={setEnabled.isPending}
                    setConfigPending={setConfig.isPending}
                  />
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

interface TriggerRowProps {
  trigger: TriggerView;
  zebra: boolean;
  running: boolean;
  /** ms elapsed since the cross-refresh start; null when only in-process. */
  elapsedMs: number | null;
  summary: string;
  isEditing: boolean;
  editing: EditingState | null;
  editError: string | null;
  onToggleEnabled: (next: boolean) => void;
  onRun: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onChangeEditText: (text: string) => void;
  onResetDefaults: () => void;
  onSaveEdit: () => void;
  setEnabledPending: boolean;
  setConfigPending: boolean;
}

function TriggerRowFragment(props: TriggerRowProps) {
  const t = props.trigger;
  return (
    <>
      <tr
        className={cn(
          "group relative border-b border-ink-rule/60",
          "transition-colors duration-[var(--dur-stamp)]",
          props.zebra && "bg-ink-surface/20",
          !t.enabled && "opacity-65",
          "hover:bg-ink-surface/50",
          props.isEditing && "bg-ink-surface/50",
        )}
      >
        <td className="relative px-6 py-2 font-mono text-[12px]">
          {t.enabled && (
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-0 w-[2px] bg-[color:var(--ink-signal)]/60"
            />
          )}
          <span className={t.enabled ? "text-ink-cream" : "text-ink-muted"}>{t.name}</span>
        </td>
        <td className="py-2">
          <Toggle
            checked={t.enabled}
            disabled={props.setEnabledPending}
            label={`${t.enabled ? "disable" : "enable"} ${t.name}`}
            onChange={props.onToggleEnabled}
          />
        </td>
        <td className="py-2 font-mono text-[12px] text-ink-muted">
          {humanInterval(t.intervalMs)}
          {t.intervalMs !== t.defaultIntervalMs && (
            <span className="ml-1 text-ink-faint">
              · default {humanInterval(t.defaultIntervalMs)}
            </span>
          )}
        </td>
        <td className="py-2 font-mono text-[12px] text-ink-muted">
          {t.lastPolledAt ? timeAgo(t.lastPolledAt) : "never"}
        </td>
        <td className="py-2 font-mono text-[11.5px] text-ink-muted">{props.summary}</td>
        <td className="px-6 py-2 text-right">
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={props.running}
              onClick={props.onRun}
              title="Run this finder now — ignores schedule, spends OneShot $"
            >
              <Play size={12} className={props.running ? "animate-pulse" : undefined} />
              {props.running
                ? props.elapsedMs != null
                  ? `running · ${humanDuration(props.elapsedMs)}`
                  : "running…"
                : "run now"}
            </Button>
            <Button
              variant={props.isEditing ? "secondary" : "ghost"}
              size="sm"
              title={props.isEditing ? "close config" : "edit config"}
              aria-label={`${props.isEditing ? "close" : "edit"} ${t.name} config`}
              onClick={props.isEditing ? props.onCancelEdit : props.onStartEdit}
            >
              <Pencil size={12} />
            </Button>
          </div>
        </td>
      </tr>
      {props.isEditing && props.editing && (
        <tr className="border-b border-ink-rule/60 bg-ink-bg-deep/60">
          <td colSpan={6} className="px-6 py-4">
            <div className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between gap-3">
                <div className="ln-eyebrow">
                  config ·{" "}
                  <span className="text-ink-cream-2 normal-case font-mono tracking-normal">
                    {t.name}
                  </span>
                </div>
                <div className="ln-note text-[12px] text-ink-cream-2">
                  add{" "}
                  <code className="ln-mono text-[11.5px] text-[color:var(--ink-signal-2)]">
                    "intervalMs"
                  </code>{" "}
                  to override the watch cadence · min 60000
                </div>
              </div>
              <Textarea
                rows={8}
                value={props.editing.text}
                onChange={(e) => props.onChangeEditText(e.target.value)}
                className="font-mono text-[12px]"
                spellCheck={false}
              />
              <div className="flex items-center justify-between gap-2">
                <div className="font-mono text-[11.5px] text-[color:var(--ink-blocked-2)]">
                  {props.editError ?? ""}
                </div>
                <div className="flex items-center gap-1.5">
                  {props.editing.defaultConfig && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={props.onResetDefaults}
                      disabled={props.setConfigPending}
                      title="Replace the textarea with the registry default config"
                    >
                      reset
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={props.onCancelEdit}
                    disabled={props.setConfigPending}
                  >
                    cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={props.onSaveEdit}
                    disabled={props.setConfigPending}
                  >
                    {props.setConfigPending ? "saving…" : "save"}
                  </Button>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function IcpBanner() {
  const setupQuery = useQuery({ queryKey: ["setup"], queryFn: () => api.setupStatus() });
  const icp = setupQuery.data?.cfg.icpOneLiner ?? null;
  if (setupQuery.isLoading) return null;

  if (!icp || icp.trim().length === 0) {
    return (
      <section className="flex items-start gap-3 border-b border-ink-rule bg-[color:var(--ink-spend)]/6 px-6 py-4">
        <Target size={14} className="mt-[3px] shrink-0 text-[color:var(--ink-spend-2)]" />
        <div className="flex-1">
          <div className="ln-eyebrow" style={{ color: "var(--ink-spend-2)" }}>
            Set your ICP first
          </div>
          <div className="ln-note mt-0.5 text-[13px] text-ink-cream-2">
            The find layer needs a free-text ICP one-liner to filter candidates. Without it, every
            result passes through and you'll review more noise than signal.
          </div>
        </div>
        <Link to="/setup">
          <Button size="sm">Open setup</Button>
        </Link>
      </section>
    );
  }

  return (
    <section className="flex items-start gap-3 border-b border-ink-rule px-6 py-3">
      <Target size={14} className="mt-[3px] shrink-0 text-[color:var(--ink-receipt-2)]" />
      <div className="flex-1 min-w-0">
        <div className="ln-eyebrow">ICP</div>
        <div className="mt-0.5 truncate text-[13px] text-ink-cream-2">{icp}</div>
      </div>
      <Link to="/setup">
        <Button variant="ghost" size="sm">
          edit
        </Button>
      </Link>
    </section>
  );
}

function EmptyQueueHelp({ filterActive }: { filterActive: boolean }) {
  if (filterActive) {
    return (
      <div className="p-5">
        <EmptyNote note="No queue rows match this filter. Try a different status or play above to see other rows." />
      </div>
    );
  }
  return (
    <div className="p-5">
      <EmptyNote
        note="No targets yet. Pick a finder from the Triggers panel and run it — candidates land here for review before any send."
        cli="oneshot-gtm find watch"
      />
    </div>
  );
}

function summarizeRun(summary: unknown): string {
  if (!summary || typeof summary !== "object") return "—";
  const s = summary as Record<string, unknown>;
  if (typeof s["error"] === "string") return `error: ${(s["error"] as string).slice(0, 60)}`;
  const parts: string[] = [];
  if (typeof s["candidates"] === "number") parts.push(`cand=${s["candidates"]}`);
  if (typeof s["enqueued"] === "number") parts.push(`kept=${s["enqueued"]}`);
  if (typeof s["droppedIcp"] === "number") parts.push(`icp=${s["droppedIcp"]}`);
  if (typeof s["costUsd"] === "number") {
    parts.push(`$${(s["costUsd"] as number).toFixed(2)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function humanInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  const hours = ms / 3600_000;
  if (hours >= 48) return `${(hours / 24).toFixed(hours % 24 === 0 ? 0 : 1)}d`;
  return `${hours.toFixed(hours % 1 === 0 ? 0 : 1)}h`;
}

function emailFor(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p["email"] === "string") return p["email"] as string;
  if (typeof p["founderEmail"] === "string") return p["founderEmail"] as string;
  return null;
}

function nameFor(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p["name"] === "string") return p["name"] as string;
  if (typeof p["founderName"] === "string") return p["founderName"] as string;
  return null;
}

function companyFor(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p["company"] === "string") return p["company"] as string;
  return null;
}
