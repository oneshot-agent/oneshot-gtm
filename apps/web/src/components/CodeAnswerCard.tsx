import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { CodeAnswer } from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { IS_DEMO } from "../api/demo.ts";
import { composerCodeAnswerState, isReading, threadCodeAnswer } from "../lib/codeAnswers.ts";
import { readOnly } from "../lib/readOnly.ts";
import { Button } from "./primitives/Button.tsx";
import { Textarea } from "./primitives/Field.tsx";

export const threadCodeAnswersKey = (threadKey: string, id: string) =>
  ["code-answers", "thread", threadKey, id] as const;

/**
 * The composer's line for this conversation's how-it-works question, when
 * the brief did not answer it and the code was read for it: "Reading your
 * code…" while that runs, the answer to approve, edit or dismiss, or why the
 * code did not settle it. Approving puts it in the brief and the composer
 * regenerates (`onApproved`). Nothing shows once approved.
 */
export function CodeAnswerCard({
  threadKey,
  answerId,
  onApproved,
}: {
  threadKey: string;
  answerId: string;
  onApproved: () => void;
}) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: threadCodeAnswersKey(threadKey, answerId),
    queryFn: () => api.codeAnswers({ threadKey, id: answerId }),
    enabled: !IS_DEMO,
    refetchInterval: (q) => (q.state.data?.answers.some(isReading) ? 3000 : false),
  });
  const answer = threadCodeAnswer(query.data?.answers ?? [], threadKey, answerId);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["code-answers"] });
  const approve = useMutation({
    mutationFn: (vars: { id: string; text?: string }) => api.approveCodeAnswer(vars.id, vars.text),
    onSuccess: () => {
      toast.success("Approved. Replies use it from now on.");
      void invalidate();
      onApproved();
    },
    onError: (e: Error) => toast.error(`couldn't approve · ${e.message}`),
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => api.dismissCodeAnswer(id),
    onSuccess: () => void invalidate(),
    onError: (e: Error) => toast.error(`couldn't dismiss · ${e.message}`),
  });
  return (
    <CodeAnswerCardView
      answer={answer}
      busy={approve.isPending || dismiss.isPending}
      onApprove={(text) => answer && approve.mutate({ id: answer.id, text })}
      onDismiss={() => answer && dismiss.mutate(answer.id)}
    />
  );
}

export function CodeAnswerCardView({
  answer,
  busy,
  onApprove,
  onDismiss,
}: {
  answer: CodeAnswer | null;
  busy: boolean;
  onApprove: (text?: string) => void;
  onDismiss: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(answer?.answer ?? "");
  const state = composerCodeAnswerState(answer);
  if (!answer || !state) return null;
  if (state === "reading")
    return (
      <p role="status" className="flex items-center gap-1.5 text-[12px] text-ink-muted">
        <Loader2 size={12} className="animate-spin" /> Reading your code…
      </p>
    );
  if (state === "unresolved")
    return (
      <p role="note" className="text-[12px] text-ink-muted">
        Your code didn't settle this
        {answer.whyUnresolved ? `: ${answer.whyUnresolved}` : "."}
      </p>
    );
  return (
    <div
      className="space-y-2 rounded-sm border border-ink-rule p-3"
      aria-label="Answer from your code"
    >
      <p className="text-[12px] text-ink-muted">{answer.question}</p>
      {editing ? (
        <>
          <Textarea
            rows={3}
            value={text}
            aria-label="Edit the answer"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={busy || !text.trim()}
              onClick={() => onApprove(text.trim())}
              {...readOnly}
            >
              <Check size={12} /> Approve edited
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-[13px] text-ink-cream">
            <span className="text-ink-muted">Answer from your code: </span>
            {answer.answer}
          </p>
          <div className="flex items-center gap-1">
            <Button size="sm" disabled={busy} onClick={() => onApprove()} {...readOnly}>
              <Check size={12} /> Approve
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setText(answer.answer ?? "");
                setEditing(true);
              }}
              {...readOnly}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={onDismiss}
              className="text-[color:var(--ink-blocked-2)]"
              {...readOnly}
            >
              <X size={12} /> Dismiss
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
