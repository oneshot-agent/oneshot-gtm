import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Play,
  RotateCw,
  Send,
  Target,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { humanInterval } from "../lib/humanInterval.ts";
import {
  clearDraftGenerating,
  markDraftGenerating,
  useGeneratingDrafts,
} from "../lib/draftRunState.ts";
import { buildSignalDays } from "../lib/signalDays.ts";
import { summarizeRun } from "../lib/summarizeRun.ts";
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

// Finder-fed plays whose queue rows can be drained. github-topics routes
// candidates to stack-consolidation (vendor sprawl) or competitor-switch
// (when a detected vendor is on its directCompetitors list), so both appear.
const DRAINABLE_PLAYS = [
  "show-hn",
  "job-change",
  "post-funding",
  "accelerator-batch",
  "hiring-signal",
  "podcast-guest",
  "competitor-switch",
  "stack-consolidation",
  "repo-interest",
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
  const navigate = useNavigate();
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
  // Drain modal submit → navigate to /run/<play>?fromQueue=1&… instead of
  // hitting POST /api/queue/drain. The drain endpoint dropped draft content
  // on the floor (counts only); the /run page streams every draft live with
  // its lint flags so partial batches and lint-blocked sends are visible.
  // Both dryRun and real-send paths route through here — the founder picks
  // mode via the modal toggle and /run honors it via the URL param.
  const submitDrainViaRun = (): void => {
    if (!drainModal) return;
    const search: Record<string, string> = {
      fromQueue: "1",
      limit: String(drainLimit),
      dryRun: drainDryRun ? "1" : "0",
    };
    if (drainSenderCohort.trim()) search["senderCohort"] = drainSenderCohort.trim();
    if (drainOffer.trim()) search["freeForCohortOffer"] = drainOffer.trim();
    void navigate({
      to: "/run/$playName",
      params: { playName: drainModal.playName },
      search,
    });
  };

  const counts = queueQuery.data?.counts ?? {
    pending: 0,
    approved: 0,
    rejected: 0,
    sent: 0,
    expired: 0,
  };
  const rows = queueQuery.data?.rows ?? [];

  // Per-row "generating draft" spinners, reconstructed from localStorage so they
  // survive navigating away + back (the regenerate mutation's isPending is local
  // to the row and dies on unmount). Cleared when `lastDraftedAt` advances.
  const generating = useGeneratingDrafts(
    rows.map((r) => r.id),
    new Map(rows.map((r) => [r.id, r.lastDraftedAt])),
  );

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

      <TriggersCard />

      {/* Target Queue — the candidates themselves. A heavier rule + explicit
          section header separates this from the Triggers table above (which
          was reading as a seamless continuation of the same list). Play
          filter lives inline here: it narrows the rows in this table
          specifically, so it belongs next to them, not in the global bar. */}
      <section className="border-t-2 border-ink-rule">
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 pb-3 pt-5">
          <div className="flex items-baseline gap-3">
            <div className="ln-eyebrow">
              Target Queue{" "}
              <span className="text-ink-faint">
                · {queueQuery.data ? rows.length : "…"} row{rows.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>
          <div className="font-mono text-[11px] text-ink-faint">refresh · 20s</div>
        </div>

        {/* Status + play filters, inline with the table they scope. Status
            is first (it narrows far more rows than play) and the two are
            visually separated by a thin rule for scannability. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-rule/60 px-6 pb-3">
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
        </div>

        {/* Bulk actions — approve-all + per-play drain. Colocated with the
            table they act on; respects the current play filter so clicking
            "approve all pending" while a play is selected scopes down. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-rule/60 bg-ink-surface/30 px-6 py-3">
          <Button
            variant="secondary"
            size="sm"
            disabled={approveAll.isPending || counts.pending === 0}
            onClick={() => approveAll.mutate(playFilter === "all" ? undefined : playFilter)}
          >
            <Check size={12} /> approve all pending
            {playFilter !== "all" ? ` (${playFilter})` : ""}
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
                  generating={generating.has(row.id)}
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
            <Button onClick={submitDrainViaRun}>
              <Send size={12} />
              {drainDryRun ? "Preview drafts (no send)" : `Send up to ${drainLimit}`}
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
                label="Sender cohort (optional)"
                hint="Overrides the cohort stamped on each row. Leave blank to use the row's own (set on the trigger)."
              >
                <Input
                  value={drainSenderCohort}
                  onChange={(e) => setDrainSenderCohort(e.target.value)}
                  placeholder="e.g. yc-w23 · od-2 · (leave blank)"
                />
              </Field>
              <Field label="Free-for-cohort offer (optional)">
                <Input
                  value={drainOffer}
                  onChange={(e) => setDrainOffer(e.target.value)}
                  placeholder="e.g. Free for your batch through demo day — reply with your cohort."
                />
              </Field>
            </>
          )}
          <label className="inline-flex cursor-pointer items-center gap-2.5 text-[13px] text-ink-cream-2 hover:text-ink-cream">
            <Toggle checked={drainDryRun} onChange={setDrainDryRun} label="dry run" />
            <span>Dry run — preview drafts only, no send (a one-time enrich lookup may apply)</span>
          </label>
          <p className="font-mono text-[11px] text-ink-faint">
            Drafts stream live on the next page — every lint flag and send confirmation is visible
            per row.
          </p>
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
  generating,
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
  generating: boolean;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  const email = emailFor(row.payload);
  const name = nameFor(row.payload);
  const company = companyFor(row.payload);
  const linkedinUrl = linkedinUrlFor(row.payload);
  const phone = phoneFor(row.payload);
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
            {linkedinUrl ? (
              <a
                href={linkedinUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-1 text-ink-cream-2 underline decoration-ink-rule underline-offset-2 hover:text-ink-cream hover:decoration-ink-cream-2"
                onClick={(e) => e.stopPropagation()}
              >
                [in]
              </a>
            ) : null}
            {phone ? <span className="ml-1 text-ink-faint">· {phone}</span> : null}
          </div>
        </td>
        <td className="py-2 text-ink-cream-2">{row.playName}</td>
        <td className="py-2">
          <div className="flex items-center gap-1.5">
            <Badge tone={statusTone(row.status)}>{row.status}</Badge>
            {row.status !== "sent" && row.lastDraft && (
              <Badge
                tone={
                  row.lastDraft.sent
                    ? "receipt"
                    : row.lastDraft.flags.length > 0
                      ? "blocked"
                      : "neutral"
                }
                title={
                  row.lastDraft.sent
                    ? "draft sent"
                    : row.lastDraft.flags.length > 0
                      ? `draft held · ${row.lastDraft.flags.length} flag(s)`
                      : "draft preview"
                }
              >
                draft
              </Badge>
            )}
          </div>
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
            <div className="flex flex-col gap-3 text-[12px] text-ink-muted">
              {row.notes ? <div className="ln-note">{row.notes}</div> : null}
              <DraftSection
                id={row.id}
                status={row.status}
                draft={row.lastDraft}
                draftedAt={row.lastDraftedAt}
                generating={generating}
                isSending={row.isSending}
              />
              <details className="text-ink-faint">
                <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.14em] hover:text-ink-cream-2">
                  payload json
                </summary>
                <pre className="mt-2 max-h-[300px] overflow-auto rounded-[var(--radius-sm)] border border-ink-rule bg-ink-bg-deep p-3 font-mono text-[11.5px] leading-[1.55] text-ink-cream-2">
                  {JSON.stringify(row.payload, null, 2)}
                </pre>
              </details>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Expanded-row draft area. Shows the persisted draft (subject + body + lint
 * flags + send state + receipt links) when one exists, with a regenerate
 * action; when none exists yet, shows a thin "no draft" bar with a generate
 * action. Both actions hit the same preview-only endpoint (dry-run, never
 * sends). Hidden for already-sent drafts (re-rolling would only overwrite the
 * preview). All plays are self-contained now — accelerator-batch rows carry
 * their senderCohort (stamped from trigger config), so they generate inline too.
 */
function DraftSection({
  id,
  status,
  draft,
  draftedAt,
  generating,
  isSending,
}: {
  id: number;
  status: QueueStatusView;
  draft: QueueRowView["lastDraft"];
  draftedAt: string | null;
  generating: boolean;
  /**
   * True when the server's `target_queue.send_started_at` marker is set —
   * survives nav-away-and-back AND `bun --watch` reloads, unlike the
   * mutation's local `isPending`. Cleared on terminal status flip.
   */
  isSending: boolean;
}): React.ReactElement {
  const qc = useQueryClient();
  const regenerate = useMutation({
    mutationFn: () => api.regenerateDraft(id),
    // Persist a localStorage marker so the spinner survives leaving + returning
    // to /queue while the draft generates server-side; cleared on settle (and,
    // for the unmounted case, reconciled away once lastDraftedAt advances).
    onMutate: () => markDraftGenerating(id),
    onSuccess: () => {
      clearDraftGenerating(id);
      void qc.invalidateQueries({ queryKey: ["queue"] });
      toast.success("draft ready · preview only, not sent");
    },
    onError: (err) => {
      clearDraftGenerating(id);
      toast.error(`couldn't draft · ${err.message}`);
    },
  });
  // Instant spinner while mounted (isPending) OR restored-from-localStorage
  // after a remount (generating).
  const isGenerating = generating || regenerate.isPending;
  const send = useMutation({
    mutationFn: () => api.sendDraft(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["queue"] });
      toast.success("sent · the reviewed draft went out as-is");
    },
    onError: (err) => {
      // Always refetch on failure too: a stale already-sent row (or one claimed
      // by another tab / in-flight) self-corrects — the row flips to `sent` and
      // the button disappears — instead of leaving a dead-end click to repeat.
      void qc.invalidateQueries({ queryKey: ["queue"] });
      if (err.message.includes("already sent")) toast.success("already sent ✓");
      else toast.error(`couldn't send · ${err.message}`);
    },
  });
  // Combine the local mutation spinner with the server-persisted `isSending`
  // flag so the spinner survives navigate-away-and-back AND server restart.
  // Hoisted above canDraft so the regenerate gate uses the same definition as
  // the send button below (asymmetry would re-open the UX window between
  // send.mutate() firing and the queue refetch landing the server marker).
  const sending = send.isPending || isSending;
  // Once the row is sent (or a send is in flight), the server rejects
  // regenerate (queue.ts guards: row.status === "sent" → 400; send_started_at
  // != null → 409). Hide the button client-side too so post-send stale rows
  // (draft.sent=false but status=sent) and mid-send rows don't tempt a click
  // that would error. Gate on `sending` (not just `isSending`) so the mid-
  // mutation window (send.mutate() fired but server marker not yet refetched)
  // is also covered — symmetric with the sendButton's own gate below.
  const canDraft = status !== "sent" && !sending && !(draft?.sent ?? false);
  const verb = draft ? "regenerate" : "generate draft";
  const pendingVerb = draft ? "regenerating…" : "generating…";
  const draftButton = canDraft ? (
    <Button
      variant="ghost"
      size="sm"
      disabled={isGenerating}
      onClick={() => regenerate.mutate()}
      title="Draft this row in preview mode — dry-run, never sends"
    >
      {isGenerating ? <Loader2 size={11} className="animate-spin" /> : <RotateCw size={11} />}
      {isGenerating ? pendingVerb : verb}
    </Button>
  ) : null;

  // Send THIS prospect now, using the reviewed draft VERBATIM (no LLM re-roll).
  // Enabled only for an approved row with a clean (lint-flag-free), not-yet-sent
  // draft — that's the review gate: regenerate until clean, then send exactly
  // that. Disabled (with a hint) when there's no draft or it's flagged.
  const cleanDraft = draft != null && draft.flags.length === 0 && !draft.sent;
  const sendButton =
    status === "approved" && !(draft?.sent ?? false) ? (
      <Button
        variant="secondary"
        size="sm"
        disabled={sending || !cleanDraft}
        onClick={() => send.mutate()}
        title={
          cleanDraft
            ? "Send this prospect now — sends the reviewed draft above, as-is"
            : draft == null
              ? "Generate a draft first, then send it"
              : "Draft has lint flags — regenerate to clear them, then send"
        }
      >
        {sending ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
        {sending ? "sending…" : "send this one"}
      </Button>
    ) : null;

  if (!draft) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-dashed border-ink-rule bg-ink-bg-deep px-3 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
          no draft yet
        </span>
        <span className="flex items-center gap-2">
          {sendButton}
          {draftButton}
        </span>
      </div>
    );
  }

  const tone: "receipt" | "spend" | "blocked" | "neutral" = draft.sent
    ? "receipt"
    : draft.flags.length > 0
      ? "blocked"
      : draft.dryRun
        ? "spend"
        : "neutral";
  const stateLabel = draft.sent
    ? "sent"
    : draft.flags.length > 0
      ? "held · lint"
      : draft.dryRun
        ? "preview"
        : "drafted";
  // Row was sent but lastDraft.sent is false → a post-send regenerate landed
  // before the server-side guard was added. The card body is NOT the email
  // that went out (the original is only in the prospect's inbox now).
  const isStalePostSend = status === "sent" && !draft.sent;
  const headerLabel = draft.sent ? "sent" : "last draft";
  return (
    <div className="rounded-[var(--radius-sm)] border border-ink-rule bg-ink-bg-deep">
      <div className="flex items-center gap-2 border-b border-ink-rule/60 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        <span>{headerLabel}</span>
        {draftedAt ? <span className="text-ink-muted">· {timeAgo(draftedAt)}</span> : null}
        <Badge tone={tone}>{stateLabel}</Badge>
        {isStalePostSend && <Badge tone="blocked">post-send regenerate · not sent</Badge>}
        {draft.flags.length > 0 &&
          draft.flags.map((f) => (
            <Badge key={f} tone="blocked">
              {f}
            </Badge>
          ))}
        <span className="ml-auto flex items-center gap-2 normal-case tracking-normal">
          {draft.receiptIds.map((rid) => (
            <Link
              key={rid}
              to="/receipts"
              className="font-mono text-[10px] text-ink-faint underline decoration-ink-rule underline-offset-2 hover:text-ink-cream-2"
            >
              receipt #{rid}
            </Link>
          ))}
          {sendButton}
          {draftButton}
        </span>
      </div>
      <div className="px-3 py-2.5">
        <div className="text-[13px] font-medium text-ink-cream">{draft.subject}</div>
        <pre className="mt-2 max-h-[360px] overflow-auto whitespace-pre-wrap font-mono text-[11.5px] leading-[1.55] text-ink-cream-2">
          {draft.body}
        </pre>
      </div>
    </div>
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
          · <span className="text-ink-cream-2">{days[days.length - 1]?.count ?? 0}</span> today
        </span>
      </div>
    </div>
  );
}

