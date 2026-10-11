import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  LearningGuidanceView,
  LearningKind,
  LearningProposalView,
} from "@oneshot-gtm/shared-types";
import { Check, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../../api/client.ts";
import {
  changedLines,
  editableText,
  editedValue,
  kindTag,
  learningKindLabel,
  valueLines,
  whyLine,
} from "../../lib/learning.ts";
import { READ_ONLY, readOnly } from "../../lib/readOnly.ts";
import { Button } from "../primitives/Button.tsx";
import { Pii } from "../primitives/Pii.tsx";
import { Textarea } from "../primitives/Field.tsx";

/**
 * Learning review (issue #813), as a strip of flat rows above the queue.
 * Each pending row is the change in one glance — a kind tag, the lines that
 * differ from what is active, one line on where it was learned from — and
 * approve / dismiss in the same words as the queue rows below. What it was,
 * the evidence excerpts and an edit box are behind the row's details. The
 * history of applied changes and active writing preferences is one collapsed
 * line. Nothing here touches an existing draft.
 *
 * `kind` and `prospectId` come from the queue's search params (a link from
 * Replies or a prospect's sheet) and are plain props so the strip renders
 * without a router.
 */
export function LearningProposalsCard({
  kind,
  prospectId,
}: {
  kind?: LearningKind;
  prospectId?: number;
}) {
  const qc = useQueryClient();
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
  const active = guidance.filter((g) => g.status === "enabled").length;
  const narrowed = kind != null;
  const busy = approve.isPending || dismiss.isPending || rollback.isPending || READ_ONLY;
  const historyBusy = rollback.isPending || setGuidance.isPending || rollbackGuidance.isPending;
  const hasHistory = applied.length > 0 || guidance.length > 0;
  if (pending.length === 0 && !hasHistory && !narrowed) return null;

  const scope = narrowed ? narrowedLabel(kind, prospectId, pending[0] ?? all[0]) : null;
  const historyLabel = [
    applied.length > 0 ? `${applied.length} applied` : null,
    guidance.length > 0 ? `${active} preference${active === 1 ? "" : "s"} active` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="border-b border-ink-rule" aria-label="Learning proposals">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-6 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="ln-eyebrow" style={{ color: "var(--ink-receipt-2)" }}>
            Learning · {scope ?? `${pending.length} to review`}
          </span>
          {narrowed && (
            <a href="/queue" className="text-[12px] text-ink-muted underline hover:text-ink-cream">
              show all
            </a>
          )}
        </div>
        {hasHistory && (
          <details className="group ml-auto text-[12px] text-ink-muted open:basis-full">
            <summary className="ml-auto w-fit cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              {historyLabel}
              <span className="ml-1 inline-block transition-transform group-open:rotate-90">›</span>
            </summary>
            <div className="mt-2 space-y-2 border-l border-ink-rule pl-3">
              {applied.map((p) => (
                <HistoryRow
                  key={p.id}
                  lines={changedLines(p)}
                  meta={`${kindTag(p).kind}${p.decidedAt ? ` · ${new Date(p.decidedAt).toLocaleDateString()}` : ""}${p.decided != null ? " · edited" : ""}`}
                  busy={historyBusy || READ_ONLY}
                  actions={[{ label: "Roll back", onClick: () => rollback.mutate(p.id) }]}
                />
              ))}
              {guidance.map((g) => (
                <HistoryRow
                  key={g.id}
                  lines={[g.instruction]}
                  muted={g.status !== "enabled"}
                  meta={`Writing · ${guidanceScope(g)}${g.status === "enabled" ? "" : " · off"}`}
                  busy={historyBusy || READ_ONLY}
                  actions={[
                    {
                      label: g.status === "enabled" ? "Disable" : "Enable",
                      onClick: () =>
                        setGuidance.mutate({ id: g.id, enabled: g.status !== "enabled" }),
                    },
                    { label: "Roll back", onClick: () => rollbackGuidance.mutate(g.id) },
                  ]}
                />
              ))}
            </div>
          </details>
        )}
      </div>
      {pending.length === 0 && narrowed && (
        <p className="px-6 pb-3 text-[12px] text-ink-muted">
          Nothing is waiting for review here. Proposals appear as replies, edits and outcomes
          accumulate; nothing applies until you approve it.
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
    </section>
  );
}

function narrowedLabel(
  kind: LearningKind | undefined,
  prospectId: number | undefined,
  sample: LearningProposalView | undefined,
): string {
  if (kind === "prospect_angle" && prospectId != null) {
    const name = sample?.scopeLabel;
    return `angle for ${name ?? `#${prospectId}`}`;
  }
  return kind ? learningKindLabel(kind).toLowerCase() : "all";
}

function guidanceScope(g: LearningGuidanceView): string {
  return [
    g.channel === "email" ? "email" : g.channel === "linkedin" ? "LinkedIn" : "all channels",
    g.stage === "first_touch"
      ? "first touches"
      : g.stage === "follow_up"
        ? "follow-ups"
        : g.stage === "reply"
          ? "replies"
          : "all stages",
  ].join(" · ");
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
  const tag = kindTag(p);
  const headline = changedLines(p);
  const was = valueLines(p.kind, p.current);
  const samples = p.evidence.samples ?? [];
  return (
    <div className="flex items-start justify-between gap-6 border-t border-ink-rule/60 px-6 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">
          <span style={{ color: "var(--ink-receipt-2)" }}>{tag.kind}</span>
          {tag.scope && (
            <span className="normal-case tracking-normal text-ink-cream-2">
              {p.kind === "prospect_angle" ? <Pii kind="name">{tag.scope}</Pii> : tag.scope}
            </span>
          )}
        </div>
        {editing ? (
          <div className="mt-1.5 max-w-[90ch]">
            <Textarea
              rows={3}
              value={draft}
              aria-label={editable.label}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="sm"
                disabled={busy || !draft.trim()}
                onClick={() => onApprove(editedValue(p, draft.trim()))}
                {...readOnly}
              >
                <Check size={12} /> approve edited
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-1 max-w-[90ch] text-[13px] leading-5 text-ink-cream">
              {headline.map((line) => (
                <p key={line} className={line.startsWith("− ") ? "text-ink-muted" : ""}>
                  {line}
                </p>
              ))}
            </div>
            <p className="mt-1 max-w-[90ch] text-[12px] leading-5 text-ink-muted">{whyLine(p)}</p>
            <details className="mt-1 text-[12px] text-ink-muted">
              <summary className="cursor-pointer select-none">
                {[was.length > 0 ? "was" : null, samples.length > 0 ? "evidence" : null, "edit"]
                  .filter(Boolean)
                  .join(" · ")}
              </summary>
              <div className="mt-2 max-w-[90ch] space-y-3 border-l border-ink-rule pl-3">
                {was.length > 0 && (
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.08em]">was</p>
                    {was.map((line) => (
                      <p key={line} className="mt-0.5 leading-5">
                        {line}
                      </p>
                    ))}
                  </div>
                )}
                {samples.map((s) => (
                  <div
                    key={`${s.at ?? ""}|${s.name ?? ""}|${(s.sent ?? s.original ?? s.text ?? "").slice(0, 60)}`}
                  >
                    {(s.name || s.at) && (
                      <p className="font-mono text-[10px] uppercase tracking-[0.08em]">
                        {s.name ? <Pii kind="name">{s.name}</Pii> : null}
                        {s.at ? `${s.name ? " · " : ""}${new Date(s.at).toLocaleDateString()}` : ""}
                      </p>
                    )}
                    {(s.feedback ?? []).map((f) => (
                      <p key={f} className="mt-0.5 leading-5">
                        {f}
                      </p>
                    ))}
                    {s.text && (
                      <p className="mt-0.5 whitespace-pre-wrap leading-5">
                        {s.label ? `${s.label}: ` : ""}
                        {s.text}
                      </p>
                    )}
                    {s.original && (
                      <p className="mt-0.5 whitespace-pre-wrap leading-5">
                        Suggested: {s.original}
                      </p>
                    )}
                    {s.sent && (
                      <p className="mt-0.5 whitespace-pre-wrap leading-5 text-ink-cream-2">
                        Sent: {s.sent}
                      </p>
                    )}
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setEditing(true)}
                  {...readOnly}
                >
                  edit before approving
                </Button>
              </div>
            </details>
          </>
        )}
      </div>
      {!editing && (
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" disabled={busy} onClick={() => onApprove()} {...readOnly}>
            <Check size={12} /> approve
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onDismiss}
            className="text-[color:var(--ink-blocked-2)]"
            {...readOnly}
          >
            <X size={12} /> dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

function HistoryRow({
  lines,
  meta,
  muted,
  busy,
  actions,
}: {
  lines: string[];
  meta: string;
  muted?: boolean;
  busy: boolean;
  actions: Array<{ label: string; onClick: () => void }>;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        {lines.map((line) => (
          <p key={line} className={muted ? "text-ink-muted" : "text-ink-cream-2"}>
            {line}
          </p>
        ))}
        <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.08em]">{meta}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions.map((a) => (
          <Button
            key={a.label}
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={a.onClick}
            {...readOnly}
          >
            {a.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
