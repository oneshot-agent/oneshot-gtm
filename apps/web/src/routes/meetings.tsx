import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import type { MeetingOutcomeView, MeetingView } from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { Button } from "../components/primitives/Button.tsx";
import { EmptyNote } from "../components/primitives/EmptyNote.tsx";
import { Field } from "../components/primitives/Field.tsx";
import { Modal } from "../components/primitives/Modal.tsx";
import { Select, Textarea } from "../components/primitives/Field.tsx";
import { SkeletonRow } from "../components/primitives/Skeleton.tsx";
import { cn, timeAgo } from "../lib/cn.ts";
import { useMask } from "../lib/privacy.tsx";

export const Route = createFileRoute("/meetings")({
  staticData: { title: "Meetings" },
  component: MeetingsPage,
});

const OUTCOME_LABELS: Record<MeetingOutcomeView, string> = {
  held: "held",
  no_show: "no-show",
  cancelled: "cancelled",
  rescheduled: "rescheduled",
};

function MeetingsPage() {
  const query = useQuery({
    queryKey: ["meetings"],
    queryFn: api.meetings,
    refetchInterval: 60_000,
  });
  const queryClient = useQueryClient();
  const mask = useMask();
  const [outcomeTarget, setOutcomeTarget] = useState<MeetingView | null>(null);
  const [outcomeKind, setOutcomeKind] = useState<MeetingOutcomeView>("held");
  const [outcomeNote, setOutcomeNote] = useState("");

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["meetings"] });

  const logOutcome = useMutation({
    mutationFn: async () => {
      if (!outcomeTarget) throw new Error("no meeting selected");
      return api.logMeetingOutcome({
        calendarId: outcomeTarget.calendarId,
        eventId: outcomeTarget.eventId,
        outcome: outcomeKind,
        ...(outcomeNote.trim() ? { note: outcomeNote.trim() } : {}),
      });
    },
    onSuccess: () => {
      setOutcomeTarget(null);
      invalidate();
      toast.success("outcome recorded");
    },
    onError: (err) => toast.error(`couldn't record outcome · ${err.message}`),
  });

  const confirmMatch = useMutation({
    mutationFn: (m: MeetingView) =>
      api.confirmMeetingMatch({
        calendarId: m.calendarId,
        eventId: m.eventId,
        prospectId: m.suggestedProspectId!,
      }),
    onSuccess: () => {
      invalidate();
      toast.success("match confirmed");
    },
    onError: (err) => toast.error(`couldn't confirm · ${err.message}`),
  });

  const dismissMatch = useMutation({
    mutationFn: (m: MeetingView) =>
      api.dismissMeetingMatch({ calendarId: m.calendarId, eventId: m.eventId }),
    onSuccess: () => {
      invalidate();
      toast.success("match dismissed");
    },
    onError: (err) => toast.error(`couldn't dismiss · ${err.message}`),
  });

  const awaitingOutcome = query.data?.awaitingOutcome ?? [];
  const needsReview = query.data?.needsReview ?? [];

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="ln-eyebrow mb-1">Meetings</h1>
        <p className="text-[13px] text-ink-muted">
          Past calls from your calendar that need an outcome, and matches that need a decision.
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] font-medium text-ink-cream">
          Awaiting outcome {awaitingOutcome.length > 0 && `(${awaitingOutcome.length})`}
        </h2>
        {query.isLoading ? (
          <div className="rounded-[var(--radius-md)] border border-ink-rule">
            {[0, 1, 2].map((i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : awaitingOutcome.length === 0 ? (
          <EmptyNote note="Nothing waiting. Every past meeting with a matched prospect has an outcome logged." />
        ) : (
          <div className="flex flex-col divide-y divide-ink-rule rounded-[var(--radius-md)] border border-ink-rule">
            {awaitingOutcome.map((m) => (
              <div
                key={`${m.calendarId}:${m.eventId}`}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-ink-cream">
                    {m.summary ?? "(no title)"}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-muted">
                    <span>{m.startsAt ? timeAgo(m.startsAt) : "—"}</span>
                    {m.prospectEmail && <span>· {mask("email", m.prospectEmail)}</span>}
                    {m.prospectName && <span>· {mask("name", m.prospectName)}</span>}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setOutcomeTarget(m);
                    setOutcomeKind("held");
                    setOutcomeNote("");
                  }}
                >
                  Log outcome
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] font-medium text-ink-cream">
          Needs review {needsReview.length > 0 && `(${needsReview.length})`}
        </h2>
        {query.isLoading ? null : needsReview.length === 0 ? (
          <EmptyNote note="No uncertain matches. Every calendar meeting the poller found is either linked to a known prospect or has no plausible one." />
        ) : (
          <div className="flex flex-col divide-y divide-ink-rule rounded-[var(--radius-md)] border border-ink-rule">
            {needsReview.map((m) => (
              <div
                key={`${m.calendarId}:${m.eventId}`}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-ink-cream">
                    {m.summary ?? "(no title)"}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-muted">
                    <span>{m.startsAt ? timeAgo(m.startsAt) : "—"}</span>
                    {m.suggestedProspectEmail && (
                      <span>
                        · maybe {mask("email", m.suggestedProspectEmail)}
                        {m.matchReason ? ` (${m.matchReason})` : ""}
                      </span>
                    )}
                    {m.matchStatus === "ambiguous" && !m.suggestedProspectEmail && (
                      <span
                        className={cn(
                          "rounded-[var(--radius-xs)] border border-ink-rule/60 px-1.5 py-[1px]",
                          "uppercase tracking-[0.08em]",
                        )}
                      >
                        ambiguous
                      </span>
                    )}
                  </div>
                </div>
                {m.suggestedProspectId != null && (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => dismissMatch.mutate(m)}
                      disabled={dismissMatch.isPending}
                    >
                      Dismiss
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => confirmMatch.mutate(m)}
                      disabled={confirmMatch.isPending}
                    >
                      Confirm
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <Modal
        open={outcomeTarget != null}
        onClose={() => setOutcomeTarget(null)}
        title={`Log outcome${outcomeTarget?.summary ? ` — ${outcomeTarget.summary}` : ""}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOutcomeTarget(null)}>
              Cancel
            </Button>
            <Button onClick={() => logOutcome.mutate()} disabled={logOutcome.isPending}>
              {logOutcome.isPending ? "Saving…" : "Save outcome"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {outcomeTarget?.prospectEmail && (
            <div className="font-mono text-[12px] text-ink-muted">
              Prospect:{" "}
              <span className="text-ink-cream-2">{mask("email", outcomeTarget.prospectEmail)}</span>
            </div>
          )}
          <Field label="Outcome">
            <Select
              value={outcomeKind}
              onChange={(e) => setOutcomeKind(e.target.value as MeetingOutcomeView)}
            >
              {(Object.entries(OUTCOME_LABELS) as Array<[MeetingOutcomeView, string]>).map(
                ([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ),
              )}
            </Select>
          </Field>
          <Field label="Notes (optional)" hint="Paste a transcript or summarize what happened.">
            <Textarea
              rows={4}
              value={outcomeNote}
              onChange={(e) => setOutcomeNote(e.target.value)}
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
