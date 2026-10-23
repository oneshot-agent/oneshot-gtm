import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { CodeAnswer } from "@oneshot-gtm/shared-types";
import { api } from "../../api/client.ts";
import { IS_DEMO } from "../../api/demo.ts";
import {
  askedLabel,
  codeAnswerStatusLabel,
  isReading,
  isUnread,
  shortCommit,
  sortCodeAnswers,
} from "../../lib/codeAnswers.ts";
import { readOnly } from "../../lib/readOnly.ts";
import { Button } from "../primitives/Button.tsx";
import { Textarea } from "../primitives/Field.tsx";

export const CODE_ANSWERS_KEY = ["code-answers", "all"] as const;

/**
 * "Answers from your code" on /setup: every how-it-works question prospects
 * asked that the brief did not answer, read against the source repo. Pending
 * first (approve, edit, dismiss), then what is in the brief, what went stale
 * when the code changed, and what the code did not settle.
 */
export function CodeAnswersList({ repoConfigured }: { repoConfigured: boolean }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: CODE_ANSWERS_KEY,
    queryFn: () => api.codeAnswers(),
    enabled: !IS_DEMO,
    refetchInterval: (q) => (q.state.data?.answers.some(isReading) ? 3000 : 60_000),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["code-answers"] });
    // An approved answer changes the brief every reply is written from.
    void qc.invalidateQueries({ queryKey: ["replies"] });
  };
  const approve = useMutation({
    mutationFn: (vars: { id: string; text?: string }) => api.approveCodeAnswer(vars.id, vars.text),
    onSuccess: () => {
      toast.success("Approved. Replies use it from now on.");
      invalidate();
    },
    onError: (e: Error) => toast.error(`couldn't approve · ${e.message}`),
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => api.dismissCodeAnswer(id),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(`couldn't dismiss · ${e.message}`),
  });
  const derive = useMutation({
    mutationFn: (id: string) => api.deriveCodeAnswer(id),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });
  const sweep = useMutation({
    mutationFn: () => api.sweepCodeAnswers(),
    onSuccess: () => {
      toast.success("Checked against the repo");
      invalidate();
    },
    onError: (e: Error) => toast.error(`couldn't check · ${e.message}`),
  });
  return (
    <CodeAnswersListView
      answers={query.data?.answers ?? []}
      repoConfigured={repoConfigured}
      busy={approve.isPending || dismiss.isPending || derive.isPending}
      sweeping={sweep.isPending}
      onApprove={(id, text) => approve.mutate({ id, text })}
      onDismiss={(id) => dismiss.mutate(id)}
      onDerive={(id) => derive.mutate(id)}
      onSweep={() => sweep.mutate()}
    />
  );
}

export function CodeAnswersListView({
  answers,
  repoConfigured,
  busy,
  sweeping,
  onApprove,
  onDismiss,
  onDerive,
  onSweep,
}: {
  answers: readonly CodeAnswer[];
  repoConfigured: boolean;
  busy: boolean;
  sweeping: boolean;
  onApprove: (id: string, text?: string) => void;
  onDismiss: (id: string) => void;
  onDerive: (id: string) => void;
  onSweep: () => void;
}) {
  const rows = sortCodeAnswers(answers);
  if (rows.length === 0 && !repoConfigured) return null;
  const pending = rows.filter((a) => a.status === "pending" && !isReading(a)).length;
  return (
    <section aria-label="Answers from your code" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="ln-eyebrow">
          Answers from your code{pending > 0 ? ` · ${pending} to review` : ""}
        </span>
        {repoConfigured && rows.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={sweeping}
            onClick={onSweep}
            {...readOnly}
          >
            <RefreshCw size={12} className={sweeping ? "animate-spin" : undefined} />
            {sweeping ? "Checking…" : "Check against the repo"}
          </Button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="text-[12px] text-ink-muted">
          None yet. When a prospect asks how something works and the brief doesn't say, the question
          shows up here with an answer read from your code.
        </p>
      ) : (
        rows.map((a) => (
          <CodeAnswerRow
            key={a.id}
            answer={a}
            busy={busy}
            canRead={repoConfigured}
            onApprove={(text) => onApprove(a.id, text)}
            onDismiss={() => onDismiss(a.id)}
            onDerive={() => onDerive(a.id)}
          />
        ))
      )}
    </section>
  );
}

function CodeAnswerRow({
  answer: a,
  busy,
  canRead,
  onApprove,
  onDismiss,
  onDerive,
}: {
  answer: CodeAnswer;
  busy: boolean;
  canRead: boolean;
  onApprove: (text?: string) => void;
  onDismiss: () => void;
  onDerive: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(a.answer ?? "");
  const reading = isReading(a);
  const commit = shortCommit(a.commit);
  const meta = [codeAnswerStatusLabel(a), askedLabel(a.askedCount), commit].filter(Boolean);
  const reviewable = a.status === "pending" && !reading && Boolean(a.answer);
  const rereadable =
    canRead &&
    !reading &&
    (a.status === "open" || a.status === "unresolved" || a.status === "stale");
  // The store takes the founder's own words for a question the code did not settle.
  const writable =
    reviewable || a.status === "open" || a.status === "unresolved" || a.status === "stale";
  return (
    <div className="border-t border-ink-rule/60 pt-2">
      <p className="text-[13px] text-ink-cream">{a.question}</p>
      <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">
        {meta.join(" · ")}
      </p>
      {editing ? (
        <div className="mt-1.5">
          <Textarea
            rows={3}
            value={text}
            aria-label="Edit the answer"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="mt-2 flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || !text.trim()}
              onClick={() => {
                onApprove(text.trim());
                setEditing(false);
              }}
              {...readOnly}
            >
              <Check size={12} /> Approve edited
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          {reading ? (
            <p className="mt-1 text-[12px] text-ink-muted">Reading your code…</p>
          ) : isUnread(a) ? (
            <p className="mt-1 text-[12px] text-ink-muted">
              Not read yet. The last read didn't finish; read it again or write the answer.
            </p>
          ) : a.status === "unresolved" ? (
            <p className="mt-1 text-[12px] text-ink-muted">
              {a.whyUnresolved
                ? `Your code didn't settle this: ${a.whyUnresolved}`
                : "Your code didn't settle this."}
            </p>
          ) : a.answer ? (
            <p
              className={`mt-1 whitespace-pre-wrap text-[12px] leading-5 ${a.status === "stale" ? "text-ink-muted" : "text-ink-cream-2"}`}
            >
              {a.answer}
            </p>
          ) : null}
          {!reading && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {reviewable && (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => onApprove()}
                  {...readOnly}
                >
                  <Check size={12} /> Approve
                </Button>
              )}
              {writable && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setText(a.answer ?? "");
                    setEditing(true);
                  }}
                  {...readOnly}
                >
                  {reviewable ? "Edit" : "Write the answer"}
                </Button>
              )}
              {rereadable && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={onDerive}
                  {...readOnly}
                >
                  <RefreshCw size={12} /> Read again
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={onDismiss}
                className="text-[color:var(--ink-blocked-2)]"
                title={a.status === "approved" ? "Take it out of the brief" : undefined}
                {...readOnly}
              >
                <X size={12} /> Dismiss
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
