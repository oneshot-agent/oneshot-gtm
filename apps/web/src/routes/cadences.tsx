import { DirectMailPanel, DirectMailHistory } from "../components/DirectMailPanel.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  ChevronDown,
  CircleStop,
  Eye,
  Loader2,
  MessageCircle,
  RotateCw,
  Send,
  Trophy,
} from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { toast } from "sonner";
import type {
  CadenceCounts,
  CadenceStopReason,
  CadenceView,
  OutcomeRequest,
} from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { Badge } from "../components/primitives/Badge.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { EmptyNote } from "../components/primitives/EmptyNote.tsx";
import { Pii } from "../components/primitives/Pii.tsx";
import { useMask, usePrivacy } from "../lib/privacy.tsx";
import { Field, Input, Select, Textarea } from "../components/primitives/Field.tsx";
import { Modal } from "../components/primitives/Modal.tsx";
import { SkeletonRow } from "../components/primitives/Skeleton.tsx";
import { cn, formatSendsToday, timeAgo } from "../lib/cn.ts";
import { readOnly } from "../lib/readOnly.ts";
import { STOP_REASON_LABELS, cadenceStateLabel } from "../lib/cadenceState.ts";
import { fitReasonFor } from "../lib/queueRationale.ts";
import { queueEvidence } from "../lib/queueEvidence.ts";
import { IdentityCell, SignalLabel } from "../components/ledger/IdentityCell.tsx";
import { SheetHeading } from "../components/ledger/SheetHeading.tsx";
import { Rule, Sheet } from "../components/ledger/Sheet.tsx";
import { CaseList, Disclosure, type CaseListRow } from "../components/ledger/CaseList.tsx";
import { DraftStateLine, LetterCard, LetterEmpty } from "../components/ledger/LetterCard.tsx";

/** Tailwind can't build class names dynamically — enumerate the tile-count variants. */
const TILE_GRID_COLS: Record<number, string> = {
  4: "md:grid-cols-4",
  5: "md:grid-cols-5",
  6: "md:grid-cols-6",
  7: "md:grid-cols-7",
};

