import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type {
  ReplyThread,
  ReplyStateRequest,
  LinkedInAccountView,
} from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { IS_DEMO } from "../api/demo.ts";
import { Button } from "../components/primitives/Button.tsx";
import { Badge } from "../components/primitives/Badge.tsx";
import { Input } from "../components/primitives/Field.tsx";
import { Pii } from "../components/primitives/Pii.tsx";
import { MailboxConnections } from "../components/MailboxInbox.tsx";
import { ReplyOptionsComposer } from "../components/ReplyOptionsComposer.tsx";
import { timeAgo } from "../lib/cn.ts";
import { readOnly } from "../lib/readOnly.ts";
import { replyInView, replyNeedsAttention, type ReplyView } from "../lib/replies.ts";

export const Route = createFileRoute("/inbox")({
  staticData: { title: "Replies" },
  component: InboxPage,
});

function InboxPage() {
  const [view, setView] = useState<ReplyView>("inbox");
  const [channel, setChannel] = useState("all");
  const [match, setMatch] = useState("matched");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const inbox = useQuery({ queryKey: ["replies"], queryFn: api.replies, refetchInterval: 60_000 });
  const threads = inbox.data?.threads ?? [];
  const filtered = threads.filter(
    (t) =>
      (channel === "all" || t.channel === channel) &&
      (match === "all" ||
        (match === "matched" && t.prospectId != null) ||
        (match === "no-match" && t.prospectId == null) ||
        (match === "unassigned" && t.channel === "linkedin" && !t.workspace)) &&
      `${t.name} ${t.address} ${t.company ?? ""} ${t.subject}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const visible = filtered.filter((t) => replyInView(t, view));
  const refresh = useMutation({
    mutationFn: async () => {
      const results = await Promise.allSettled([
        inbox.data?.mailboxes.length ? api.mailboxRefresh() : Promise.resolve(),
        api.linkedinAction({ action: "refresh" }),
      ]);
      await inbox.refetch();
      for (const r of results)
        if (r.status === "rejected")
          toast.error(
            r.reason instanceof Error ? r.reason.message : "A connection could not refresh",
          );
    },
  });
  useEffect(() => {
    setPage(1);
  }, [view, channel, match, search]);
  const attention = threads.filter(replyNeedsAttention).length;
  return (
    <div className="-mx-6 -my-6 flex flex-col">
      <section className="flex flex-wrap items-end justify-between gap-4 border-b border-ink-rule px-6 pb-5 pt-6">
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
          <p className="mt-3 max-w-[65ch] text-[13px] text-ink-muted">
            Email and LinkedIn conversations. Compare three replies, make one yours, and send it
            here.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {attention > 0 && <Badge tone="spend">{attention} need a reply</Badge>}
          <Button
            size="sm"
            variant="ghost"
            disabled={inbox.isFetching || refresh.isPending}
            onClick={() => refresh.mutate()}
            {...readOnly}
          >
            {inbox.isFetching || refresh.isPending ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}{" "}
            Refresh
          </Button>
        </div>
      </section>
      <MailboxConnections mailboxes={inbox.data?.mailboxes ?? []} />
      <LinkedInConnections accounts={inbox.data?.accounts ?? []} />
      <div className="flex flex-wrap items-center gap-2 border-b border-ink-rule/60 px-6 py-3">
        {(["all", "email", "linkedin"] as const).map((c) => (
          <Button
            key={c}
            size="sm"
            variant={channel === c ? "secondary" : "ghost"}
            onClick={() => setChannel(c)}
          >
            {c === "all" ? "All channels" : c === "email" ? "Email" : "LinkedIn"}
          </Button>
        ))}
        <select
          aria-label="Prospect match filter"
          className="rounded-sm border border-ink-rule bg-ink-bg px-2 py-1 text-[12px] text-ink-cream"
          value={match}
          onChange={(e) => setMatch(e.target.value)}
        >
          <option value="matched">Matched prospects</option>
          <option value="all">All conversations</option>
          <option value="no-match">No prospect match</option>
          <option value="unassigned">Unassigned LinkedIn</option>
        </select>
        <Input
          aria-label="Search conversations"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search conversations"
          className="ml-auto max-w-xs"
        />
      </div>
      <div className="flex gap-2 border-b border-ink-rule/60 px-6 py-3">
        {(["inbox", "snoozed", "archived"] as const).map((v) => (
          <Button
            key={v}
            size="sm"
            variant={view === v ? "secondary" : "ghost"}
            onClick={() => {
              setView(v);
              setExpanded(null);
            }}
          >
            <span className="capitalize">{v}</span>
            <span className="ml-1 opacity-60">
              {filtered.filter((t) => replyInView(t, v)).length}
            </span>
          </Button>
        ))}
      </div>
      {(inbox.error || inbox.data?.error) && (
        <p role="alert" className="px-6 py-3 text-[12px] text-ink-blocked-2">
          {inbox.error?.message ?? inbox.data?.error}. Saved conversations remain available.
        </p>
      )}
      {inbox.isLoading ? (
        <p className="px-6 py-6 text-ink-muted">Loading conversations…</p>
      ) : visible.length === 0 ? (
        <p className="px-6 py-8 text-[13px] text-ink-muted">
          {view === "snoozed"
            ? "No snoozed conversations. Snooze a thread to return to it in five days."
            : view === "archived"
              ? "No archived conversations in this view."
              : "No conversations in this view. Try All conversations or refresh your connections."}
        </p>
      ) : (
        visible
          .slice((page - 1) * 30, page * 30)
          .map((t) => (
            <ThreadRow
              key={t.key}
              thread={t}
              expanded={expanded === t.key}
              onToggle={() => setExpanded(expanded === t.key ? null : t.key)}
            />
          ))
      )}
      {visible.length > 30 && (
        <div className="flex items-center justify-end gap-3 px-6 py-4 text-[12px] text-ink-muted">
          <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <span>
            Page {page} of {Math.ceil(visible.length / 30)}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={page * 30 >= visible.length}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      )}
      {inbox.data?.hasMore && (
        <p className="px-6 py-3 text-[11px] text-ink-muted">
          The live email window contains more messages. Saved conversations remain available here.
        </p>
      )}
    </div>
  );
}

function LinkedInConnections({ accounts }: { accounts: LinkedInAccountView[] }) {
  const queryClient = useQueryClient();
  const [intent, setIntent] = useState<{ id: string; accountKey?: string } | null>(null);
  const [connectUrl, setConnectUrl] = useState<string | null>(null);
  const connect = useMutation({
    mutationFn: (accountKey?: string) =>
      api.linkedinAction({ action: accountKey ? "reconnect" : "connect", accountKey }),
    onSuccess: (r, accountKey) => {
      if (r.url && r.intent_id) {
        setConnectUrl(r.url);
        setIntent({ id: r.intent_id, accountKey });
        window.open(r.url, "_blank", "noopener,noreferrer");
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const status = useQuery({
    queryKey: ["linkedin-connection", intent?.id],
    queryFn: () =>
      api.linkedinAction({
        action: "connection",
        intentId: intent!.id,
        accountKey: intent?.accountKey,
      }),
    enabled: !!intent && !IS_DEMO,
    refetchInterval: 5000,
  });
  useEffect(() => {
    if (!status.data || ["pending", "verifying"].includes(status.data.status ?? "pending")) return;
    if (status.data.status === "completed") {
      toast.success("LinkedIn connected");
      void queryClient.invalidateQueries({ queryKey: ["replies"] });
    } else toast.error(status.data.failure_reason ?? `Connection ${status.data.status}`);
    setIntent(null);
    setConnectUrl(null);
  }, [status.data, queryClient]);
  const sync = useMutation({
    mutationFn: (accountKey: string) => api.linkedinAction({ action: "sync", accountKey }),
    onSuccess: () => {
      toast.message("History import started. New messages will appear as they arrive.");
      void queryClient.invalidateQueries({ queryKey: ["replies"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <details
      className="border-b border-ink-rule/60 px-6 py-3"
      open={accounts.some((a) => a.error || a.status !== "connected") || !!intent}
    >
      <summary className="cursor-pointer text-[12px] text-ink-muted">
        LinkedIn connections ({accounts.filter((a) => a.status === "connected").length})
      </summary>
      <div className="mt-3 space-y-3">
        {accounts.map((a) => (
          <div key={a.key} className="text-[12px] text-ink-muted">
            <div className="flex flex-wrap items-center gap-2">
              <Pii kind="name">{a.name}</Pii>
              <Badge tone={a.status === "connected" ? "neutral" : "blocked"}>
                {a.status.replaceAll("_", " ")}
              </Badge>
              <span>
                {a.syncState.replaceAll("_", " ")}
                {a.lastCheckedAt ? ` · checked ${timeAgo(a.lastCheckedAt)}` : ""}
              </span>
              {a.status === "reconnect_required" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={connect.isPending}
                  onClick={() => connect.mutate(a.key)}
                  {...readOnly}
                >
                  Reconnect
                </Button>
              )}
              {a.status === "connected" && !a.complete && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={sync.isPending || a.syncState === "syncing"}
                  onClick={() => sync.mutate(a.key)}
                  {...readOnly}
                >
                  {a.syncState === "never_synced" ? "Import history" : "Continue import"} · paid
                </Button>
              )}
            </div>
            {!a.complete && (
              <p className="mt-1">History is incomplete. This is not the full inbox yet.</p>
            )}
            {a.error && (
              <p role="alert" className="mt-1 text-ink-blocked-2">
                {a.error}
              </p>
            )}
          </div>
        ))}
        <Button
          size="sm"
          variant="ghost"
          disabled={connect.isPending || !!intent}
          onClick={() => connect.mutate(undefined)}
          {...readOnly}
        >
          {connect.isPending ? "Opening connection…" : "Connect LinkedIn"}
        </Button>
        {connectUrl && (
          <p className="text-[12px] text-ink-muted">
            <a className="underline" href={connectUrl} target="_blank" rel="noreferrer">
              Open LinkedIn login
            </a>{" "}
            · waiting for connection{status.error ? ` · ${status.error.message}` : ""}
          </p>
        )}
        <p className="text-[11px] text-ink-muted">
          Messaging uses its own connection. Refresh reads saved history; Import history starts a
          paid sync.
        </p>
      </div>
    </details>
  );
}

function ThreadRow({
  thread: t,
  expanded,
  onToggle,
}: {
  thread: ReplyThread;
  expanded: boolean;
  onToggle: () => void;
}) {
  const queryClient = useQueryClient();
  const [assignOpen, setAssignOpen] = useState(false);
  const [matchEmail, setMatchEmail] = useState("");
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["replies"] });
  const state = useMutation({
    mutationFn: (action: ReplyStateRequest["action"]) =>
      api.replyState({
        key: t.key,
        action,
        observedReplyIds: t.messages
          .filter((m) => m.direction === "inbound" && m.human && !m.deleted)
          .map((m) => m.id),
      }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });
  const history = useMutation({
    mutationFn: () => api.mailboxHistory(t.mailboxThreadKey!),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });
  const match = useMutation({
    mutationFn: () => api.mailboxMatch(t.mailboxThreadKey!, matchEmail),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });
  useEffect(() => {
    if (expanded && t.mailboxThreadKey && !IS_DEMO) {
      void api
        .mailboxState({
          threadKey: t.mailboxThreadKey,
          read: true,
          observedReplyIds: t.messages.filter((m) => m.direction === "inbound").map((m) => m.id),
        })
        .catch((e) => toast.error(e.message));
    }
  }, [expanded, t.key, t.mailboxThreadKey, t.messages]);
  return (
    <article className="border-b border-ink-rule/60">
      <div className="flex flex-wrap items-center gap-2 pr-6">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex min-w-0 flex-1 basis-full items-center gap-3 px-6 py-4 sm:basis-0 text-left hover:bg-ink-surface/60"
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] text-ink-cream">
              <Pii kind="name">{t.name}</Pii>
              {t.company && (
                <span className="text-ink-muted">
                  {" "}
                  · <Pii kind="company">{t.company}</Pii>
                </span>
              )}
            </div>
            <div className="truncate text-[12px] text-ink-muted">{t.subject || "(No subject)"}</div>
            <div className="mt-1 text-[11px] text-ink-faint">
              {timeAgo(t.lastActivityAt)}
              {t.snoozedUntil && ` · returns ${new Date(t.snoozedUntil).toLocaleString()}`}
            </div>
          </div>
          <Badge tone="neutral">{t.channel === "linkedin" ? "LinkedIn" : "Email"}</Badge>
          {!t.prospectId && (
            <Badge tone="neutral">{t.channel === "linkedin" ? "Unassigned" : "No match"}</Badge>
          )}
          {t.needsReply && !t.archivedAt && !t.snoozedUntil && (
            <Badge tone="signal">Needs reply</Badge>
          )}
        </button>
        {!t.archivedAt && (
          <Button
            size="sm"
            variant="ghost"
            disabled={state.isPending}
            onClick={() => state.mutate(t.snoozedUntil ? "unsnooze" : "snooze")}
            {...readOnly}
          >
            {t.snoozedUntil ? "Unsnooze" : "Snooze 5 days"}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={state.isPending}
          onClick={() => state.mutate(t.archivedAt ? "restore" : "archive")}
          {...readOnly}
        >
          {t.archivedAt ? "Restore" : "Archive"}
        </Button>
      </div>
      {expanded && (
        <div className="space-y-4 bg-ink-bg-deep/40 px-6 py-4">
          <div className="flex flex-wrap gap-2">
            {t.channel === "linkedin" && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setAssignOpen(!assignOpen)}
                  {...readOnly}
                >
                  {t.workspace ? "Change assignment" : "Assign workspace and prospect"}
                </Button>
                {t.profileUrl && (
                  <a
                    href={t.profileUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="self-center text-[12px] text-ink-muted underline"
                  >
                    LinkedIn profile
                  </a>
                )}
              </>
            )}
            {t.mailboxThreadKey && (
              <>
                <Input
                  aria-label="Prospect email for matching"
                  className="max-w-xs"
                  value={matchEmail}
                  onChange={(e) => setMatchEmail(e.target.value)}
                  placeholder="Existing prospect’s email"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!matchEmail.trim() || match.isPending}
                  onClick={() => match.mutate()}
                  {...readOnly}
                >
                  Match prospect
                </Button>
              </>
            )}
          </div>
          {assignOpen && (
            <Assignment
              thread={t}
              onDone={() => {
                setAssignOpen(false);
                void invalidate();
              }}
            />
          )}
          <div className="max-h-[480px] space-y-3 overflow-auto">
            {t.messages.map((m) => (
              <div
                key={m.id}
                className={`max-w-[85%] rounded-sm border border-ink-rule/60 px-3 py-2 ${m.direction === "outbound" ? "ml-auto bg-ink-surface" : "bg-ink-surface/30"}`}
              >
                <div className="mb-1 text-[11px] text-ink-faint">
                  {m.direction === "outbound" ? "You" : <Pii kind="name">{t.name}</Pii>} ·{" "}
                  {timeAgo(m.at)}
                  {!m.human && " · automatic message"}
                </div>
                <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-cream-2">
                  {m.deleted
                    ? "Message deleted"
                    : m.body ||
                      (m.attachment ? "Attachment — open LinkedIn to review" : "(No text body)")}
                </p>
              </div>
            ))}
          </div>
          {t.mailboxThreadKey && !t.historyComplete && (
            <Button
              size="sm"
              variant="ghost"
              disabled={history.isPending}
              onClick={() => history.mutate()}
            >
              {history.isPending ? "Loading history…" : "Load more history"}
            </Button>
          )}
          <ReplyOptionsComposer key={t.key} thread={t} />
        </div>
      )}
    </article>
  );
}

function Assignment({ thread, onDone }: { thread: ReplyThread; onDone: () => void }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const prospects = useQuery({
    queryKey: ["reply-prospects", search],
    queryFn: () => api.replyProspects(search),
  });
  const assign = useMutation({
    mutationFn: () => {
      const p = prospects.data?.prospects.find((p) => `${p.workspace}:${p.id}` === selected);
      if (!p) throw new Error("Select a prospect");
      return api.assignReply(thread.key, p.workspace, p.id);
    },
    onSuccess: onDone,
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-sm border border-ink-rule p-3">
      <Input
        aria-label="Search prospects"
        className="max-w-xs"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setSelected("");
        }}
        placeholder="Search prospects"
      />
      <select
        aria-label="Workspace and prospect"
        className="max-w-full rounded-sm border border-ink-rule bg-ink-bg px-2 py-2 text-[12px]"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
      >
        <option value="">Choose a prospect</option>
        {prospects.data?.prospects.map((p) => (
          <option key={`${p.workspace}:${p.id}`} value={`${p.workspace}:${p.id}`}>
            {p.workspace} · {p.name}
            {p.email ? ` (${p.email})` : ""}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        disabled={!selected || assign.isPending}
        onClick={() => assign.mutate()}
        {...readOnly}
      >
        Assign
      </Button>
      {prospects.error && <p role="alert">{prospects.error.message}</p>}
    </div>
  );
}
