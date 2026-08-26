import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Send, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { ConversationView, InboxReplyView } from "@oneshot-gtm/shared-types";
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
    case "bounced":
      return "blocked";
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
  // Ledger-backed threaded view — complete regardless of the live window.
  const conversations = inbox.data?.conversations ?? [];
  const error = inbox.data?.error;
  // The server fetches a clamped window (newest 200 across all identities).
  // When listInbox says there was more, all/no-match totals get a "+" so the
  // page never presents the window as the whole mailbox. `matched` is exact —
  // it comes from the ledger, not the window.
  const windowSuffix = inbox.data?.hasMore ? "+" : "";
  const noMatchCount = replies.filter((r) => r.matched == null).length;
  const countFor = (key: ReplyMatchFilter): number =>
    key === "matched" ? conversations.length : key === "no-match" ? noMatchCount : replies.length;
  const suffixFor = (key: ReplyMatchFilter): string => (key === "matched" ? "" : windowSuffix);
  const visible = replies.filter((r) => matchesReplyFilter(r, matchFilter));
  const showConversations = matchFilter === "matched";

  return (
    <div className="-mx-6 -my-6 flex flex-col">
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
              : showConversations
                ? `${conversations.length} conversation${conversations.length === 1 ? "" : "s"}`
                : matchFilter === "all"
                  ? `${replies.length}${windowSuffix} repl${replies.length === 1 && !windowSuffix ? "y" : "ies"}`
                  : `${visible.length} of ${replies.length}${windowSuffix}`}
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

      {/* Match-status filter — most inbox mail is unmatched noise; `matched` = real prospect replies. */}
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
            {/* opacity, not a fixed faint color, so the count stays legible on any button fill. */}
            {inbox.data && (
              <span className="ml-1 font-mono opacity-60">
                {/* all/no-match counts come from the truncated window (lower bounds when
                    hasMore); matched is ledger-truth, so it's exact. */}
                {countFor(f.key)}
                {suffixFor(f.key)}
              </span>
            )}
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
      ) : showConversations ? (
        conversations.length === 0 ? (
          <div className="p-5">
            <EmptyNote note="No conversations yet. When a prospect writes back, the whole exchange shows here." />
          </div>
        ) : (
          <div>
            {conversations.map((c, i) => (
              <ConversationRow
                key={c.prospectId}
                conversation={c}
                zebra={i % 2 === 1}
                expanded={expanded === `c:${c.prospectId}`}
                onToggle={() =>
                  setExpanded(expanded === `c:${c.prospectId}` ? null : `c:${c.prospectId}`)
                }
              />
            ))}
          </div>
        )
      ) : replies.length === 0 ? (
        <div className="p-5">
          <EmptyNote note="No replies yet. When a prospect writes back, it shows here." />
        </div>
      ) : visible.length === 0 ? (
        <div className="p-5">
          <EmptyNote note="No unmatched replies — every reply here matches a prospect." />
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

/** Best-effort provider from an identity id — for ledger-backed rows the live window didn't attribute. */
function providerFromIdentity(id: string | null): "gmail" | "oneshot" | "smartlead" | null {
  if (!id) return null;
  if (id.startsWith("gmail:") || id === "legacy-gmail") return "gmail";
  if (id.startsWith("smartlead:")) return "smartlead";
  return "oneshot";
}

function ConversationRow({
  conversation,
  zebra,
  expanded,
  onToggle,
}: {
  conversation: ConversationView;
  zebra: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const c = conversation;
  const who = c.name ?? c.email;
  const replyCount = c.items.filter((i) => i.kind === "reply").length;
  const newest = [...c.items].reverse().find((i) => i.kind === "reply");
  // The composer answers the newest inbound; sent history renders in the
  // timeline, so the composer's own history is deliberately empty.
  const composerReply: InboxReplyView | null = newest
    ? {
        id: newest.id,
        fromEmail: c.email,
        fromRaw: c.email,
        subject: newest.subject ?? "",
        receivedAt: newest.at,
        body: newest.body,
        sourceIdentityId: newest.sourceIdentityId,
        sourceProvider: providerFromIdentity(newest.sourceIdentityId),
        threadId: newest.threadId,
        messageId: newest.messageId,
        matched: {
          name: c.name,
          company: c.company,
          playName: c.playName,
          cadenceStatus: c.cadenceStatus,
        },
        thread: { draftBody: c.draftBody, sent: [] },
      }
    : null;
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
            {c.company ? (
              <span className="truncate font-mono text-[11px] text-ink-faint">
                · <Pii kind="company">{c.company}</Pii>
              </span>
            ) : null}
          </span>
          <span className="block truncate text-[12px] text-ink-muted">
            {newest?.subject || `${c.items.length} messages`}
          </span>
        </span>
        <span className="shrink-0 font-mono text-[11px] text-ink-faint">
          {replyCount} repl{replyCount === 1 ? "y" : "ies"}
        </span>
        <Badge tone={statusTone(c.cadenceStatus)}>
          {c.playName ?? "prospect"}
          {c.cadenceStatus ? ` · ${c.cadenceStatus}` : ""}
        </Badge>
        <span className="shrink-0 font-mono text-[12px] text-ink-muted">
          {timeAgo(c.lastActivityAt)}
        </span>
      </button>
      {expanded && (
        <div className="border-b border-ink-rule/60 bg-ink-bg-deep/50 px-6 py-3">
          <div className="flex flex-col gap-2">
            {c.items.map((item, i) => (
              <ConversationItemBlock key={i} item={item} />
            ))}
          </div>
          {composerReply ? (
            {/* Keyed by inbound id: when a newer reply arrives mid-compose the
                composer remounts for it (the unmount flush saves the old draft
                under the OLD thread key) instead of silently sending old text
                into the new thread. */}
            <ReplyComposer key={composerReply.id} reply={composerReply} />
          ) : (
            <div className="mt-3 border-t border-ink-rule/60 pt-3 font-mono text-[11px] text-ink-faint">
              nothing inbound to answer yet
            </div>
          )}
        </div>
      )}
    </>
  );
}

function ConversationItemBlock({ item }: { item: ConversationView["items"][number] }) {
  if (item.kind === "reply") {
    return (
      <div className="rounded-sm border border-[color:var(--ink-signal)]/40 bg-ink-surface/40 px-3 py-2">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
          them · {timeAgo(item.at)}
          {item.subject ? ` · ${item.subject}` : ""}
        </div>
        <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-[1.6] text-ink-cream">
          {item.body || "(no body)"}
        </pre>
      </div>
    );
  }
  if (item.kind === "sent") {
    return (
      <div className="rounded-sm border border-ink-rule/60 bg-ink-surface/30 px-3 py-2">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
          you replied · {timeAgo(item.at)}
        </div>
        <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-[1.6] text-ink-cream-2">
          {item.body}
        </pre>
      </div>
    );
  }
  return (
    <div className="rounded-sm border border-ink-rule/40 px-3 py-2 opacity-80">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
        you · step {item.stepIndex} · {item.playName} · {timeAgo(item.at)}
        {item.subject ? ` · ${item.subject}` : ""}
      </div>
      {item.body ? (
        <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-[1.6] text-ink-muted">
          {item.body}
        </pre>
      ) : (
        <div className="font-mono text-[11px] text-ink-faint">(body not recorded)</div>
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
  if (id.startsWith("smartlead:")) return id.slice("smartlead:".length);
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
        id: reply.id,
        threadId: reply.threadId,
      }),
    onSuccess: (res) => {
      setDraft(res.body);
      if (res.researched && res.costUsd > 0) {
        toast.success(`draft ready · researched sender ($${res.costUsd.toFixed(2)})`);
      }
    },
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
          disabled={!reply.body || generate.isPending || send.isPending}
          title={reply.body ? undefined : "this email has no body to draft a reply from"}
          onClick={() => generate.mutate()}
        >
          {generate.isPending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Sparkles size={12} />
          )}
          {generate.isPending
            ? reply.matched
              ? "drafting"
              : "researching + drafting"
            : draft
              ? "regenerate"
              : "generate with llm"}
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
