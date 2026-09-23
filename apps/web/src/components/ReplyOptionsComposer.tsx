import { replySendFailure } from "../lib/replySendFailure.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Send, Sparkles } from "lucide-react";
import { toast } from "sonner";
import {
  REPLY_VARIANTS,
  type ReplyDraftSet,
  type ReplyThread,
  type ReplyVariant,
} from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { IS_DEMO } from "../api/demo.ts";
import { Button } from "./primitives/Button.tsx";
import { Textarea } from "./primitives/Field.tsx";
import {
  adoptReplyImprovement,
  replyDraftFingerprint as fingerprint,
} from "../lib/replyLearning.ts";
import { readOnly } from "../lib/readOnly.ts";

function initialDraft(t: ReplyThread): ReplyDraftSet {
  return (
    t.drafts ?? {
      id: crypto.randomUUID(),
      revision: 0,
      contextVersion: t.contextVersion,
      read: "",
      originals: { direct: "", technical: "", warm: "" },
      edits: { direct: t.email?.thread?.draftBody ?? "", technical: "", warm: "" },
      moves: {},
      flags: { direct: [], technical: [], warm: [] },
      setFlags: [],
      selected: "direct",
      steer: t.email?.thread?.steer ?? "",
      generated: false,
    }
  );
}

