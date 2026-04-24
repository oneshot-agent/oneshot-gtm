import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CircleStop, Trophy } from "lucide-react";
import { useMemo, useState } from "react";
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

// Mirror of the step counts defined in packages/plays/src/_cadence.ts.
// `steps` = number of follow-up steps after the initial send. We show
// `steps + 1` dots on the progress indicator to include day-0.
const PLAY_STEPS: Record<string, number> = {
  "show-hn": 1,
  "job-change": 3,
  "post-funding": 3,
  "accelerator-batch": 3,
  concierge: 3,
  "demo-no-show": 2,
  "competitor-switch": 1,
  "hiring-signal": 1,
  "podcast-guest": 1,
  "breakup-revive": 1,
};

export const Route = createFileRoute("/cadences")({
  component: CadencesPage,
});

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
      void qc.invalidateQueries({ queryKey: ["home"] });
      toast.success(`stopped cadence · ${vars.playName}`);
    },
    onError: (err) => toast.error(`couldn't stop cadence: ${err.message}`),
  });

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
                const totalSteps = (PLAY_STEPS[c.playName] ?? 0) + 1;
                const isOverdue =
                  c.status === "active" && c.nextDueAt !== null && c.nextDueAt <= nowIso;
                return (
                  <tr
                    key={`${c.prospectId}-${c.playName}`}
                    className={cn(
                      "border-b border-ink-rule/60 transition-colors duration-[var(--dur-stamp)]",
                      "hover:bg-ink-surface/60",
                      i % 2 === 1 && "bg-ink-surface/20",
                    )}
                  >
                    <td className="px-6 py-2">
                      <div className="text-ink-cream">{c.prospectName ?? "(unknown)"}</div>
                      <div className="font-mono text-[11px] text-ink-faint">
                        {c.prospectEmail ?? "—"}
                      </div>
                    </td>
                    <td className="py-2 text-ink-cream-2">{c.playName}</td>
                    <td className="py-2">
                      <Badge tone={statusTone(c.status)}>{c.status}</Badge>
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
                        {c.status === "active" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            title="stop cadence"
                            disabled={stop.isPending}
                            onClick={() =>
                              stop.mutate({ prospectId: c.prospectId, playName: c.playName })
                            }
                          >
                            <CircleStop size={12} />
                          </Button>
                        )}
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
                );
              })}
            </tbody>
          </table>
        )}
      </section>

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
