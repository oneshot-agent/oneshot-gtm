import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, CircleStop, Eye, Send, Trophy } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { toast } from "sonner";
import type { CadenceView, OutcomeRequest } from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { Badge } from "../components/primitives/Badge.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { EmptyNote } from "../components/primitives/EmptyNote.tsx";
import { Field, Input, Select, Textarea } from "../components/primitives/Field.tsx";
import { Modal } from "../components/primitives/Modal.tsx";
import { SkeletonRow } from "../components/primitives/Skeleton.tsx";
import { StepProgress } from "../components/primitives/StepProgress.tsx";
import { cn, timeAgo } from "../lib/cn.ts";

export const Route = createFileRoute("/cadences")({
  component: CadencesPage,
});

/** Human-readable "in N days/hours/minutes" — used in the send-early warning. */
function earlyByCopy(iso: string | null | undefined): string {
  if (!iso) return "now";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m early`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 36) return `${hours}h early`;
  const days = Math.round(ms / 86_400_000);
  return `${days}d early`;
}

function statusTone(status: string): "receipt" | "signal" | "spend" | "neutral" {
  switch (status) {
    case "active":
      return "receipt";
    case "replied":
      return "signal";
    case "breakup":
      return "spend";
    case "completed":
      return "neutral";
    default:
      return "neutral";
  }
}

interface OutcomeModalState {
  email: string;
  prospectName: string | null;
  playName: string;
}

const rowKey = (c: CadenceView): string => `${c.prospectId}|${c.playName}`;

function CadencesPage() {
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const [outcomeModal, setOutcomeModal] = useState<OutcomeModalState | null>(null);
  const [outcomeKind, setOutcomeKind] = useState<OutcomeRequest["outcome"]>("meeting_booked");
  const [outcomeAmount, setOutcomeAmount] = useState("");
  const [outcomeNotes, setOutcomeNotes] = useState("");

  const cadences = useQuery({
    queryKey: ["cadences", showAll],
    queryFn: () => api.cadences(showAll),
    refetchInterval: 15_000,
  });

  const stop = useMutation({
    mutationFn: (vars: { prospectId: number; playName: string }) =>
      api.stopCadence(vars.prospectId, vars.playName),
    onSuccess: (data, vars) => {
      void qc.invalidateQueries({ queryKey: ["cadences"] });
      toast.success(`stopped cadence · ${vars.playName}`);
    },
    onError: (err) => toast.error(`couldn't stop cadence: ${err.message}`),
  });

  const previewNext = useMutation({
    mutationFn: (vars: { prospectId: number; playName: string }) =>
      api.previewCadenceNext(vars.prospectId, vars.playName),
    onSuccess: (data, vars) => {
      void qc.invalidateQueries({ queryKey: ["cadences"] });
      setExpandedKeys((prev) => new Set([...prev, `${vars.prospectId}|${vars.playName}`]));
      toast.success(
        `drafted next step · ${vars.playName}${data.flags.length > 0 ? ` (${data.flags.length} flag(s))` : ""}`,
      );
    },
    onError: (err) => toast.error(`preview failed: ${err.message}`),
  });

  const sendNext = useMutation({
    mutationFn: (vars: { prospectId: number; playName: string }) =>
      api.sendCadenceNext(vars.prospectId, vars.playName),
    onSuccess: (_data, vars) => {
      // Server returned 202 — actual SDK email send is fire-and-forget in the
      // background (~2 min). We close the modal + clear expansion immediately
      // so the founder isn't stuck staring at a "Sending…" button; the next
      // refetch will show the row's preview cleared once the send completes.
      void qc.invalidateQueries({ queryKey: ["cadences"] });
      void qc.invalidateQueries({ queryKey: ["receipts"] });
      setExpandedKeys((prev) => {
        const next = new Set(prev);
        next.delete(`${vars.prospectId}|${vars.playName}`);
        return next;
      });
      setSendConfirm(null);
      toast.success(`sending · ${vars.playName} — refreshes when complete`);
    },
    onError: (err) => toast.error(`send failed: ${err.message}`),
  });

  const previewBatch = useMutation({
    mutationFn: (items: Array<{ prospectId: number; playName: string }>) =>
      api.previewCadenceBatch(items),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ["cadences"] });
      const okItems = data.results.filter((r) => r.ok);
      const errCount = data.results.length - okItems.length;
      // Auto-expand every successfully-previewed row.
      setExpandedKeys(
        (prev) => new Set([...prev, ...okItems.map((r) => `${r.prospectId}|${r.playName}`)]),
      );
      const tail = errCount > 0 ? ` · ${errCount} skipped` : "";
      toast.success(`previewed ${okItems.length}${tail}`);
    },
    onError: (err) => toast.error(`bulk preview failed: ${err.message}`),
  });

  const sendBatch = useMutation({
    mutationFn: (items: Array<{ prospectId: number; playName: string }>) =>
      api.sendCadenceBatch(items),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ["cadences"] });
      setSelected(new Set());
      setBulkSendConfirmOpen(false);
      toast.success(`started send of ${data.accepted} — drafts will clear as each completes`);
    },
    onError: (err) => toast.error(`bulk send failed: ${err.message}`),
  });

  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkSendConfirmOpen, setBulkSendConfirmOpen] = useState(false);
  const toggleExpanded = (key: string): void =>
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleSelected = (key: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const [sendConfirm, setSendConfirm] = useState<{
    prospectId: number;
    playName: string;
    prospectEmail: string | null;
    prospectName: string | null;
    subject: string;
    isBreakup: boolean;
    /** ISO timestamp of the scheduled fire time; null when cadence has no schedule. */
    nextDueAt: string | null;
    /** True when next_due_at is in the future at the moment Send was clicked. */
    isEarly: boolean;
  } | null>(null);
  const pendingPreviewKey =
    previewNext.isPending && previewNext.variables
      ? `${previewNext.variables.prospectId}|${previewNext.variables.playName}`
      : null;
  const pendingSendKey =
    sendNext.isPending && sendNext.variables
      ? `${sendNext.variables.prospectId}|${sendNext.variables.playName}`
      : null;

  const logOutcome = useMutation({
    mutationFn: async () => {
      if (!outcomeModal) throw new Error("no modal open");
      const req: OutcomeRequest = {
        email: outcomeModal.email,
        outcome: outcomeKind,
        playName: outcomeModal.playName,
        ...(outcomeAmount ? { amountUsd: Number.parseFloat(outcomeAmount) } : {}),
        ...(outcomeNotes ? { notes: outcomeNotes } : {}),
      };
      return await api.recordOutcome(req);
    },
    onSuccess: () => {
      setOutcomeModal(null);
      setOutcomeAmount("");
      setOutcomeNotes("");
      void qc.invalidateQueries({ queryKey: ["measure"] });
      toast.success(`outcome logged · ${outcomeKind}`);
    },
    onError: (err) => toast.error(`couldn't log outcome: ${err.message}`),
  });

  // Memo on cadences.data directly — `list` would be a fresh reference each
  // render because of the `?? []` fallback, which would thrash useMemo's
  // cache.
  const list = useMemo(() => cadences.data?.cadences ?? [], [cadences.data]);
  const aggregate = useMemo(() => buildAggregate(list, showAll), [list, showAll]);
  const nowIso = new Date().toISOString();

  // Bulk-action derived state.
  const selectableActive = useMemo(() => list.filter((c) => c.status === "active"), [list]);
  const allActiveSelected =
    selectableActive.length > 0 && selectableActive.every((c) => selected.has(rowKey(c)));
  const someActiveSelected =
    selectableActive.some((c) => selected.has(rowKey(c))) && !allActiveSelected;
  const selectedRows = useMemo(
    () => list.filter((c) => selected.has(rowKey(c)) && c.status === "active"),
    [list, selected],
  );
  // Sendable = selected + has clean persisted draft + not already in flight.
  // Pending-batch state gates the BUTTON's disabled prop, not the filter —
  // otherwise the "Send M of N" label would flicker to "Send 0 of N" while a
  // send is in flight. The `!c.isSending` filter prevents re-firing a row
  // whose background send is still running (server marks it in-flight).
  const sendableRows = useMemo(
    () =>
      selectedRows.filter(
        (c) => c.nextStepDraft != null && c.nextStepDraft.flags.length === 0 && !c.isSending,
      ),
    [selectedRows],
  );
  const earlySendableCount = sendableRows.filter(
    (c) => c.nextDueAt != null && c.nextDueAt > nowIso,
  ).length;
  const breakupSendableCount = sendableRows.filter((c) => c.nextStepIsBreakup).length;

  const toggleSelectAllActive = (): void => {
    setSelected((prev) => {
      if (allActiveSelected) {
        const next = new Set(prev);
        for (const c of selectableActive) next.delete(rowKey(c));
        return next;
      }
      return new Set([...prev, ...selectableActive.map(rowKey)]);
    });
  };

  return (
    <div className="-mx-6 -my-6 flex flex-col">
      {/* Masthead */}
      <section className="flex items-end justify-between gap-4 border-b border-ink-rule px-6 pb-5 pt-6">
        <div>
          <div className="ln-eyebrow">The Ledger · Cadences</div>
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
            Prospects, in flight.
          </h1>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant={showAll ? "secondary" : "primary"}
            size="sm"
            onClick={() => setShowAll(false)}
          >
            Active
          </Button>
          <Button
            variant={showAll ? "primary" : "secondary"}
            size="sm"
            onClick={() => setShowAll(true)}
          >
            All
          </Button>
        </div>
      </section>

      {/* Aggregate strip — 4 columns divided by vertical hairlines. */}
      <section className="grid grid-cols-2 divide-x divide-ink-rule border-b border-ink-rule md:grid-cols-4">
        <CadenceSummary
          label="Active"
          value={aggregate.active}
          caption={aggregate.overdue > 0 ? `${aggregate.overdue} overdue` : "awaiting reply"}
          tone={aggregate.overdue > 0 ? "spend" : "receipt"}
        />
        <CadenceSummary
          label="Replied"
          value={aggregate.replied}
          caption="signal over noise"
          tone="signal"
        />
        <CadenceSummary
          label="Breakup"
          value={aggregate.breakup}
          caption="final touch sent"
          tone="spend"
        />
        <CadenceSummary label="Completed" value={aggregate.completed} caption="full cadence done" />
      </section>

      {/* Meta strip */}
      <section className="flex items-baseline justify-between border-b border-ink-rule px-6 py-2.5">
        <div className="ln-eyebrow">
          {cadences.data ? (
            <>
              {list.length} <span className="text-ink-faint">{showAll ? "total" : "active"}</span>
            </>
          ) : (
            <span className="text-ink-faint">…</span>
          )}
        </div>
        <div className="font-mono text-[11px] text-ink-faint">refresh · 15s</div>
      </section>

      {/* Bulk-action bar — visible when at least one active row is selected. */}
      {selectedRows.length > 0 && (
        <section className="flex items-center justify-between gap-3 border-b border-ink-rule bg-ink-surface/40 px-6 py-2.5">
          <div className="font-mono text-[12px] text-ink-cream-2">
            <span className="text-ink-cream">{selectedRows.length}</span> selected
            {sendableRows.length !== selectedRows.length && (
              <span className="ml-2 text-[color:var(--ink-spend-2)]">
                · {sendableRows.length} sendable (others need preview / have flags)
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              disabled={previewBatch.isPending || sendBatch.isPending}
              onClick={() =>
                previewBatch.mutate(
                  selectedRows.map((c) => ({
                    prospectId: c.prospectId,
                    playName: c.playName,
                  })),
                )
              }
            >
              {previewBatch.isPending
                ? `Previewing ${selectedRows.length}…`
                : `Preview ${selectedRows.length}`}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={sendableRows.length === 0 || sendBatch.isPending}
              onClick={() => setBulkSendConfirmOpen(true)}
            >
              {sendBatch.isPending
                ? "Sending…"
                : `Send ${sendableRows.length}${sendableRows.length !== selectedRows.length ? ` of ${selectedRows.length}` : ""}`}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        </section>
      )}

      {/* Cadence ledger */}
      <section>
        {cadences.isLoading ? (
          <div>
            {Array.from({ length: 5 }, (_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : list.length === 0 ? (
          <div className="px-6 py-8">
            <EmptyNote
              note="No cadences in flight. The engine only runs for prospects you've already touched; send a play and they appear here."
              cli="oneshot-gtm motion show-hn --target show-hn.json"
            />
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 z-10 bg-ink-bg">
              <tr className="border-b border-ink-rule text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                <th className="px-3 py-2 text-left font-medium" style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    aria-label={
                      allActiveSelected
                        ? "deselect all active cadences"
                        : "select all active cadences"
                    }
                    title={
                      selectableActive.length === 0
                        ? "no active rows to select"
                        : allActiveSelected
                          ? "deselect all active"
                          : "select all active"
                    }
                    disabled={selectableActive.length === 0}
                    checked={allActiveSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someActiveSelected;
                    }}
                    onChange={toggleSelectAllActive}
                    className="cursor-pointer"
                  />
                </th>
                <th className="px-6 py-2 text-left font-medium">prospect</th>
                <th className="py-2 text-left font-medium">play</th>
                <th className="py-2 text-left font-medium">status</th>
                <th className="py-2 text-left font-medium">step</th>
                <th className="py-2 text-right font-medium">next due</th>
                <th className="py-2 text-right font-medium">enrolled</th>
                <th className="px-6 py-2 text-right font-medium">actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c, i) => {
                const totalSteps = c.followupCount + 1;
                const isOverdue =
                  c.status === "active" && c.nextDueAt !== null && c.nextDueAt <= nowIso;
                const hasExpandable = c.priorSteps.length > 0 || c.nextStepDraft != null;
                return (
                  <Fragment key={`${c.prospectId}-${c.playName}`}>
                    <tr
                      onClick={
                        hasExpandable
                          ? (e) => {
                              // Ignore clicks that originated on interactive
                              // controls inside the row (buttons / inputs /
                              // links / labels). Without this guard, clicking
                              // Preview / Send / Stop / the checkbox would
                              // ALSO toggle the row expansion.
                              const t = e.target as HTMLElement;
                              if (t.closest("button, input, a, label, [role='button']")) return;
                              toggleExpanded(rowKey(c));
                            }
                          : undefined
                      }
                      className={cn(
                        "border-b border-ink-rule/60 transition-colors duration-[var(--dur-stamp)]",
                        "hover:bg-ink-surface/60",
                        i % 2 === 1 && "bg-ink-surface/20",
                        hasExpandable && "cursor-pointer",
                      )}
                    >
                      <td className="px-3 py-2" style={{ width: 32 }}>
                        <input
                          type="checkbox"
                          aria-label={`select ${c.prospectName ?? c.prospectEmail ?? "row"}`}
                          title={
                            c.status === "active"
                              ? `select for batch preview / send`
                              : `only active cadences can be selected (status: ${c.status})`
                          }
                          disabled={c.status !== "active"}
                          checked={selected.has(rowKey(c))}
                          onChange={() => toggleSelected(rowKey(c))}
                          className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-30"
                        />
                      </td>
                      <td className="px-6 py-2">
                        <div className="text-ink-cream">{c.prospectName ?? "(unknown)"}</div>
                        <div className="font-mono text-[11px] text-ink-faint">
                          {c.prospectEmail ?? "—"}
                        </div>
                      </td>
                      <td className="py-2 text-ink-cream-2">{c.playName}</td>
                      <td className="py-2">
                        <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                        {c.isSending && (
                          <Badge tone="receipt" className="ml-1.5 animate-pulse">
                            sending…
                          </Badge>
                        )}
                      </td>
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <StepProgress
                            current={Math.min(c.currentStep + 1, totalSteps)}
                            total={totalSteps}
                            tone={
                              c.status === "replied"
                                ? "signal"
                                : c.status === "breakup"
                                  ? "spend"
                                  : "receipt"
                            }
                          />
                          <span className="font-mono text-[11px] text-ink-faint">
                            {c.currentStep + 1}/{totalSteps}
                          </span>
                        </div>
                      </td>
                      <td
                        className={cn(
                          "py-2 text-right font-mono text-[12px]",
                          isOverdue ? "text-[color:var(--ink-spend-2)]" : "text-ink-muted",
                        )}
                      >
                        {timeAgo(c.nextDueAt)}
                        {isOverdue && <span className="ml-1 text-[10px]">· overdue</span>}
                      </td>
                      <td className="py-2 text-right font-mono text-[11px] text-ink-faint">
                        {timeAgo(c.enrolledAt)}
                      </td>
                      <td className="px-6 py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {c.status === "active" &&
                            (() => {
                              const key = `${c.prospectId}|${c.playName}`;
                              const draft = c.nextStepDraft;
                              const sendDisabled =
                                !draft ||
                                draft.flags.length > 0 ||
                                pendingSendKey != null ||
                                pendingPreviewKey != null ||
                                c.isSending;
                              return (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    title={
                                      draft
                                        ? `re-preview next step (current preview drafted ${timeAgo(draft.draftedAt)})`
                                        : "preview next step (LLM draft, no send)"
                                    }
                                    disabled={pendingPreviewKey != null}
                                    onClick={() =>
                                      previewNext.mutate({
                                        prospectId: c.prospectId,
                                        playName: c.playName,
                                      })
                                    }
                                  >
                                    <Eye size={12} />
                                  </Button>
                                  <Button
                                    variant={!sendDisabled ? "primary" : "ghost"}
                                    size="sm"
                                    title={
                                      !draft
                                        ? "click Preview first"
                                        : draft.flags.length > 0
                                          ? `draft held by lint (${draft.flags.length} flag(s)) — re-preview`
                                          : c.nextStepIsBreakup
                                            ? "send breakup (final touch) — confirms first"
                                            : "send next step — confirms first"
                                    }
                                    disabled={sendDisabled}
                                    onClick={() => {
                                      if (!draft) return;
                                      setSendConfirm({
                                        prospectId: c.prospectId,
                                        playName: c.playName,
                                        prospectEmail: c.prospectEmail,
                                        prospectName: c.prospectName,
                                        subject: draft.subject,
                                        isBreakup: c.nextStepIsBreakup,
                                        nextDueAt: c.nextDueAt,
                                        isEarly:
                                          c.nextDueAt != null &&
                                          c.nextDueAt > new Date().toISOString(),
                                      });
                                    }}
                                  >
                                    <Send size={12} />
                                  </Button>
                                  {(draft || c.priorSteps.length > 0) && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      title={
                                        expandedKeys.has(key)
                                          ? "collapse"
                                          : c.priorSteps.length > 0 && draft
                                            ? `view ${c.priorSteps.length} sent + next-step preview`
                                            : c.priorSteps.length > 0
                                              ? `view ${c.priorSteps.length} sent so far`
                                              : "view next-step preview"
                                      }
                                      onClick={() => toggleExpanded(key)}
                                    >
                                      <ChevronDown
                                        size={12}
                                        className={cn(
                                          "transition-transform",
                                          expandedKeys.has(key) && "rotate-180",
                                        )}
                                      />
                                    </Button>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    title="stop cadence"
                                    disabled={stop.isPending}
                                    onClick={() =>
                                      stop.mutate({
                                        prospectId: c.prospectId,
                                        playName: c.playName,
                                      })
                                    }
                                  >
                                    <CircleStop size={12} />
                                  </Button>
                                </>
                              );
                            })()}
                          {/* Chevron also for NON-active rows that still have history
                            (breakup / replied / completed / paused). The active-status
                            block already renders its own chevron above when there's a
                            draft OR history; this one covers the non-active case. */}
                          {c.status !== "active" &&
                            c.priorSteps.length > 0 &&
                            (() => {
                              const key = `${c.prospectId}|${c.playName}`;
                              return (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title={
                                    expandedKeys.has(key)
                                      ? "collapse"
                                      : `view ${c.priorSteps.length} sent so far`
                                  }
                                  onClick={() => toggleExpanded(key)}
                                >
                                  <ChevronDown
                                    size={12}
                                    className={cn(
                                      "transition-transform",
                                      expandedKeys.has(key) && "rotate-180",
                                    )}
                                  />
                                </Button>
                              );
                            })()}
                          {c.prospectEmail && (
                            <Button
                              variant="ghost"
                              size="sm"
                              title="log outcome"
                              onClick={() =>
                                setOutcomeModal({
                                  email: c.prospectEmail as string,
                                  prospectName: c.prospectName,
                                  playName: c.playName,
                                })
                              }
                            >
                              <Trophy size={12} />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {(c.priorSteps.length > 0 || c.nextStepDraft) &&
                      expandedKeys.has(rowKey(c)) && (
                        <tr className="border-b border-ink-rule/60 bg-ink-surface/30">
                          <td colSpan={8} className="px-6 py-3">
                            {c.priorSteps.length > 0 && (
                              <>
                                <div className="ln-eyebrow mb-1">
                                  Sent so far ({c.priorSteps.length})
                                </div>
                                <div className="flex flex-col gap-3">
                                  {c.priorSteps.map((s) => (
                                    <div
                                      key={s.stepIndex}
                                      className="border-l-2 border-ink-rule pl-3"
                                    >
                                      <div className="font-mono text-[11px] text-ink-faint">
                                        step {s.stepIndex} ({s.label}) · sent {timeAgo(s.sentAt)}
                                      </div>
                                      <div className="mt-1 font-mono text-[12px] text-ink-cream">
                                        Subject: {s.subject}
                                      </div>
                                      {s.body ? (
                                        <pre className="mt-1 whitespace-pre-wrap text-[12px] text-ink-cream-2">
                                          {s.body}
                                        </pre>
                                      ) : (
                                        <div className="mt-1 font-mono text-[11px] italic text-ink-faint">
                                          (body not captured — sent before per-touch body
                                          persistence landed)
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </>
                            )}
                            {c.nextStepDraft && (
                              <div className={c.priorSteps.length > 0 ? "mt-5" : ""}>
                                <div className="ln-eyebrow mb-1">Next-step preview</div>
                                <div className="font-mono text-[11px] text-ink-faint">
                                  drafted {timeAgo(c.nextStepDraft.draftedAt)}
                                  {c.nextStepDraft.flags.length > 0 && (
                                    <span className="ml-2 text-[color:var(--ink-spend-2)]">
                                      · {c.nextStepDraft.flags.length} flag(s):{" "}
                                      {c.nextStepDraft.flags.join(", ")}
                                    </span>
                                  )}
                                </div>
                                <div className="mt-2 font-mono text-[12px] text-ink-cream">
                                  Subject: {c.nextStepDraft.subject}
                                </div>
                                <pre className="mt-1 whitespace-pre-wrap text-[12px] text-ink-cream-2">
                                  {c.nextStepDraft.body}
                                </pre>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <Modal
        open={bulkSendConfirmOpen}
        onClose={() => setBulkSendConfirmOpen(false)}
        title={`Send ${sendableRows.length} cadence step${sendableRows.length === 1 ? "" : "s"}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBulkSendConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                sendBatch.mutate(
                  sendableRows.map((c) => ({
                    prospectId: c.prospectId,
                    playName: c.playName,
                  })),
                )
              }
              disabled={sendBatch.isPending || sendableRows.length === 0}
            >
              {sendBatch.isPending ? "Sending…" : `Send ${sendableRows.length}`}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {breakupSendableCount > 0 && (
            <div className="rounded border border-ink-rule bg-ink-surface/40 px-3 py-2 text-[12px] text-[color:var(--ink-spend-2)]">
              {breakupSendableCount === sendableRows.length
                ? "All selected steps are breakups — the final touch in their cadences. After this, no more emails will go to these prospects."
                : `${breakupSendableCount} of ${sendableRows.length} selected steps are breakups — the final touch in their cadences. After this, no more emails will go to those prospects.`}
            </div>
          )}
          {earlySendableCount > 0 && (
            <div className="rounded border border-ink-rule bg-ink-surface/40 px-3 py-2 text-[12px] text-ink-cream-2">
              {earlySendableCount === sendableRows.length
                ? "All selected steps are scheduled for a future date. Sending now fires them ahead of schedule; remaining cadence steps will recompute from today."
                : `${earlySendableCount} of ${sendableRows.length} selected steps are scheduled for a future date and will fire ahead of schedule.`}
            </div>
          )}
          <div className="ln-eyebrow text-[10px] text-ink-faint">
            Targets ({sendableRows.length})
          </div>
          <div className="max-h-72 overflow-auto rounded border border-ink-rule">
            <table className="w-full text-[11px]">
              <thead className="bg-ink-surface/30">
                <tr className="text-ink-faint">
                  <th className="px-2 py-1 text-left font-medium">To</th>
                  <th className="px-2 py-1 text-left font-medium">Play</th>
                  <th className="px-2 py-1 text-left font-medium">Subject</th>
                </tr>
              </thead>
              <tbody>
                {sendableRows.map((c) => (
                  <tr key={rowKey(c)} className="border-t border-ink-rule/40">
                    <td className="px-2 py-1 font-mono text-ink-cream-2">
                      {c.prospectEmail ?? "(no email)"}
                    </td>
                    <td className="px-2 py-1 text-ink-cream-2">{c.playName}</td>
                    <td className="px-2 py-1 text-ink-cream-2">
                      {c.nextStepDraft?.subject ?? "(no subject)"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ln-eyebrow text-[10px] text-ink-faint">
            Server processes serially; ~2 min per email. The UI refreshes every 15s and rows clear
            their preview as each completes.
          </div>
        </div>
      </Modal>

      <Modal
        open={sendConfirm != null}
        onClose={() => setSendConfirm(null)}
        title={
          sendConfirm?.isBreakup
            ? `Send breakup — ${sendConfirm?.prospectName ?? sendConfirm?.prospectEmail ?? "(prospect)"}`
            : `Send next step — ${sendConfirm?.prospectName ?? sendConfirm?.prospectEmail ?? "(prospect)"}`
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setSendConfirm(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!sendConfirm) return;
                sendNext.mutate(
                  { prospectId: sendConfirm.prospectId, playName: sendConfirm.playName },
                  { onSettled: () => setSendConfirm(null) },
                );
              }}
              disabled={sendNext.isPending}
            >
              {sendNext.isPending ? "Sending…" : sendConfirm?.isBreakup ? "Send breakup" : "Send"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {sendConfirm?.isEarly && sendConfirm.nextDueAt && (
            <div className="rounded border border-ink-rule bg-ink-surface/40 px-3 py-2 text-[12px] text-ink-cream-2">
              Heads up: this step isn't scheduled to fire until{" "}
              <span className="text-ink-cream">{timeAgo(sendConfirm.nextDueAt)}</span> (
              {earlyByCopy(sendConfirm.nextDueAt)}). Sending now fires it ahead of schedule; the
              remaining cadence steps will recompute their due dates from today, not the original
              schedule.
            </div>
          )}
          {sendConfirm?.isBreakup && (
            <div className="rounded border border-ink-rule bg-ink-surface/40 px-3 py-2 text-[12px] text-[color:var(--ink-spend-2)]">
              This is the breakup — the final touch in{" "}
              <code className="font-mono text-[11px]">{sendConfirm.playName}</code>. After this, no
              more emails will go to this prospect.
            </div>
          )}
          <div className="font-mono text-[12px] text-ink-muted">
            <div>
              To:{" "}
              <span className="text-ink-cream-2">{sendConfirm?.prospectEmail ?? "(no email)"}</span>
            </div>
            <div>
              Play: <span className="text-ink-cream-2">{sendConfirm?.playName}</span>
            </div>
            <div>
              Subject: <span className="text-ink-cream-2">{sendConfirm?.subject}</span>
            </div>
          </div>
          <div className="ln-eyebrow text-[10px] text-ink-faint">
            sends the persisted preview verbatim — no LLM reroll.
          </div>
        </div>
      </Modal>

      <Modal
        open={outcomeModal != null}
        onClose={() => setOutcomeModal(null)}
        title={`Log outcome${outcomeModal?.prospectName ? ` — ${outcomeModal.prospectName}` : ""}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOutcomeModal(null)}>
              Cancel
            </Button>
            <Button onClick={() => logOutcome.mutate()} disabled={logOutcome.isPending}>
              {logOutcome.isPending ? "Saving…" : "Save outcome"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="font-mono text-[12px] text-ink-muted">
            Prospect: <span className="text-ink-cream-2">{outcomeModal?.email}</span>
            <br />
            Play: <span className="text-ink-cream-2">{outcomeModal?.playName}</span>
          </div>
          <Field label="Outcome">
            <Select
              value={outcomeKind}
              onChange={(e) => setOutcomeKind(e.target.value as OutcomeRequest["outcome"])}
            >
              <option value="meeting_booked">meeting_booked</option>
              <option value="sql_qualified">sql_qualified</option>
              <option value="deal_won">deal_won</option>
              <option value="deal_lost">deal_lost</option>
              <option value="ghosted">ghosted</option>
            </Select>
          </Field>
          {outcomeKind === "deal_won" && (
            <Field label="Amount (USD)">
              <Input
                type="number"
                value={outcomeAmount}
                onChange={(e) => setOutcomeAmount(e.target.value)}
                placeholder="5000"
              />
            </Field>
          )}
          <Field label="Notes (optional)">
            <Textarea
              rows={3}
              value={outcomeNotes}
              onChange={(e) => setOutcomeNotes(e.target.value)}
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

function CadenceSummary({
  label,
  value,
  caption,
  tone = "neutral",
}: {
  label: string;
  value: number;
  caption?: string;
  tone?: "neutral" | "receipt" | "signal" | "spend";
}) {
  const captionColor =
    tone === "spend"
      ? "var(--ink-spend-2)"
      : tone === "receipt"
        ? "var(--ink-receipt-2)"
        : tone === "signal"
          ? "var(--ink-signal-2)"
          : "var(--ink-faint)";
  return (
    <div className="px-5 py-4">
      <div className="ln-eyebrow">{label}</div>
      <div
        className="mt-1 truncate text-ink-cream ln-numeral"
        style={{ fontSize: 32, lineHeight: 1 }}
      >
        {value}
      </div>
      {caption && (
        <div className="mt-2 truncate font-mono text-[11px]" style={{ color: captionColor }}>
          {caption}
        </div>
      )}
    </div>
  );
}

function buildAggregate(
  cadences: CadenceView[],
  showingAll: boolean,
): {
  active: number;
  replied: number;
  breakup: number;
  completed: number;
  overdue: number;
} {
  const now = Date.now();
  let active = 0;
  let replied = 0;
  let breakup = 0;
  let completed = 0;
  let overdue = 0;

  for (const c of cadences) {
    if (c.status === "active") {
      active++;
      if (c.nextDueAt && new Date(c.nextDueAt).getTime() <= now) overdue++;
    } else if (c.status === "replied") replied++;
    else if (c.status === "breakup") breakup++;
    else if (c.status === "completed") completed++;
  }

  // When the user toggles off "all", the server already filtered to active
  // only. Zero out the other buckets for honesty.
  if (!showingAll) {
    replied = 0;
    breakup = 0;
    completed = 0;
  }
  return { active, replied, breakup, completed, overdue };
}
