import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api/client.ts";
import { IS_DEMO } from "../api/demo.ts";
import { Button } from "./primitives/Button.tsx";
import { replyLearningSummary } from "../lib/replyLearning.ts";
import type { ReplyLearningUpdate } from "@oneshot-gtm/shared-types";

/**
 * One line on the inbox: how many writing preferences are active, how many
 * proposals wait, and the pause switch. The preferences themselves are
 * reviewed, disabled and rolled back in the Learning strip on /queue, so
 * they are not listed twice.
 */
export function ReplyPreferences({ workspace }: { workspace: string }) {
  const client = useQueryClient();
  const key = ["reply-learning", workspace];
  const query = useQuery({
    queryKey: key,
    queryFn: api.replyLearning,
    enabled: !IS_DEMO,
    refetchInterval: 60_000,
  });
  const update = useMutation({
    mutationFn: (change: ReplyLearningUpdate) => api.updateReplyLearning(change),
    onSuccess: (status) => client.setQueryData(key, status),
    onError: (e: Error) => toast.error(e.message),
  });
  if (IS_DEMO) return null;
  const status = query.data;
  const active = status ? status.preferences.filter((p) => p.enabled).length : 0;
  // The summary sentence earns its place only when the state is not the plain one.
  const note =
    status && (!status.enabled || status.error || !status.imported || status.pending)
      ? replyLearningSummary(status)
      : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ink-rule/60 px-6 py-2 text-[12px] text-ink-muted">
      <span>
        Writing preferences
        {status ? ` · ${active} ${status.enabled ? "active" : "paused"}` : ""}
        {status?.pendingProposals ? ` · ${status.pendingProposals} to review` : ""}
      </span>
      {query.error && (
        <span role="alert">
          Could not load.{" "}
          <button className="underline" onClick={() => void query.refetch()}>
            Retry
          </button>
        </span>
      )}
      {status && (
        <>
          {note && <span className="text-ink-faint">{note}</span>}
          <a href="/queue?learning=preference" className="underline hover:text-ink-cream">
            {status.pendingProposals ? "Review on queue" : "Manage on queue"}
          </a>
          <Button
            size="sm"
            variant="ghost"
            disabled={update.isPending}
            onClick={() => update.mutate({ enabled: !status.enabled })}
          >
            {status.enabled ? "Pause learning" : "Resume learning"}
          </Button>
        </>
      )}
    </div>
  );
}