export const Route = createFileRoute("/cadences")({
  staticData: { title: "Cadences" },
  // ?sinceRun=N deep-link from /run/<play>?runId=N done-mode — filters the
  // listing to cadences whose prospect email is in the run's prospect_emails
  // set. The page shows a clear banner with a [clear filter] CTA.
  validateSearch: (search: Record<string, unknown>) => ({
    sinceRun:
      typeof search["sinceRun"] === "string" && /^\d+$/.test(search["sinceRun"])
        ? Number.parseInt(search["sinceRun"], 10)
        : undefined,
  }),
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

function statusTone(status: string): "receipt" | "signal" | "spend" | "blocked" | "neutral" {
  switch (status) {
    case "active":
      return "receipt";
    case "replied":
      return "signal";
    case "breakup":
      return "spend";
    case "completed":
      return "neutral";
    case "stopped":
      return "blocked";
    case "bounced":
      return "blocked";
    case "off-icp":
      return "blocked";
    case "unsubscribed":
      return "blocked";
    default:
      return "neutral";
  }
}

interface OutcomeModalState {
  email: string;
  prospectName: string | null;
  playName: string;
}

interface StopModalState {
  prospectId: number;
  prospectName: string | null;
  playName: string;
}

interface LinkedInReplyModalState {
  prospectId: number;
  prospectName: string | null;
}

const rowKey = (c: CadenceView): string => `${c.prospectId}|${c.playName}`;

function CadencesPage() {
  const [mailKey, setMailKey] = useState<string | null>(null);
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const [outcomeModal, setOutcomeModal] = useState<OutcomeModalState | null>(null);
  const [outcomeKind, setOutcomeKind] = useState<OutcomeRequest["outcome"]>("meeting_booked");
  const [outcomeAmount, setOutcomeAmount] = useState("");
  const [outcomeNotes, setOutcomeNotes] = useState("");
  const [stopModal, setStopModal] = useState<StopModalState | null>(null);
  const [linkedinReplyModal, setLinkedinReplyModal] = useState<LinkedInReplyModalState | null>(
    null,
  );
  const [linkedinReplyBody, setLinkedinReplyBody] = useState("");
  // Every close path must clear the body. Cancel used to bypass the onClose
  // cleanup, so reopening the modal for a DIFFERENT prospect showed the
  // previous one's text — one stray click from filing person A's message
  // against person B.
  const closeLinkedinReplyModal = (): void => {
    setLinkedinReplyModal(null);
    setLinkedinReplyBody("");
  };
  const [stopReason, setStopReason] = useState<CadenceStopReason>("bad_timing");
  const [stopNote, setStopNote] = useState("");

  const { sinceRun } = Route.useSearch();
  const cadences = useQuery({
    queryKey: ["cadences", showAll, sinceRun],
    queryFn: () => api.cadences({ all: showAll, ...(sinceRun != null ? { sinceRun } : {}) }),
    refetchInterval: 15_000,
  });
  const cadenceNavigate = Route.useNavigate();
  const clearSinceRun = (): void => {
    // validateSearch's return type makes `sinceRun` a required (if undefined)
    // key, so `{}` doesn't typecheck — spell the cleared filter out.
    void cadenceNavigate({ search: { sinceRun: undefined } });
  };

  const stop = useMutation({
    mutationFn: (vars: {
      prospectId: number;
      playName: string;
      reason: CadenceStopReason;
      note?: string;
    }) => api.stopCadence(vars.prospectId, vars.playName, { reason: vars.reason, note: vars.note }),
    onSuccess: (data, vars) => {
      void qc.invalidateQueries({ queryKey: ["cadences"] });
      setStopModal(null);
      setStopReason("bad_timing");
      setStopNote("");
      toast.success(`stopped cadence · ${vars.playName}`);
    },
    onError: (err) => toast.error(`couldn't stop cadence: ${err.message}`),
  });

  const markLinkedInReply = useMutation({
    mutationFn: (vars: { prospectId: number; body?: string }) =>
      api.markLinkedInReply(vars.prospectId, vars.body),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ["cadences"] });
      setLinkedinReplyModal(null);
      setLinkedinReplyBody("");
      const warning = data.inFlightSends > 0 ? " · an in-flight email may still complete" : "";
      toast.success(
        `LinkedIn reply recorded · ${data.cadencesStopped} cadence(s) stopped${warning}`,
      );
    },
    onError: (err) => toast.error(`couldn't record LinkedIn reply: ${err.message}`),
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
  const mailProspect = useMemo(
    () => list.find((c) => rowKey(c) === mailKey) ?? null,
    [list, mailKey],
  );
  // Tiles read the server's full-status counts (scoped only by sinceRun), NOT
  // the table rows — so REPLIED/BREAKUP/COMPLETED stay accurate even while the
  // table is filtered to active.
  const counts = cadences.data?.counts ?? EMPTY_COUNTS;
  const mask = useMask();
  const { masked } = usePrivacy();
  const now = new Date();
  const nowIso = now.toISOString();

  // Bulk-action derived state.
  const selectableActive = useMemo(
    () => list.filter((c) => c.status === "active" && c.nextStepChannel !== "direct_mail"),
    [list],
  );
  const allActiveSelected =
    selectableActive.length > 0 && selectableActive.every((c) => selected.has(rowKey(c)));
  const someActiveSelected =
    selectableActive.some((c) => selected.has(rowKey(c))) && !allActiveSelected;
  const selectedRows = useMemo(
    () =>
      list.filter(
        (c) =>
          selected.has(rowKey(c)) && c.status === "active" && c.nextStepChannel !== "direct_mail",
      ),
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

  // Quick-select presets. Active rows are already returned most-overdue-first
  // (server: ORDER BY next_due_at ASC NULLS LAST), but re-sort a copy so the
  // ordering is correct even in the "All" view where rows are status-grouped.
  // Nulls (no schedule) sort last. Replaces the current selection.
  const activeByDue = useMemo(
    () =>
      selectableActive.toSorted((a, b) => {
        if (a.nextDueAt === b.nextDueAt) return 0;
        if (a.nextDueAt === null) return 1;
        if (b.nextDueAt === null) return -1;
        return a.nextDueAt < b.nextDueAt ? -1 : 1;
      }),
    [selectableActive],
  );
  const selectNextN = (n: number): void =>
    setSelected(new Set(activeByDue.slice(0, n).map(rowKey)));

  return (
    <div className="-mx-6 -my-6 flex flex-col">
      <DirectMailHistory />
      {mailProspect && (
        <DirectMailPanel
          key={`${mailProspect.prospectId}|${mailProspect.playName}`}
          prospect={mailProspect}
          onClose={() => setMailKey(null)}
        />
      )}
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

      {/* sinceRun filter banner — deep-link from /run/<play>?runId=N done mode. */}
      {sinceRun != null && (
        <section className="flex items-center justify-between border-b border-ink-rule bg-ink-surface/60 px-6 py-2.5">
          <div className="text-[12px] text-ink-muted">
            Filtering to {list.length} cadence{list.length === 1 ? "" : "s"} just enrolled by
            <span className="ml-1 font-mono text-ink-cream">run #{sinceRun}</span>
          </div>
          <Button variant="ghost" size="sm" onClick={clearSinceRun}>
            clear filter
          </Button>
        </section>
      )}

      {/* The bounced tile appears only once any cadence has bounced — a permanent 0
          would read as reassurance on installs that never ran bounce detection. */}
      <section
        className={cn(
          "grid grid-cols-2 divide-x divide-ink-rule border-b border-ink-rule",
          TILE_GRID_COLS[5 + (counts.bounced > 0 ? 1 : 0) + (cadences.data?.sendsToday ? 1 : 0)],
        )}
      >
        <CadenceSummary
          label="Active"
          value={counts.active}
          caption={counts.overdue > 0 ? `${counts.overdue} overdue` : "awaiting reply"}
          tone={counts.overdue > 0 ? "spend" : "receipt"}
        />
        <CadenceSummary
          label="Replied"
          value={counts.replied}
          caption="signal over noise"
          tone="signal"
        />
        <CadenceSummary
          label="Breakup"
          value={counts.breakup}
          caption="final touch sent"
          tone="spend"
        />
        <CadenceSummary label="Completed" value={counts.completed} caption="full cadence done" />
        <CadenceSummary
          label="Stopped"
          value={counts.stopped}
          caption="manually ended"
          tone="blocked"
        />
        {cadences.data?.sendsToday && (
          <CadenceSummary
            label="Sends today"
            value={formatSendsToday(cadences.data.sendsToday)}
            caption="across all senders"
            tone={
              cadences.data.sendsToday.cap != null &&
              cadences.data.sendsToday.sent >= cadences.data.sendsToday.cap
                ? "spend"
                : "neutral"
            }
          />
        )}
        {counts.bounced > 0 && (
          <CadenceSummary
            label="Bounced"
            value={counts.bounced}
            caption="address dead · suppressed"
            tone="blocked"
          />
        )}
      </section>

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
        <div className="flex items-center gap-2">
          {selectableActive.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[11px] text-ink-faint">select next</span>
              {[10, 20, 30].map((n) => (
                <Button key={n} variant="secondary" size="sm" onClick={() => selectNextN(n)}>
                  {n}
                </Button>
              ))}
            </div>
          )}
          <div className="font-mono text-[11px] text-ink-faint">refresh · 15s</div>
        </div>
      </section>

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
              {...readOnly}
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
              note="No cadences in flight. Find prospects from /queue's finder flow, or run the watcher; approved sends appear here."
              cli="oneshot-gtm find watch"
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
                <th className="py-2 pl-3 text-left font-medium">prospect</th>
                <th className="py-2 text-left font-medium">play</th>
                <th className="py-2 text-left font-medium">status</th>
                <th className="py-2 text-right font-medium">enrolled</th>
                <th className="px-6 py-2 text-right font-medium">actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c, i) => {
                const totalSteps = c.followupCount + 1;
                const key = rowKey(c);
                const knownCompany =
                  c.prospectCompany && !/^\(?unknown\)?$/i.test(c.prospectCompany.trim())
                    ? c.prospectCompany
                    : null;
                const isOverdue =
                  c.status === "active" && c.nextDueAt !== null && c.nextDueAt <= nowIso;
                // Line 2 is the sequence state (#602); every row opens into the
                // sheet, which always has at least the enrolment to show.
                const state = cadenceStateLabel(c, now);
                const open = expandedKeys.has(key);
                const draft = c.nextStepDraft;
                const previewPending = pendingPreviewKey === key;
                const sendPending = c.isSending || pendingSendKey === key;
                const sendDisabled =
                  !draft ||
                  draft.flags.length > 0 ||
                  pendingSendKey != null ||
                  pendingPreviewKey != null ||
                  c.isSending;
                // Send fires immediately (no confirm modal), so the
                // early/breakup warnings live in the button tooltip.
                const earlyNote =
                  c.nextDueAt != null && c.nextDueAt > nowIso
                    ? ` · ${earlyByCopy(c.nextDueAt)} ahead of schedule — remaining steps recompute from today`
                    : "";
                const sendTitle = !draft
                  ? "generate a draft first"
                  : draft.flags.length > 0
                    ? `draft held by lint (${draft.flags.length} flag(s)) — regenerate`
                    : c.nextStepIsBreakup
                      ? `send breakup (final touch) — sends now, no more emails after this${earlyNote}`
                      : `send next step — sends now${earlyNote}`;
                // The reminder: why this person was written to in the first
                // place — the intro's signal and fit sentence, off the sent
                // queue row (#599). Freeform, so it drops under privacy mode.
                const reminderSignal =
                  !masked && c.queuePayload ? queueEvidence(c.playName, c.queuePayload) : null;
                const fitReason = masked ? null : fitReasonFor(c.queuePayload);
                const caseRows: CaseListRow[] = [
                  { key: "enrolled", value: timeAgo(c.enrolledAt) },
                  ...(c.status === "active" && c.nextDueAt
                    ? [
                        {
                          key: "next due",
                          value: `${timeAgo(c.nextDueAt)}${isOverdue ? " · overdue" : ""}`,
                          ...(isOverdue ? { tone: "spend" as const } : {}),
                        },
                      ]
                    : []),
                  {
                    key: "step",
                    value: `${Math.min(c.currentStep + 1, totalSteps)} of ${totalSteps}${
                      c.nextStepLabel
                        ? ` · next: ${c.nextStepLabel}${c.nextStepIsBreakup ? " (breakup)" : ""}`
                        : ""
                    }`,
                  },
                  ...(c.status === "replied"
                    ? [
                        {
                          key: "replied",
                          value: [
                            c.replyChannel ? `on ${c.replyChannel}` : null,
                            c.replyAt ? timeAgo(c.replyAt) : null,
                          ]
                            .filter(Boolean)
                            .join(" · "),
                        },
                      ]
                    : []),
                  ...(c.status === "stopped"
                    ? [
                        {
                          key: "stopped",
                          value: `${c.stopReason ? STOP_REASON_LABELS[c.stopReason] : "reason unavailable"}${
                            c.stoppedAt ? ` · ${timeAgo(c.stoppedAt)}` : ""
                          }`,
                          tone: "blocked" as const,
                        },
                      ]
                    : []),
                  ...(c.stopNote ? [{ key: "note", value: c.stopNote }] : []),
                  ...(c.lastSendError && !c.isSending
                    ? [
                        {
                          key: "send failed",
                          value: `${c.lastSendError}${
                            c.lastSendErrorAt ? ` · ${timeAgo(c.lastSendErrorAt)}` : ""
                          }`,
                          tone: "blocked" as const,
                        },
                      ]
                    : []),
                ];
                const stopButton =
                  c.status === "active" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      title={
                        c.isSending
                          ? "wait for the in-flight send to finish before stopping"
                          : "stop cadence"
                      }
                      disabled={stop.isPending || c.isSending}
                      onClick={() =>
                        setStopModal({
                          prospectId: c.prospectId,
                          prospectName: c.prospectName,
                          playName: c.playName,
                        })
                      }
                    >
                      <CircleStop size={11} /> Stop
                    </Button>
                  ) : null;
                const regenerateButton =
                  c.status === "active" &&
                  c.nextStepLabel != null &&
                  c.nextStepChannel !== "direct_mail" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pendingPreviewKey != null}
                      title={
                        draft
                          ? `regenerate next step (drafted ${timeAgo(draft.draftedAt)})`
                          : "generate next-step draft — dry-run LLM, never sends"
                      }
                      onClick={() =>
                        previewNext.mutate({ prospectId: c.prospectId, playName: c.playName })
                      }
                      {...readOnly}
                    >
                      {previewPending ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <RotateCw size={11} />
                      )}
                      {previewPending
                        ? draft
                          ? "Regenerating…"
                          : "Generating…"
                        : draft
                          ? "Regenerate draft"
                          : "Generate draft"}
                    </Button>
                  ) : null;
                const sendButton =
                  c.status === "active" &&
                  c.nextStepLabel != null &&
                  c.nextStepChannel !== "direct_mail" ? (
                    <Button
                      variant={sendDisabled ? "ghost" : "receipt"}
                      size="sm"
                      title={sendTitle}
                      disabled={sendDisabled}
                      onClick={() => {
                        if (!draft) return;
                        sendNext.mutate({ prospectId: c.prospectId, playName: c.playName });
                      }}
                      {...readOnly}
                    >
                      {sendPending ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <Send size={11} />
                      )}
                      {sendPending
                        ? "Sending…"
                        : c.nextStepIsBreakup
                          ? "Send breakup"
                          : "Send this one"}
                    </Button>
                  ) : null;
                const letter =
                  c.status === "active" && c.nextStepChannel === "direct_mail" ? (
                    <LetterEmpty
                      note={`Next step goes by post${c.nextStepLabel ? ` · ${c.nextStepLabel}` : ""}.`}
                      actions={
                        <>
                          <Button size="sm" disabled={c.isSending} onClick={() => setMailKey(key)}>
                            {c.businessAddress ? "Review mail" : "Add business address"}
                          </Button>
                          {stopButton}
                        </>
                      }
                    />
                  ) : c.status === "active" && c.nextStepLabel != null ? (
                    draft ? (
                      <LetterCard
                        meta={`drafted ${timeAgo(draft.draftedAt)} · preview, not sent`}
                        subject={draft.subject}
                        stateLine={<DraftStateLine sent={false} flags={draft.flags} />}
                        body={draft.body}
                        foot={{
                          left: regenerateButton,
                          right: (
                            <>
                              {!sendDisabled && (
                                <span className="font-mono text-[11px] text-[color:var(--ink-receipt-2)]">
                                  ready · no flags
                                </span>
                              )}
                              {sendButton}
                              {stopButton}
                            </>
                          ),
                        }}
                        sendable={!sendDisabled}
                      />
                    ) : (
                      <LetterEmpty
                        note={`No draft yet for the ${c.nextStepLabel}. Drafting is a dry run and never sends.`}
                        actions={
                          <>
                            {regenerateButton}
                            {stopButton}
                          </>
                        }
                      />
                    )
                  ) : (
                    <LetterEmpty
                      note={
                        c.status === "replied"
                          ? "They replied — the conversation lives on /inbox."
                          : c.status === "active"
                            ? "No steps left in this cadence."
                            : "Nothing left to send."
                      }
                    />
                  );
                return (
                  <Fragment key={`${c.prospectId}-${c.playName}`}>
                    <tr
                      onClick={(e) => {
                        // Ignore clicks that originated on interactive
                        // controls inside the row (buttons / inputs /
                        // links / labels). Without this guard, clicking
                        // Preview / Send / Stop / the checkbox would
                        // ALSO toggle the row expansion.
                        const t = e.target as HTMLElement;
                        if (t.closest("button, input, a, label, [role='button']")) return;
                        toggleExpanded(key);
                      }}
                      className={cn(
                        "cursor-pointer border-b border-ink-rule/60 transition-colors duration-[var(--dur-stamp)]",
                        "hover:bg-ink-surface/60",
                        i % 2 === 1 && "bg-ink-surface/20",
                        open && "bg-ink-surface",
                      )}
                    >
                      <td className="px-3 py-[10px]" style={{ width: 32 }}>
                        <input
                          type="checkbox"
                          aria-label={`select ${c.prospectName ?? c.prospectEmail ?? "row"}`}
                          title={
                            c.status === "active"
                              ? `select for batch preview / send`
                              : `only active cadences can be selected (status: ${c.status})`
                          }
                          disabled={c.status !== "active" || c.nextStepChannel === "direct_mail"}
                          checked={selected.has(rowKey(c))}
                          onChange={() => toggleSelected(rowKey(c))}
                          className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-30"
                        />
                      </td>
                      <IdentityCell
                        className="pl-3"
                        identity={{
                          name: c.prospectName,
                          email: c.prospectEmail,
                          title: c.prospectTitle,
                          company: knownCompany,
                          linkedinUrl: c.prospectLinkedinUrl,
                        }}
                        line2Privacy="show"
                        line2={<SignalLabel tone={state.tone}>{state.text}</SignalLabel>}
                      />
                      <td className="whitespace-nowrap py-[10px] pr-6 text-ink-cream-2">
                        {c.playName}
                      </td>
                      <td className="whitespace-nowrap py-[10px] pr-6">
                        {/* Sending, reply and send-failed now live on line 2;
                            the failure's message keeps its tooltip here. */}
                        <span
                          title={
                            !c.isSending && c.status === "active" && c.lastSendError
                              ? `${c.lastSendError}${
                                  c.lastSendErrorAt ? ` · ${timeAgo(c.lastSendErrorAt)}` : ""
                                } — click Send to retry`
                              : undefined
                          }
                        >
                          <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                        </span>
                      </td>
                      <td className="whitespace-nowrap py-[10px] text-right font-mono text-[11px] text-ink-faint">
                        {timeAgo(c.enrolledAt)}
                      </td>
                      <td className="whitespace-nowrap px-6 py-[10px] text-right">
                        <div className="flex items-center justify-end gap-1">
                          {(c.status === "active" || c.status === "paused") && (
                            <Button
                              variant="ghost"
                              size="sm"
                              title="mark that this prospect replied on LinkedIn"
                              onClick={() =>
                                setLinkedinReplyModal({
                                  prospectId: c.prospectId,
                                  prospectName: c.prospectName,
                                })
                              }
                            >
                              <MessageCircle size={12} />
                            </Button>
                          )}
                          {c.status === "active" &&
                            (() => {
                              if (c.nextStepChannel === "direct_mail")
                                return (
                                  <>
                                    <Button
                                      size="sm"
                                      disabled={c.isSending}
                                      onClick={() => setMailKey(rowKey(c))}
                                    >
                                      {c.businessAddress ? "Review mail" : "Add business address"}
                                    </Button>
                                    {c.priorSteps.length > 0 && (
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        title="View cadence history"
                                        onClick={() => toggleExpanded(key)}
                                      >
                                        <ChevronDown size={12} />
                                      </Button>
                                    )}
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      title="Stop cadence"
                                      disabled={stop.isPending || c.isSending}
                                      onClick={() =>
                                        setStopModal({
                                          prospectId: c.prospectId,
                                          prospectName: c.prospectName,
                                          playName: c.playName,
                                        })
                                      }
                                    >
                                      <CircleStop size={12} />
                                    </Button>
                                  </>
                                );
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
                                    {...readOnly}
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
                                            ? `send breakup (final touch) — sends now, no more emails after this${earlyNote}`
                                            : `send next step — sends now${earlyNote}`
                                    }
                                    disabled={sendDisabled}
                                    onClick={() => {
                                      if (!draft) return;
                                      sendNext.mutate({
                                        prospectId: c.prospectId,
                                        playName: c.playName,
                                      });
                                    }}
                                    {...readOnly}
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
                                    title={
                                      c.isSending
                                        ? "wait for the in-flight send to finish before stopping"
                                        : "stop cadence"
                                    }
                                    disabled={stop.isPending || c.isSending}
                                    onClick={() =>
                                      setStopModal({
                                        prospectId: c.prospectId,
                                        prospectName: c.prospectName,
                                        playName: c.playName,
                                      })
                                    }
                                  >
                                    <CircleStop size={12} />
                                  </Button>
                                </>
                              );
                            })()}
                          {/* Chevron for non-active rows with history — the active-status
                            block renders its own above. */}
                          {c.status !== "active" &&
                            (c.priorSteps.length > 0 || c.status === "stopped") &&
                            (() => {
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
                    {open && (
                      <Sheet
                        colSpan={6}
                        indent="pl-14"
                        theCase={
                          <>
                            <SheetHeading label="the case" />
                            {reminderSignal && (
                              <SignalLabel className="-mt-1">{reminderSignal}</SignalLabel>
                            )}
                            {fitReason && (
                              <p className="m-0 text-[13px] leading-5 text-ink-cream-2 [text-wrap:pretty]">
                                {fitReason}
                              </p>
                            )}
                            {(reminderSignal || fitReason) && <Rule />}
                            <CaseList rows={caseRows} />
                            {c.priorSteps.length > 0 && (
                              <>
                                <Rule />
                                <div>
                                  <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                                    sent so far · {c.priorSteps.length}
                                  </div>
                                  <ol className="flex flex-col gap-2">
                                    {c.priorSteps.map((st) => (
                                      <li key={st.stepIndex} className="flex flex-col gap-1">
                                        <div className="flex items-baseline gap-3 leading-4">
                                          <span className="w-[64px] shrink-0 text-right font-mono text-[11px] text-ink-faint">
                                            {timeAgo(st.sentAt)}
                                          </span>
                                          <span className="shrink-0 whitespace-nowrap text-ink-cream-2">
                                            step {st.stepIndex} · {st.label}
                                          </span>
                                          <span className="min-w-0 truncate text-ink-muted">
                                            {st.subject}
                                          </span>
                                        </div>
                                        <div className="pl-[76px]">
                                          {st.body ? (
                                            <Disclosure label="body">
                                              <pre className="ln-prose mt-2 whitespace-pre-wrap text-[12px] text-ink-cream-2">
                                                {st.body}
                                              </pre>
                                            </Disclosure>
                                          ) : (
                                            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                                              body not captured
                                            </span>
                                          )}
                                        </div>
                                      </li>
                                    ))}
                                  </ol>
                                </div>
                              </>
                            )}
                          </>
                        }
                        theLetter={letter}
                      />
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
              {...readOnly}
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
                      {c.prospectEmail ? <Pii kind="email">{c.prospectEmail}</Pii> : "(no email)"}
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
        open={linkedinReplyModal != null}
        onClose={closeLinkedinReplyModal}
        title={`Mark LinkedIn reply${linkedinReplyModal?.prospectName ? ` — ${mask("name", linkedinReplyModal.prospectName)}` : ""}`}
        footer={
          <>
            <Button variant="ghost" onClick={closeLinkedinReplyModal}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (linkedinReplyModal) {
                  markLinkedInReply.mutate({
                    prospectId: linkedinReplyModal.prospectId,
                    body: linkedinReplyBody,
                  });
                }
              }}
              disabled={markLinkedInReply.isPending}
              {...readOnly}
            >
              {markLinkedInReply.isPending ? "Recording…" : "Mark replied"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <div className="text-[12px] text-ink-muted">
            This records a LinkedIn reply and stops every active or paused email cadence for this
            prospect. An email already in flight cannot be recalled and may still complete.
          </div>
          <label className="text-[12px] text-ink-muted" htmlFor="linkedin-reply-body">
            What they said (optional) — stored so a reply can be drafted from it later.
          </label>
          <textarea
            id="linkedin-reply-body"
            className="min-h-[96px] w-full rounded border border-line bg-surface p-2 text-[12px]"
            value={linkedinReplyBody}
            onChange={(e) => setLinkedinReplyBody(e.currentTarget.value)}
            placeholder="Paste their message…"
          />
        </div>
      </Modal>

      <Modal
        open={stopModal != null}
        onClose={() => {
          setStopModal(null);
          setStopReason("bad_timing");
          setStopNote("");
        }}
        title={`Stop cadence${stopModal?.prospectName ? ` — ${mask("name", stopModal.prospectName)}` : ""}`}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setStopModal(null);
                setStopReason("bad_timing");
                setStopNote("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!stopModal) return;
                stop.mutate({
                  prospectId: stopModal.prospectId,
                  playName: stopModal.playName,
                  reason: stopReason,
                  ...(stopNote.trim() ? { note: stopNote.trim() } : {}),
                });
              }}
              disabled={stop.isPending || (stopReason === "other" && !stopNote.trim())}
              {...readOnly}
            >
              {stop.isPending ? "Stopping…" : "Stop cadence"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="text-[12px] text-ink-muted">
            This stops only <code>{stopModal?.playName}</code>. The prospect will be excluded from
            Expandi. Bad timing and Other may return through breakup-revive after 60–90 days;
            permanent reasons will not.
          </div>
          <Field label="Reason">
            <Select
              value={stopReason}
              onChange={(e) => setStopReason(e.target.value as CadenceStopReason)}
            >
              {(Object.entries(STOP_REASON_LABELS) as Array<[CadenceStopReason, string]>).map(
                ([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ),
              )}
            </Select>
          </Field>
          <Field
            label={stopReason === "other" ? "Notes (required)" : "Notes (optional)"}
            hint="Stored with the cadence for future context."
          >
            <Textarea
              value={stopNote}
              maxLength={500}
              onChange={(e) => setStopNote(e.target.value)}
              placeholder="Why are you stopping this cadence?"
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={outcomeModal != null}
        onClose={() => setOutcomeModal(null)}
        title={`Log outcome${outcomeModal?.prospectName ? ` — ${mask("name", outcomeModal.prospectName)}` : ""}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOutcomeModal(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => logOutcome.mutate()}
              disabled={logOutcome.isPending}
              {...readOnly}
            >
              {logOutcome.isPending ? "Saving…" : "Save outcome"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="font-mono text-[12px] text-ink-muted">
            Prospect: <span className="text-ink-cream-2">{mask("email", outcomeModal?.email)}</span>
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
  value: number | string;
  caption?: string;
  tone?: "neutral" | "receipt" | "signal" | "spend" | "blocked";
}) {
  const captionColor =
    tone === "spend"
      ? "var(--ink-spend-2)"
      : tone === "receipt"
        ? "var(--ink-receipt-2)"
        : tone === "signal"
          ? "var(--ink-signal-2)"
          : tone === "blocked"
            ? "var(--ink-blocked-2)"
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

const EMPTY_COUNTS: CadenceCounts = {
  active: 0,
  replied: 0,
  breakup: 0,
  completed: 0,
  paused: 0,
  stopped: 0,
  bounced: 0,
  overdue: 0,
};