function TriggersCard() {
  const qc = useQueryClient();
  const triggersQuery = useQuery({
    queryKey: ["triggers"],
    queryFn: () => api.triggers(),
    // Poll 5s while anything is running (local marker OR server `running`), 30s otherwise.
    refetchInterval: (query) => {
      if (hasAnyRunningTrigger()) return 5_000;
      const data = query.state.data;
      if (data?.triggers.some((t) => t.running)) return 5_000;
      return 30_000;
    },
  });
  const setEnabled = useMutation({
    mutationFn: (vars: { name: string; enabled: boolean }) =>
      api.setTriggerEnabled(vars.name, vars.enabled),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["triggers"] }),
    onError: (err) => toast.error(err.message),
  });
  const setConfig = useMutation({
    mutationFn: (vars: { name: string; config: unknown }) =>
      api.setTriggerConfig(vars.name, vars.config),
    onSuccess: () => {
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ["triggers"] });
    },
    onError: (err) => toast.error(err.message),
  });
  const runTrigger = useMutation({
    mutationFn: (name: string) => {
      markTriggerRunning(name);
      return api.runTrigger(name);
    },
    onSuccess: (data, name) => {
      void qc.invalidateQueries({ queryKey: ["triggers"] });
      if (data.pending) {
        toast.success(`${name} · started`, {
          description: "polling for results",
        });
        return;
      }
      clearTriggerRunning(name);
      void qc.invalidateQueries({ queryKey: ["queue"] });
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
      // 409 = server already running it — keep the local marker so the
      // spinner stays lit until the authoritative `running` flag clears.
      if (err.message.includes("already running")) {
        void qc.invalidateQueries({ queryKey: ["triggers"] });
        toast.info(`${name} · already running`);
        return;
      }
      clearTriggerRunning(name);
      toast.error(`${name} · ${err.message}`);
    },
  });

  const [editing, setEditing] = useState<EditingState | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const triggers = triggersQuery.data?.triggers ?? [];

  // Invalidate queue/home the moment any trigger's `running` flips true → false.
  const runningKey = triggers
    .filter((t) => t.running)
    .map((t) => t.name)
    .toSorted()
    .join(",");
  const prevRunningRef = useRef<string>("");
  useEffect(() => {
    const prev = prevRunningRef.current;
    prevRunningRef.current = runningKey;
    const prevNames = prev ? prev.split(",") : [];
    const nowNames = runningKey ? runningKey.split(",") : [];
    const stillRunning = new Set(nowNames);
    if (prevNames.some((n) => !stillRunning.has(n))) {
      void qc.invalidateQueries({ queryKey: ["queue"] });
    }
  }, [runningKey, qc]);

  const lastPolledByName = new Map<string, string | null>(
    triggers.map((t) => [t.name, t.lastPolledAt]),
  );
  const serverRunningSinceByName = new Map<string, string | null>(
    triggers.map((t) => [t.name, t.runningSince]),
  );
  const runningByName = useRunningTriggers(
    triggers.map((t) => t.name),
    lastPolledByName,
    serverRunningSinceByName,
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
                // `inProcess` covers the sub-millisecond window before the 202 lands;
                // `tracked` takes over via localStorage + server `runningSince`.
                const inProcess = runTrigger.isPending && runTrigger.variables === t.name;
                const tracked = runningByName.get(t.name);
                const running = inProcess || tracked != null;
                const elapsedMs = tracked?.elapsedMs ?? null;
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
  // Missing `ready` field = treat as ready (tolerate older servers).
  const notReady = t.ready === false;
  const notReadyReason = t.notReadyReason ?? "missing required config";
  // Block enabling an unready trigger but still allow disabling.
  const toggleDisabled = props.setEnabledPending || (notReady && !t.enabled);
  const runDisabled = props.running || notReady;
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
          props.running && "bg-[color:var(--ink-signal)]/[0.08]",
        )}
      >
        <td className="relative px-6 py-2 font-mono text-[12px]">
          {props.running ? (
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-0 w-[2px] bg-[color:var(--ink-signal)] animate-pulse"
            />
          ) : (
            t.enabled && (
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 w-[2px] bg-[color:var(--ink-signal)]/60"
              />
            )
          )}
          <span className={t.enabled ? "text-ink-cream" : "text-ink-muted"}>{t.name}</span>
        </td>
        <td
          className="py-2"
          title={notReady && !t.enabled ? `not ready · ${notReadyReason}` : undefined}
        >
          <Toggle
            checked={t.enabled}
            disabled={toggleDisabled}
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
        <td
          className={cn(
            "py-2 font-mono text-[11.5px]",
            notReady || props.summary.startsWith("error:") || props.summary.startsWith("halted")
              ? "text-[color:var(--ink-blocked-2)]"
              : "text-ink-muted",
          )}
        >
          {notReady ? `not ready · ${notReadyReason}` : props.summary}
        </td>
        <td className="px-6 py-2 text-right">
          <div className="flex items-center justify-end gap-1">
            <Button
              variant={props.running ? "accent" : "ghost"}
              size="sm"
              // `aria-disabled` (not `disabled`) so accent colors stay vivid;
              // clicks are gated by the `onClick` guard + pointer-events-none.
              aria-disabled={runDisabled || undefined}
              onClick={runDisabled ? undefined : props.onRun}
              className={cn(runDisabled && "cursor-not-allowed pointer-events-none")}
              title={
                props.running
                  ? `Running for ${props.elapsedMs != null ? humanDuration(props.elapsedMs) : "a moment"} — click won't re-fire`
                  : notReady
                    ? `not ready · ${notReadyReason}`
                    : "Run this finder now — ignores schedule, spends $"
              }
            >
              {props.running ? (
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />
              ) : (
                <Play size={12} aria-hidden="true" />
              )}
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
  // Pre-enrichment rejected rows only carry a source URL — derive a handle.
  const repoUrl = typeof p["repoUrl"] === "string" ? (p["repoUrl"] as string) : null;
  if (repoUrl) {
    const m = repoUrl.match(/github\.com\/([^/]+)\/([^/?#]+)/);
    if (m) return `${m[1]}/${m[2]}`;
  }
  const postUrl = typeof p["postUrl"] === "string" ? (p["postUrl"] as string) : null;
  if (postUrl) {
    try {
      const host = new URL(postUrl).hostname.replace(/^www\./, "");
      if (host) return host;
    } catch {
      // fall through
    }
  }
  return null;
}

function companyFor(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p["company"] === "string") return p["company"] as string;
  return null;
}

function linkedinUrlFor(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const v = p["linkedinUrl"];
  if (typeof v !== "string" || v.length === 0) return null;
  // Defense in depth — payload comes from sqlite but a stale/garbage row should
  // never render as a clickable javascript:// or data:// link.
  return /^https?:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\/in\//i.test(v) ? v : null;
}

function phoneFor(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const v = p["phone"];
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}
