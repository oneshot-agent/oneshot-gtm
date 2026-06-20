import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Send, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { InboxReplyView } from "@oneshot-gtm/shared-types";
import { inboxThreadKey } from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { Badge } from "../components/primitives/Badge.tsx";
import { Pii } from "../components/primitives/Pii.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { EmptyNote } from "../components/primitives/EmptyNote.tsx";
import { Textarea } from "../components/primitives/Field.tsx";
import { SkeletonRow } from "../components/primitives/Skeleton.tsx";
import { cn, timeAgo } from "../lib/cn.ts";
import { matchesReplyFilter, type ReplyMatchFilter } from "../lib/replyFilter.ts";

const MATCH_FILTERS: Array<{ key: ReplyMatchFilter; label: string }> = [
  { key: "all", label: "all" },
  { key: "matched", label: "matched" },
  { key: "no-match", label: "no match" },
];

export const Route = createFileRoute("/inbox")({
  component: InboxPage,
});

function statusTone(status: string | null): "receipt" | "spend" | "blocked" | "signal" | "neutral" {
  switch (status) {
    case "replied":
      return "signal";
    case "active":
      return "spend";
    case "breakup":
      return "blocked";
    case "completed":
      return "receipt";
    default:
      return "neutral";
  }
}

function InboxPage() {
  const [expanded, setExpanded] = useState<string | null>(null);
  // Default to `matched` — most inbox mail is unmatched noise (newsletters,
  // bounces, system mail); landing on matched surfaces real prospect replies
  // first. The founder can switch to `all` / `no match` to see the rest.
  const [matchFilter, setMatchFilter] = useState<ReplyMatchFilter>("matched");
  const inbox = useQuery({
    queryKey: ["inbox"],
    queryFn: () => api.inbox(),
    refetchInterval: 60_000,
  });

  const replies = inbox.data?.replies ?? [];
  const error = inbox.data?.error;
  // Filter is purely client-side over the already-fetched list (the endpoint
  // takes no params). Counts are off the full list so the buttons show the split.
  const matchedCount = replies.filter((r) => r.matched != null).length;
  const noMatchCount = replies.length - matchedCount;
  const countFor = (key: ReplyMatchFilter): number =>
    key === "matched" ? matchedCount : key === "no-match" ? noMatchCount : replies.length;
  const visible = replies.filter((r) => matchesReplyFilter(r, matchFilter));

  return (
    <div className="-mx-6 -my-6 flex flex-col">
      {/* Masthead */}
      <section className="flex items-end justify-between gap-4 border-b border-ink-rule px-6 pb-5 pt-6">
        <div>
          <div className="ln-eyebrow">The Ledger · Replies</div>
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
            Who wrote back.
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[11px] text-ink-faint">
            {!inbox.data
              ? "…"
              : matchFilter === "all"
                ? `${replies.length} repl${replies.length === 1 ? "y" : "ies"}`
                : `${visible.length} of ${replies.length}`}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={inbox.isFetching}
            onClick={() => void inbox.refetch()}
          >
            {inbox.isFetching ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}
            refresh
          </Button>
        </div>
      </section>

      <section className="flex items-start gap-3 border-b border-ink-rule px-6 py-3">
        <div className="ln-note text-[12px] text-ink-muted">
          Replies arrive in your mailbox; the cadence engine reads them to stop a sequence on reply.
          Expand a reply to answer it from here — write it yourself or generate a draft.
        </div>
      </section>

      {/* Match-status filter — most inbox mail is unmatched noise (newsletters,
          bounces, system mail); filtering to `matched` surfaces real prospect
          replies. Mirrors the queue page's filter-bar style. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-rule/60 px-6 py-3">
        <span className="ln-eyebrow">show</span>
        {MATCH_FILTERS.map((f) => (
          <Button
            key={f.key}
            variant={matchFilter === f.key ? "primary" : "ghost"}
            size="sm"
            onClick={() => setMatchFilter(f.key)}
          >
            {f.label}
            {/* opacity (not a fixed faint color) so the count stays legible on
                the selected button's cream fill as well as the ghost ones. */}
            {inbox.data && <span className="ml-1 font-mono opacity-60">{countFor(f.key)}</span>}
          </Button>
        ))}
      </div>

      {error && (
        <section className="border-b border-ink-rule/60 px-6 py-3">
          <div className="font-mono text-[12px] text-[color:var(--ink-blocked-2)]">{error}</div>
        </section>
      )}

      {inbox.isLoading ? (
        Array.from({ length: 5 }, (_, i) => <SkeletonRow key={i} />)
      ) : replies.length === 0 ? (
        <div className="p-5">
          <EmptyNote note="No replies yet. When a prospect writes back, it shows here." />
        </div>
      ) : visible.length === 0 ? (
        <div className="p-5">
          <EmptyNote
            note={
              matchFilter === "matched"
                ? "No matched replies — none of the mail here maps to a known prospect yet."
                : "No unmatched replies — every reply here matches a prospect."
            }
          />
        </div>
      ) : (
        <div>
          {visible.map((r, i) => (
            <ReplyRow
              key={r.id}
              reply={r}
              zebra={i % 2 === 1}
              expanded={expanded === r.id}
              onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ReplyRow({
  reply,
  zebra,
  expanded,
  onToggle,
}: {
  reply: InboxReplyView;
  zebra: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const who = reply.matched?.name ?? reply.fromEmail;
  const company = reply.matched?.company;
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "group flex w-full items-center gap-3 border-b border-ink-rule/60 px-6 py-3 text-left",
          "transition-colors duration-[var(--dur-stamp)] hover:bg-ink-surface/60",
          zebra && "bg-ink-surface/20",
        )}
      >
        <span className="text-ink-faint">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[13px] text-ink-cream">
              <Pii kind="auto">{who}</Pii>
            </span>
            {company ? (
              <span className="truncate font-mono text-[11px] text-ink-faint">
                · <Pii kind="company">{company}</Pii>
              </span>
            ) : null}
          </span>
          <span className="block truncate text-[12px] text-ink-muted">{reply.subject}</span>
        </span>
        {reply.matched ? (
          <Badge tone={statusTone(reply.matched.cadenceStatus)}>
            {reply.matched.playName ?? "prospect"}
            {reply.matched.cadenceStatus ? ` · ${reply.matched.cadenceStatus}` : ""}
          </Badge>
        ) : (
          <Badge tone="neutral">no match</Badge>
        )}
        <span className="shrink-0 font-mono text-[12px] text-ink-muted">
          {timeAgo(reply.receivedAt)}
        </span>
      </button>
      {expanded && (
        <div className="border-b border-ink-rule/60 bg-ink-bg-deep/50 px-6 py-3">
          <div className="mb-2 font-mono text-[11px] text-ink-faint">
            from <Pii kind="from">{reply.fromRaw}</Pii>
          </div>
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-[1.6] text-ink-cream-2">
            {reply.body || "(no body)"}
          </pre>
          <ReplyComposer reply={reply} />
        </div>
      )}
    </>
  );
}

/** "Re: " prefix for display/send — mirrors the server's normalization. */
function reSubject(subject: string): string {
  const s = subject.trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** "gmail:jn@x.com" → "jn@x.com"; legacy/synthesized ids get a friendly label. */
function identityAddress(id: string): string {
  if (id.startsWith("gmail:")) return id.slice("gmail:".length);
  if (id === "legacy-gmail") return "your Gmail";
  if (id === "legacy-oneshot") return "OneShot";
  return id;
}

function ReplyComposer({ reply }: { reply: InboxReplyView }) {
  const queryClient = useQueryClient();
  const threadKey = inboxThreadKey({ threadId: reply.threadId, id: reply.id });
  const sentHistory = reply.thread?.sent ?? [];
  const [draft, setDraft] = useState(reply.thread?.draftBody ?? "");
  // Last value persisted to the server — so we skip no-op saves (including the
  // initial render restoring a previously-saved draft). `draftRef` mirrors the
  // latest draft for the unmount flush below (cleanups can't read fresh state).
  const lastSaved = useRef(reply.thread?.draftBody ?? "");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const identityId = reply.sourceIdentityId;

  const persist = useCallback(
    (value: string) => {
      if (!identityId || value === lastSaved.current) return;
      lastSaved.current = value;
      // Empty body clears the persisted draft server-side (so deleting all text
      // and refreshing doesn't bring the old draft back).
      api
        .saveInboxDraft({
          threadKey,
          inboundEmailId: reply.id,
          toEmail: reply.fromEmail,
          subject: reply.subject,
          identityId,
          body: value,
        })
        .catch(() => {
          // best-effort — the draft is still in the textarea; a later edit retries.
        });
    },
    [threadKey, reply.id, reply.fromEmail, reply.subject, identityId],
  );

  const generate = useMutation({
    mutationFn: () =>
      api.draftInboxReply({
        fromEmail: reply.fromEmail,
        subject: reply.subject,
        body: reply.body,
      }),
    onSuccess: (res) => setDraft(res.body),
    onError: (err) => toast.error(`couldn't draft · ${err.message}`),
  });

  const send = useMutation({
    mutationFn: () =>
      api.sendInboxReply({
        to: reply.fromEmail,
        subject: reply.subject,
        body: draft,
        identityId: identityId ?? "",
        threadKey,
        threadId: reply.threadId,
        inReplyTo: reply.messageId,
        // OneShot-source rows: reply.id is the OneShot inbox id the platform
        // threads on. Ignored server-side for Gmail rows.
        replyToEmailId: reply.sourceProvider === "oneshot" ? reply.id : null,
      }),
    onSuccess: (res) => {
      // Server appended to the sent history and cleared the draft. Reflect that
      // locally (clear the box, mark nothing-to-save) and refetch so the sent
      // reply shows up.
      lastSaved.current = "";
      setDraft("");
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
      toast.success(res.costUsd > 0 ? `reply sent · $${res.costUsd.toFixed(2)}` : "reply sent");
    },
    onError: (err) => toast.error(`couldn't send · ${err.message}`),
  });

  // Debounced auto-save: persist ~1s after typing stops so a refresh or
  // navigation doesn't discard the draft. Paused while a send is in flight so a
  // stale timer can't re-create the draft the send just cleared.
  useEffect(() => {
    if (send.isPending || draft === lastSaved.current) return;
    const id = setTimeout(() => persist(draft), 1000);
    return () => clearTimeout(id);
  }, [draft, send.isPending, persist]);

  // Flush on unmount (e.g. collapsing the row within the debounce window) so a
  // draft typed and immediately hidden still gets saved.
  useEffect(() => {
    return () => {
      if (draftRef.current !== lastSaved.current) persist(draftRef.current);
    };
  }, [persist]);

  if (!reply.sourceIdentityId) {
    // Pre-attribution rows (server restarted mid-session) — refresh re-tags them.
    return (
      <div className="mt-3 border-t border-ink-rule/60 pt-3 font-mono text-[11px] text-ink-faint">
        can't tell which mailbox received this — refresh the inbox to reply from here
      </div>
    );
  }

  return (
    <div className="mt-3 border-t border-ink-rule/60 pt-3">
      {sentHistory.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 flex items-center gap-2">
            <Badge tone="receipt">replied</Badge>
            <span className="font-mono text-[11px] text-ink-faint">
              you answered this — the thread is likely continuing in your email client
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {sentHistory.map((s) => (
              <div
                key={s.sentAt}
                className="rounded-sm border border-ink-rule/60 bg-ink-surface/30 px-3 py-2"
              >
                <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
                  sent {timeAgo(s.sentAt)}
                </div>
                <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-[1.6] text-ink-cream-2">
                  {s.body}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="ln-eyebrow">{sentHistory.length > 0 ? "Reply again" : "Reply"}</span>
        <span className="font-mono text-[11px] text-ink-faint">
          {reSubject(reply.subject)} · from {identityAddress(reply.sourceIdentityId)}
        </span>
        {reply.sourceProvider === "oneshot" && (
          <span className="font-mono text-[11px] text-ink-spend-2">paid · threaded</span>
        )}
      </div>
      <Textarea
        rows={6}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Write your reply, or generate a draft to edit."
        disabled={send.isPending}
      />
      <div className="mt-2 flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={generate.isPending || send.isPending}
          onClick={() => generate.mutate()}
        >
          {generate.isPending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Sparkles size={12} />
          )}
          {generate.isPending ? "drafting" : draft ? "regenerate" : "generate with llm"}
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!draft.trim() || send.isPending || generate.isPending}
          onClick={() => send.mutate()}
        >
          {send.isPending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
          {send.isPending ? "sending" : "send reply"}
        </Button>
      </div>
    </div>
  );
}
