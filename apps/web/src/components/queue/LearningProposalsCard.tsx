import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  LearningGuidanceView,
  LearningKind,
  LearningProposalView,
} from "@oneshot-gtm/shared-types";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../api/client.ts";
import {
  LEARNING_KINDS,
  countChips,
  editableText,
  editedValue,
  learningKindLabel,
  proposalTitle,
  valueLines,
} from "../../lib/learning.ts";
import { READ_ONLY, readOnly } from "../../lib/readOnly.ts";
import { Button } from "../primitives/Button.tsx";
import { Field, Textarea } from "../primitives/Field.tsx";

/**
 * Unified learning review (issue #813). Every learned change — a writing
 * preference, a prospect's angle, a play's configured angles, the ICP
 * one-liner — waits here. Approve applies it to drafts written from now on;
 * edit-and-approve applies the founder's wording instead; dismiss keeps the
 * text from coming straight back; rollback restores what was active before.
 * Nothing here touches an existing draft.
 *
 * `kind` and `prospectId` come from the queue's search params (a link from
 * Replies or a prospect's sheet) and are plain props so the card renders
 * without a router. Nothing renders when there is nothing to review and no
 * filter was asked for — the common case.
 */
export function LearningProposalsCard({
  kind: lockedKind,
  prospectId,
}: {
  kind?: LearningKind;
  prospectId?: number;
}) {
  const qc = useQueryClient();
  const [kindFilter, setKindFilter] = useState<LearningKind | "all">(lockedKind ?? "all");
  const kind = lockedKind ?? (kindFilter === "all" ? undefined : kindFilter);
  const proposalsQuery = useQuery({
    queryKey: ["learning-proposals", kind ?? "all", prospectId ?? null],
    queryFn: () => api.learningProposals({ kind, prospectId, status: "all" }),
    refetchInterval: 60_000,
  });
  const guidanceQuery = useQuery({
    queryKey: ["learning-guidance"],
    queryFn: () => api.learningGuidance(),
    refetchInterval: 60_000,
  });
  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ["learning-proposals"] });
    void qc.invalidateQueries({ queryKey: ["learning-guidance"] });
    void qc.invalidateQueries({ queryKey: ["icp-proposals"] });
    void qc.invalidateQueries({ queryKey: ["setup"] });
    void qc.invalidateQueries({ queryKey: ["triggers"] });
  };
  const approve = useMutation({
    mutationFn: (vars: { id: string; value?: unknown }) =>
      api.approveLearningProposal(vars.id, vars.value),
    onSuccess: () => {
      toast.success("Approved — applies to drafts from now on");
      invalidate();
    },
    onError: (err: Error) => toast.error(`couldn't approve · ${err.message}`),
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => api.dismissLearningProposal(id),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(`couldn't dismiss · ${err.message}`),
  });
  const rollback = useMutation({
    mutationFn: (id: string) => api.rollbackLearningProposal(id),
    onSuccess: () => {
      toast.success("Rolled back — the previous value is active again");
      invalidate();
    },
    onError: (err: Error) => toast.error(`couldn't roll back · ${err.message}`),
  });
  const setGuidance = useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) =>
      api.setLearningGuidance(vars.id, vars.enabled),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  });
  const rollbackGuidance = useMutation({
    mutationFn: (id: string) => api.rollbackLearningGuidance(id),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  });

  const all = proposalsQuery.data?.proposals ?? [];
  const pending = all.filter((p) => p.status === "pending");
  const applied = all.filter((p) => p.status === "approved").slice(0, 10);
  const guidance = (guidanceQuery.data?.guidance ?? []).filter((g) => g.status !== "rolled_back");
  const showGuidance = !kind || kind === "preference";
  const busy = approve.isPending || dismiss.isPending || rollback.isPending || READ_ONLY;
  const nothing =
    pending.length === 0 && applied.length === 0 && (!showGuidance || guidance.length === 0);
  if (nothing && !lockedKind && kindFilter === "all") return null;

  return (
    <section
      className="space-y-3 border-b border-ink-rule px-6 py-4"
      aria-label="Learning proposals"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="ln-eyebrow" style={{ color: "var(--ink-receipt-2)" }}>
          Learning · {pending.length} to review
        </span>
        {!lockedKind && (
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Kind">
            {[{ kind: "all" as const, label: "All" }, ...LEARNING_KINDS].map((k) => (
              <Button
                key={k.kind}
                size="sm"
                variant={kindFilter === k.kind ? "secondary" : "ghost"}
                onClick={() => setKindFilter(k.kind)}
              >
                {k.label}
              </Button>
            ))}
          </div>
        )}
        {prospectId != null && (
          <span className="font-mono text-[11px] text-ink-muted">prospect #{prospectId}</span>
        )}
      </div>
      {nothing && (
        <p className="text-[12px] text-ink-muted">
          Nothing learned is waiting for review{kind ? ` for ${learningKindLabel(kind)}` : ""}.
          Proposals appear as replies, edits and outcomes accumulate; nothing applies until you
          approve it.
        </p>
      )}
      {pending.map((p) => (
        <ProposalRow
          key={p.id}
          proposal={p}
          busy={busy}
          onApprove={(value) => approve.mutate({ id: p.id, value })}
          onDismiss={() => dismiss.mutate(p.id)}
        />
      ))}
      {applied.length > 0 && (
        <details className="text-[12px] text-ink-muted">
          <summary className="cursor-pointer">Applied ({applied.length})</summary>
          <div className="mt-2 space-y-2">
            {applied.map((p) => (
              <div
                key={p.id}
                className="flex items-start justify-between gap-3 border-l border-ink-rule pl-3"
              >
                <div>
                  <p className="text-ink-cream-2">{proposalTitle(p)}</p>
                  {valueLines(p.kind, p.decided ?? p.proposed).map((line) => (
                    <p key={line} className="mt-0.5">
                      {line}
                    </p>
                  ))}
                  <p className="mt-0.5">
                    Approved {p.decidedAt ? new Date(p.decidedAt).toLocaleDateString() : ""}
                    {p.decided != null ? " · edited" : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => rollback.mutate(p.id)}
                  {...readOnly}
                >
                  Roll back
                </Button>
              </div>
            ))}
          </div>
        </details>
      )}
      {showGuidance && guidance.length > 0 && (
        <details className="text-[12px] text-ink-muted">
          <summary className="cursor-pointer">
            Approved writing preferences ({guidance.filter((g) => g.status === "enabled").length}{" "}
            active)
          </summary>
          <div className="mt-2 space-y-2">
            {guidance.map((g) => (
              <GuidanceRow
                key={g.id}
                guidance={g}
                busy={setGuidance.isPending || rollbackGuidance.isPending || READ_ONLY}
                onToggle={() => setGuidance.mutate({ id: g.id, enabled: g.status !== "enabled" })}
                onRollback={() => rollbackGuidance.mutate(g.id)}
              />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function ProposalRow({
  proposal: p,
  busy,
  onApprove,
  onDismiss,
}: {
  proposal: LearningProposalView;
  busy: boolean;
  onApprove: (value?: unknown) => void;
  onDismiss: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const editable = editableText(p);
  const [draft, setDraft] = useState(editable.value);
  const current = valueLines(p.kind, p.current);
  const proposed = valueLines(p.kind, p.proposed);
  const chips = countChips(p.evidence.counts);
  const samples = p.evidence.samples ?? [];
  return (
    <div className="rounded-sm border border-[color:var(--ink-receipt)]/50 bg-[color:var(--ink-receipt)]/6 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="ln-eyebrow" style={{ color: "var(--ink-receipt-2)" }}>
          {proposalTitle(p)}
        </div>
        {p.legacy && (
          <span className="font-mono text-[10px] uppercase text-ink-muted">
            learned before review existed
          </span>
        )}
        {p.kind === "campaign_angle" && (
          <span className="font-mono text-[10px] uppercase text-ink-muted">
            hypothesis · observational
          </span>
        )}
      </div>
      <div className="mt-1 grid gap-1 text-[13px] leading-5">
        {current.length > 0 && (
          <div className="text-ink-muted">
            Current:{" "}
            {current.map((line) => (
              <span key={line} className="block text-ink-cream-2">
                {line}
              </span>
            ))}
          </div>
        )}
        <div className="text-ink-cream">
          Proposed:{" "}
          {proposed.map((line) => (
            <span key={line} className="block font-medium">
              {line}
            </span>
          ))}
        </div>
      </div>
      <p className="mt-1.5 text-[12px] leading-5 text-ink-muted">{p.evidenceSummary}</p>
      {(chips.length > 0 || p.evidence.method) && (
        <div className="mt-1 flex flex-wrap items-center gap-1 font-mono text-[11px] text-ink-muted">
          {p.evidence.method && <span>method {p.evidence.method}</span>}
          {chips.map((c) => (
            <span key={c} className="rounded border border-ink-rule px-1">
              {c}
            </span>
          ))}
          <span>
            {p.evidence.refs.length} source{p.evidence.refs.length === 1 ? "" : "s"}
          </span>
        </div>
      )}
      {samples.length > 0 && (
        <details className="mt-2 text-[12px] text-ink-muted">
          <summary className="cursor-pointer">Evidence ({samples.length})</summary>
          <div className="mt-2 space-y-3">
            {samples.map((s) => (
              <div
                key={`${s.at ?? ""}|${s.name ?? ""}|${(s.sent ?? s.original ?? s.text ?? "").slice(0, 60)}`}
                className="border-l border-ink-rule pl-3"
              >
                {(s.name || s.at) && (
                  <p>
                    {s.name ?? ""}
                    {s.at ? ` · ${new Date(s.at).toLocaleDateString()}` : ""}
                  </p>
                )}
                {(s.feedback ?? []).map((f) => (
                  <p key={f} className="mt-1">
                    Feedback: {f}
                  </p>
                ))}
                {s.text && (
                  <p className="mt-1 whitespace-pre-wrap">
                    {s.label ? `${s.label}: ` : ""}
                    {s.text}
                  </p>
                )}
                {s.original && <p className="mt-1 whitespace-pre-wrap">Suggested: {s.original}</p>}
                {s.sent && (
                  <p className="mt-1 whitespace-pre-wrap text-ink-cream">Sent: {s.sent}</p>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
      {editing && (
        <div className="mt-2">
          <Field label={editable.label}>
            <Textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
          </Field>
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            <Button
              size="sm"
              disabled={busy || !draft.trim()}
              onClick={() => onApprove(editedValue(p, draft.trim()))}
              {...readOnly}
            >
              Approve edited
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" disabled={busy} onClick={() => onApprove()} {...readOnly}>
              Approve
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setEditing(true)}
              {...readOnly}
            >
              Edit &amp; approve
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onDismiss} {...readOnly}>
              Dismiss
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function GuidanceRow({
  guidance: g,
  busy,
  onToggle,
  onRollback,
}: {
  guidance: LearningGuidanceView;
  busy: boolean;
  onToggle: () => void;
  onRollback: () => void;
}) {
  const scope = [
    g.channel === "email" ? "email" : g.channel === "linkedin" ? "LinkedIn" : "all channels",
    g.stage === "first_touch"
      ? "first touches"
      : g.stage === "follow_up"
        ? "follow-ups"
        : g.stage === "reply"
          ? "replies"
          : "all stages",
  ].join(" · ");
  return (
    <div className="flex items-start justify-between gap-3 border-l border-ink-rule pl-3">
      <div>
        <p className={g.status === "enabled" ? "text-ink-cream" : "text-ink-muted"}>
          {g.instruction}
        </p>
        <p className="mt-0.5">
          {g.source === "explicit"
            ? "Explicit feedback"
            : g.source === "edits"
              ? "Repeated edits"
              : "Style examples"}{" "}
          · {scope} · {g.status === "enabled" ? "Enabled" : "Disabled"}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onToggle} {...readOnly}>
          {g.status === "enabled" ? "Disable" : "Enable"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onRollback} {...readOnly}>
          Roll back
        </Button>
      </div>
    </div>
  );
}
