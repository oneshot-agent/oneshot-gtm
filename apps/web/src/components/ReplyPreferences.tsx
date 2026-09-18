import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../api/client.ts";
import { IS_DEMO } from "../api/demo.ts";
import { Button } from "./primitives/Button.tsx";
import { Pii } from "./primitives/Pii.tsx";
import { replyLearningSummary } from "../lib/replyLearning.ts";
import type { ReplyLearningUpdate } from "@oneshot-gtm/shared-types";

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
  return (
    <details className="border-b border-ink-rule/60 px-6 py-3">
      <summary className="cursor-pointer text-[12px] text-ink-muted">
        Reply preferences · LinkedIn
        {status ? ` (${status.preferences.filter((p) => p.enabled).length} active)` : ""}
      </summary>
      <div className="mt-3 space-y-3 text-[12px] text-ink-muted">
        {query.error && (
          <p role="alert">
            Could not load reply preferences.{" "}
            <button className="underline" onClick={() => void query.refetch()}>
              Retry
            </button>
          </p>
        )}
        {!status && !query.error && <p role="status">Loading preferences…</p>}
        {status && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <p>{replyLearningSummary(status)}</p>
              <Button
                size="sm"
                variant="ghost"
                disabled={update.isPending}
                onClick={() => update.mutate({ enabled: !status.enabled })}
              >
                {status.enabled ? "Pause learning" : "Resume learning"}
              </Button>
            </div>
            {status.preferences.map((p) => (
              <div key={p.id} className="max-w-[90ch] rounded-sm border border-ink-rule/60 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className={p.enabled ? "text-ink-cream" : "text-ink-muted"}>
                      {p.instruction}
                    </p>
                    <p className="mt-1">
                      {p.source === "explicit"
                        ? "Explicit feedback"
                        : p.source === "edits"
                          ? "Repeated edits"
                          : "Style examples"}{" "}
                      · {p.enabled ? "Enabled" : "Disabled"}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={update.isPending}
                    onClick={() => update.mutate({ preferenceId: p.id, enabled: !p.enabled })}
                  >
                    {p.enabled ? "Disable" : "Enable"}
                  </Button>
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer">
                    Supporting replies ({p.evidence.length})
                  </summary>
                  <div className="mt-2 space-y-3">
                    {p.evidence.map((e) => (
                      <div key={e.id} className="border-l border-ink-rule pl-3">
                        <p>
                          <Pii kind="name">{e.name}</Pii> · {new Date(e.at).toLocaleDateString()}
                          {e.historical ? " · Historical example" : ""}
                        </p>
                        {[...new Set(e.feedback)].map((f) => (
                          <p key={f} className="mt-1">
                            Feedback: {f}
                          </p>
                        ))}
                        {e.original && (
                          <p className="mt-1 whitespace-pre-wrap">Suggested: {e.original}</p>
                        )}
                        <p className="mt-1 whitespace-pre-wrap text-ink-cream">Sent: {e.body}</p>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            ))}
          </>
        )}
      </div>
    </details>
  );
}