export function ReplyOptionsComposer({ thread: t }: { thread: ReplyThread }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => initialDraft(t));
  const latest = useRef(draft);
  const persisted = useRef<ReplyDraftSet | null>(t.drafts);
  const savedFingerprint = useRef(fingerprint(draft));
  const editVersion = useRef(0);
  const mounted = useRef(true);
  const savingChain = useRef<Promise<ReplyDraftSet | null>>(Promise.resolve(t.drafts));
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [candidate, setCandidate] = useState<ReplyDraftSet | null>(null);
  const [feedback, setFeedback] = useState<Record<ReplyVariant, string>>({
    direct: "",
    technical: "",
    warm: "",
  });
  const [improving, setImproving] = useState<ReplyVariant | null>(null);
  const [improved, setImproved] = useState<{
    variant: ReplyVariant;
    text: string;
    improvementId?: string;
  } | null>(null);
  const [outcome, setOutcome] = useState(false);
  const sendId = useRef<string | null>(null);
  useEffect(() => {
    if (t.send?.status === "failed" || t.send?.status === "sent") sendId.current = null;
  }, [t.send?.status]);
  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["replies"] }),
    [queryClient],
  );
  const update = (next: ReplyDraftSet) => {
    editVersion.current++;
    latest.current = next;
    setDraft(next);
  };

  const flush = useCallback((): Promise<ReplyDraftSet | null> => {
    const task = savingChain.current
      .catch(() => null)
      .then(async () => {
        const snapshot = latest.current;
        if (IS_DEMO) return persisted.current;
        if (persisted.current && fingerprint(snapshot) === savedFingerprint.current)
          return persisted.current;
        if (mounted.current) {
          setSaving(true);
          setSaveError("");
        }
        try {
          const saved = await api.saveReplyOptions(
            t.key,
            snapshot,
            persisted.current?.revision ?? null,
          );
          persisted.current = saved;
          savedFingerprint.current = fingerprint(snapshot);
          if (mounted.current && fingerprint(latest.current) === fingerprint(snapshot)) {
            latest.current = saved;
            setDraft(saved);
          }
          return saved;
        } catch (e) {
          if (mounted.current) setSaveError((e as Error).message);
          throw e;
        } finally {
          if (mounted.current) setSaving(false);
        }
      });
    savingChain.current = task;
    return task;
  }, [t.key]);
  useEffect(() => {
    if (fingerprint(draft) === savedFingerprint.current || IS_DEMO) return;
    const timer = setTimeout(() => {
      void flush().catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [draft, flush]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (fingerprint(latest.current) !== savedFingerprint.current) void flush().catch(() => {});
    };
  }, [flush]);
  useEffect(() => {
    if (
      t.drafts &&
      t.drafts.revision > (persisted.current?.revision ?? 0) &&
      fingerprint(latest.current) === savedFingerprint.current
    ) {
      persisted.current = t.drafts;
      savedFingerprint.current = fingerprint(t.drafts);
      latest.current = t.drafts;
      setDraft(t.drafts);
    }
  }, [t.drafts]);

  const generate = useMutation({
    mutationFn: async (force: boolean) => {
      const version = editVersion.current;
      const result = await api.generateReplyOptions(t.key, force, latest.current.steer);
      return { result, version, force };
    },
    onSuccess: ({ result, version, force }) => {
      if (!mounted.current) return;
      if (
        force ||
        latest.current.generated ||
        version !== editVersion.current ||
        result.contextVersion !== t.contextVersion
      ) {
        setCandidate(result);
        return;
      }
      // An existing single email draft is intentional; preserve it in the first option.
      if (!latest.current.generated && latest.current.edits.direct.trim())
        result.edits.direct = latest.current.edits.direct;
      update(result);
      void flush().catch(() => {});
    },
    onError: (e: Error) => {
      if (mounted.current) toast.error(e.message);
    },
  });
  const attempted = useRef<string | null>(null);
  useEffect(() => {
    if (
      IS_DEMO ||
      !t.canGenerate ||
      !t.needsReply ||
      (t.send && ["pending", "uncertain"].includes(t.send.status)) ||
      attempted.current === t.contextVersion
    )
      return;
    attempted.current = t.contextVersion;
    if (!latest.current.generated || latest.current.contextVersion !== t.contextVersion)
      generate.mutate(false);
  }, [t.contextVersion, t.canGenerate, t.needsReply, t.send, generate]);

  const send = useMutation({
    mutationFn: async () => {
      const saved = await flush();
      if (!saved) throw new Error("Save a reply first");
      sendId.current ??= crypto.randomUUID();
      return api.sendReplyOption(t.key, sendId.current, saved.revision);
    },
    onSuccess: async (result) => {
      if (result.status === "sent") {
        toast.success("Reply sent");
        sendId.current = null;
      } else if (result.status === "failed") {
        toast.error(result.error ?? "Reply was not sent");
        sendId.current = null;
      } else toast.message("Reply submitted. Waiting for delivery confirmation.");
      await invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const pending = t.send && ["pending", "uncertain"].includes(t.send.status);
  const status = useQuery({
    queryKey: ["reply-send", t.key, t.send?.id],
    queryFn: () => api.checkReplySend(t.key),
    enabled: !!pending && !IS_DEMO,
    refetchInterval: 6000,
  });
  useEffect(() => {
    if (status.data && status.data.status !== t.send?.status) void invalidate();
  }, [status.data, t.send?.status, invalidate]);
  const busy = send.isPending || !!pending;

  async function improve(variant: ReplyVariant) {
    const text = latest.current.edits[variant];
    const version = editVersion.current;
    setImproving(variant);
    try {
      await flush();
      const result = await api.improveReplyOption(t.key, variant, text, feedback[variant]);
      if (!mounted.current) return;
      if (version !== editVersion.current || latest.current.edits[variant] !== text)
        setImproved({ variant, text: result.text, improvementId: result.improvementId });
      else {
        update(adoptReplyImprovement(latest.current, variant, result.text, result.improvementId));
        await flush();
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      if (mounted.current) setImproving(null);
    }
  }
  const selectedBody = draft.edits[draft.selected];
  const sendFailure = replySendFailure(t);
  return (
    <div className="reply-composer space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[13px] text-ink-cream">
          Your reply{" "}
          <span className="ml-2 text-[11px] text-ink-muted">
            via {t.channel === "linkedin" ? "LinkedIn" : "email"}
          </span>
        </div>
        <span className="text-[11px] text-ink-muted">
          {saving ? "Saving…" : saveError ? "Changes not saved" : "Edits save automatically"}
        </span>
      </div>
      {t.unavailableReason && <p className="text-[12px] text-ink-muted">{t.unavailableReason}</p>}
      {draft.contextVersion !== t.contextVersion && draft.generated && (
        <p role="status" className="text-[12px] text-ink-spend-2">
          The conversation or its context changed. Your edits are preserved; review new suggestions
          before sending.
        </p>
      )}
      {draft.read && (
        <details className="reply-context">
          <summary>Conversation insight</summary>
          <p>{draft.read}</p>
        </details>
      )}
      <div className="reply-directions" role="group" aria-label="Reply approach">
        {REPLY_VARIANTS.map((v) => (
          <button
            key={v}
            type="button"
            className="reply-direction"
            aria-pressed={draft.selected === v}
            disabled={busy}
            onClick={() => update({ ...latest.current, selected: v })}
          >
            <span className="reply-direction-title">
              <span className="capitalize">{v}</span>
              {draft.selected === v && <span className="reply-selected-dot" />}
            </span>
            <span className="reply-direction-description">
              {draft.moves[v] ||
                {
                  direct: "Get to the point",
                  technical: "Go into the details",
                  warm: "Keep it personal",
                }[v]}
            </span>
            {draft.edits[v] && <span className="reply-direction-preview">{draft.edits[v]}</span>}
          </button>
        ))}
      </div>
      {REPLY_VARIANTS.filter((v) => v === draft.selected).map((v) => (
        <section key={v} className="reply-editor">
          <Textarea
            aria-label={`${v} reply`}
            className="reply-textarea"
            rows={6}
            value={draft.edits[v]}
            disabled={busy}
            onFocus={() => {
              if (draft.selected !== v && !busy) update({ ...latest.current, selected: v });
            }}
            onChange={(e) =>
              update({
                ...latest.current,
                selected: v,
                edits: { ...latest.current.edits, [v]: e.target.value },
              })
            }
            placeholder={
              generate.isPending ? "Drafting suggestions… You can write here." : "Write your reply…"
            }
          />
          {!!draft.flags[v]?.length && (
            <p className="mt-2 text-[11px] text-ink-spend-2">Review: {draft.flags[v].join(", ")}</p>
          )}
          <details className="mt-2 text-[11px] text-ink-muted">
            <summary className="cursor-pointer">Improvement instructions</summary>
            <Textarea
              aria-label={`Instructions for ${v}`}
              rows={2}
              value={feedback[v]}
              onChange={(e) => setFeedback({ ...feedback, [v]: e.target.value })}
              placeholder="Shorter, keep my question…"
            />
          </details>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={
                !draft.edits[v].trim() ||
                busy ||
                !!improving ||
                (t.channel === "linkedin" && !t.workspace)
              }
              onClick={() => void improve(v)}
              {...readOnly}
            >
              {improving === v ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Sparkles size={12} />
              )}{" "}
              Improve
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !draft.originals[v]}
              onClick={() =>
                update({
                  ...latest.current,
                  selected: v,
                  edits: { ...latest.current.edits, [v]: latest.current.originals[v] },
                  improvementIds: { ...latest.current.improvementIds, [v]: [] },
                })
              }
              {...readOnly}
            >
              Reset
            </Button>
          </div>
        </section>
      ))}
      {!!draft.setFlags.length && (
        <p className="text-[11px] text-ink-spend-2">Review options: {draft.setFlags.join(", ")}</p>
      )}
      {candidate && (
        <div className="space-y-2 rounded-sm border border-ink-rule p-3">
          <p className="text-[13px] text-ink-cream">
            New suggestions are ready. Your current edits are still above.
          </p>
          <div className="grid gap-3 xl:grid-cols-3">
            {REPLY_VARIANTS.map((v) => (
              <p key={v} className="whitespace-pre-wrap text-[12px] text-ink-muted">
                <b className="capitalize">{v}</b>
                <br />
                {candidate.edits[v]}
              </p>
            ))}
          </div>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              update(candidate);
              setCandidate(null);
            }}
          >
            Use new suggestions
          </Button>{" "}
          <Button size="sm" variant="ghost" onClick={() => setCandidate(null)}>
            Keep my edits
          </Button>
        </div>
      )}
      {improved && (
        <div className="space-y-2 rounded-sm border border-ink-rule p-3">
          <p className="text-[12px] text-ink-muted">
            You edited while Improve was running. Review the suggestion:
          </p>
          <p className="whitespace-pre-wrap text-[13px]">{improved.text}</p>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              update(
                adoptReplyImprovement(
                  latest.current,
                  improved.variant,
                  improved.text,
                  improved.improvementId,
                ),
              );
              void flush().catch(() => {});
              setImproved(null);
            }}
          >
            Use improvement
          </Button>{" "}
          <Button size="sm" variant="ghost" onClick={() => setImproved(null)}>
            Keep my edits
          </Button>
        </div>
      )}
      <details className="text-[12px] text-ink-muted">
        <summary className="cursor-pointer">Standing instructions for this conversation</summary>
        <Textarea
          rows={2}
          value={draft.steer}
          disabled={busy}
          onChange={(e) => update({ ...latest.current, steer: e.target.value })}
          placeholder="No pricing commitments; answer their technical question first."
        />
      </details>
      {saveError && (
        <p role="alert" className="text-[12px] text-ink-blocked-2">
          {saveError}{" "}
          <button className="underline" onClick={() => void flush().catch(() => {})}>
            Retry save
          </button>
        </p>
      )}
      {pending && (
        <p role="status" className="text-[12px] text-ink-spend-2">
          {t.send?.status === "uncertain"
            ? "Delivery is not confirmed yet. Your draft is preserved; checking the existing send."
            : "Sending… Waiting for delivery confirmation."}
        </p>
      )}
      {sendFailure && (
        <p
          role={sendFailure.recovered ? "status" : "alert"}
          className={
            sendFailure.recovered ? "text-[12px] text-ink-muted" : "text-[12px] text-ink-blocked-2"
          }
        >
          {sendFailure.message}
        </p>
      )}
      <div className="reply-sendbar flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="ghost"
          disabled={!t.canGenerate || generate.isPending || busy}
          onClick={() => generate.mutate(true)}
          {...readOnly}
        >
          {generate.isPending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Sparkles size={12} />
          )}{" "}
          {generate.isPending ? "Generating…" : draft.generated ? "Regenerate" : "Generate"}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={
            !t.canSend ||
            !selectedBody.trim() ||
            busy ||
            !!improving ||
            (t.channel === "linkedin" && selectedBody.trim().length > 4000)
          }
          onClick={() => send.mutate()}
          {...readOnly}
        >
          <Send size={12} />
          {busy ? "Sending…" : "Send reply"}
        </Button>
        {t.channel === "linkedin" && (
          <span className="text-[11px] text-ink-muted">{selectedBody.length}/4000</span>
        )}
        {t.prospectId && t.channel === "email" && (
          <Button size="sm" variant="ghost" onClick={() => setOutcome(!outcome)} {...readOnly}>
            Log outcome
          </Button>
        )}
      </div>
      {outcome && (
        <div className="flex flex-wrap gap-2">
          {(["meeting_booked", "sql_qualified", "deal_won", "deal_lost", "ghosted"] as const).map(
            (kind) => (
              <Button
                key={kind}
                size="sm"
                variant="ghost"
                onClick={() => {
                  void api
                    .recordOutcome({ email: t.address, outcome: kind })
                    .then(() => {
                      toast.success("Outcome recorded");
                      setOutcome(false);
                      void invalidate();
                    })
                    .catch((e) => toast.error(e.message));
                }}
                {...readOnly}
              >
                {kind.replaceAll("_", " ")}
              </Button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
