import { linkedInConnectionView } from "../lib/linkedinConnection.ts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "../design/replies.css";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Archive,
  Clock3,
  ExternalLink,
  Inbox,
  MessageSquare,
  Mail,
  Loader2,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { toast } from "sonner";
import type {
  ReplyThread,
  ReplyStateRequest,
  LinkedInAccountView,
} from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { IS_DEMO } from "../api/demo.ts";
import { Button } from "../components/primitives/Button.tsx";
import { Input } from "../components/primitives/Field.tsx";
import { Pii } from "../components/primitives/Pii.tsx";
import { MailboxConnections } from "../components/MailboxInbox.tsx";
import { ReplyPreferences } from "../components/ReplyPreferences.tsx";
import { ReplyOptionsComposer } from "../components/ReplyOptionsComposer.tsx";
import { replyCompany, replyPreview } from "../lib/replyPreview.ts";
import { timeAgo } from "../lib/cn.ts";
import { readOnly } from "../lib/readOnly.ts";
import { replyInView, replyNeedsAttention, type ReplyView } from "../lib/replies.ts";
import { useReplyScroll } from "../lib/useReplyScroll.ts";
import { linkedinUrlFor } from "../lib/payloadIdentity.ts";

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
        (match === "missing-identity" && t.matchStatus === "missing_identity") ||
        (match === "no-prospect" && t.matchStatus === "no_prospect") ||
        (match === "ambiguous" && t.matchStatus === "ambiguous") ||
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
  const selected = visible.find((t) => t.key === expanded);
  const selectedKey = selected?.key;
  const pageCount = Math.max(1, Math.ceil(visible.length / 30));
  const currentPage = Math.min(page, pageCount);
  const queueRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const queueScrollTop = useRef(0);
  const selectedButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreQueueFocus = useRef(false);
  useLayoutEffect(() => {
    queueScrollTop.current = 0;
    queueRef.current?.scrollTo({ top: 0 });
  }, [currentPage, view, channel, match, search]);
  useEffect(() => {
    const queue = queueRef.current;
    if (!queue) return;
    const observer = new ResizeObserver(() => {
      if (queue.clientHeight) queue.scrollTop = queueScrollTop.current;
    });
    observer.observe(queue);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (selectedKey && queueRef.current?.clientHeight === 0) {
      detailRef.current
        ?.querySelector<HTMLElement>(".replies-thread-body")
        ?.focus({ preventScroll: true });
    } else if (!selectedKey && restoreQueueFocus.current) {
      const button = selectedButtonRef.current;
      (button?.isConnected ? button : queueRef.current)?.focus({ preventScroll: true });
      restoreQueueFocus.current = false;
    }
  }, [selectedKey]);
  return (
    <div className={`replies-page ${selected ? "has-selection" : ""}`}>
      <header className="replies-heading">
        <div>
          <h1>Replies</h1>
          <p>
            {attention
              ? `${attention} conversations waiting for you`
              : "Your conversations, all in one place"}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={inbox.isFetching || refresh.isPending}
          onClick={() => refresh.mutate()}
          {...readOnly}
        >
          {inbox.isFetching || refresh.isPending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          Refresh
        </Button>
      </header>
      <details className="replies-settings">
        <summary>
          <Settings2 size={14} /> Connections & reply preferences
          <span className="replies-settings-count">
            {inbox.data?.mailboxes.filter((m) => m.status === "connected").length ?? 0} email ·{" "}
            {inbox.data?.accounts.length ?? 0} LinkedIn
            {inbox.data?.accounts.some((a) => linkedInConnectionView(a).attention)
              ? " · needs attention"
              : ""}
          </span>
        </summary>
        <MailboxConnections mailboxes={inbox.data?.mailboxes ?? []} />
        <LinkedInConnections accounts={inbox.data?.accounts ?? []} />
        {inbox.data && (
          <ReplyPreferences key={inbox.data.workspace} workspace={inbox.data.workspace} />
        )}
      </details>
      <div className="replies-filters flex flex-wrap items-center gap-2 border-b border-ink-rule/60 px-6 py-3">
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
        <div className="replies-match-switch" role="group" aria-label="Conversation matching">
          {(
            [
              ["matched", "Matched"],
              ["no-match", "Unmatched"],
              ["all", "All"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={match === value}
              onClick={() => {
                setMatch(value);
                setExpanded(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          aria-label="Detailed matching filters"
          className="max-w-full rounded-sm border border-ink-rule bg-ink-bg px-2 py-1 text-[12px] text-ink-muted"
          value={["matched", "no-match", "all"].includes(match) ? "" : match}
          onChange={(e) => {
            setMatch(e.target.value);
            setExpanded(null);
          }}
        >
          <option value="" disabled>
            More filters
          </option>
          <option value="missing-identity">Identity not resolved</option>
          <option value="no-prospect">Resolved · no prospect</option>
          <option value="ambiguous">Multiple matches · review assignment</option>
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
      <div className="replies-views flex gap-2 border-b border-ink-rule/60 px-6 py-3">
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
      <div className={`replies-workspace ${selected ? "has-selection" : ""}`}>
        <aside className="replies-queue" aria-label="Conversations">
          <div className="replies-queue-heading">
            <span>
              {view === "inbox" ? "Conversations" : view === "snoozed" ? "Snoozed" : "Archived"}
            </span>
            <span>{visible.length}</span>
          </div>
          <div
            ref={queueRef}
            className="replies-queue-list"
            role="region"
            tabIndex={0}
            aria-label="Conversation list"
            onScroll={(event) => {
              if (event.currentTarget.clientHeight)
                queueScrollTop.current = event.currentTarget.scrollTop;
            }}
          >
            {inbox.isLoading ? (
              <p className="replies-empty">Loading conversations…</p>
            ) : visible.length === 0 ? (
              <p className="replies-empty">
                {view === "snoozed"
                  ? "No snoozed conversations."
                  : view === "archived"
                    ? "No archived conversations."
                    : "No conversations found. Try another filter or refresh your connections."}
              </p>
            ) : (
              visible.slice((currentPage - 1) * 30, currentPage * 30).map((t) => {
                const lastMessage = t.messages.findLast((m) => !m.deleted);
                const company = replyCompany(t.company);
                const preview = lastMessage ? replyPreview(lastMessage.body, t.channel) : "";
                return (
                  <button
                    key={t.key}
                    type="button"
                    className="replies-conversation"
                    aria-current={selected?.key === t.key ? "true" : undefined}
                    onClick={(event) => {
                      selectedButtonRef.current = event.currentTarget;
                      setExpanded(t.key);
                    }}
                  >
                    <span className="replies-avatar" aria-hidden="true">
                      {t.channel === "linkedin" ? <MessageSquare size={17} /> : <Mail size={17} />}
                    </span>
                    <span className="replies-preview">
                      <span className="replies-preview-top">
                        <strong>
                          <Pii kind="name">{t.name}</Pii>
                        </strong>
                        <time>{timeAgo(t.lastActivityAt)}</time>
                      </span>
                      <span className="replies-company">
                        {company ? (
                          <Pii kind="company">{company}</Pii>
                        ) : t.channel === "email" && t.address ? (
                          <Pii kind="email">{t.address}</Pii>
                        ) : t.channel === "linkedin" ? (
                          "LinkedIn"
                        ) : (
                          "Email"
                        )}
                      </span>
                      <span className="replies-snippet">
                        {lastMessage?.direction === "outbound" ? "You: " : ""}
                        {preview ||
                          (lastMessage?.attachment ? "Attachment" : t.subject) ||
                          "Open conversation"}
                      </span>
                      <span className="replies-preview-status">
                        {replyNeedsAttention(t) ? (
                          <span className="replies-needs-reply">Needs reply</span>
                        ) : (
                          <span>
                            {t.archivedAt
                              ? "Archived"
                              : t.snoozedUntil
                                ? "Snoozed"
                                : "No reply needed"}
                          </span>
                        )}
                        {t.drafts && Object.values(t.drafts.edits).some((text) => text.trim()) && (
                          <span>Draft saved</span>
                        )}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {pageCount > 1 && (
            <div className="replies-pagination">
              <Button
                size="sm"
                variant="ghost"
                disabled={currentPage <= 1}
                onClick={() => setPage(currentPage - 1)}
              >
                Previous
              </Button>
              <span>
                {currentPage} / {pageCount}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={currentPage >= pageCount}
                onClick={() => setPage(currentPage + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </aside>
        <section ref={detailRef} className="replies-detail" aria-label="Selected conversation">
          {selected ? (
            <ThreadRow
              key={selected.key}
              thread={selected}
              expanded
              onToggle={() => {
                restoreQueueFocus.current = true;
                setExpanded(null);
              }}
            />
          ) : (
            <div className="replies-placeholder">
              <Inbox size={32} strokeWidth={1.3} />
              <h2>A little room to reply.</h2>
              <p>
                Select a conversation to read the thread
                <br />
                and make your next reply yours.
              </p>
            </div>
          )}
        </section>
      </div>
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
      api.linkedinAction({
        action: accountKey
          ? accounts.find((a) => a.key === accountKey)?.canResolve ||
            accounts.some((a) => a.key === accountKey && linkedInConnectionView(a).reconnect)
            ? "reconnect"
            : "upgrade"
          : "connect",
        accountKey,
      }),
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
    } else {
      toast.error(
        status.data.failure_reason === "duplicate_member"
          ? "OneShot rejected the permission upgrade for an existing connection. See connection details."
          : (status.data.failure_reason ?? `Connection ${status.data.status}`),
      );
      void queryClient.invalidateQueries({ queryKey: ["replies"] });
    }
    setIntent(null);
    setConnectUrl(null);
  }, [status.data, queryClient]);
  const sync = useMutation({
    mutationFn: (accountKey: string) => api.linkedinAction({ action: "backfill", accountKey }),
    onSuccess: () => {
      toast.message("Backfill started. Progress is saved and shared across workspaces.");
      void queryClient.invalidateQueries({ queryKey: ["replies"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const [confirmAction, setConfirmAction] = useState<{
    key: string;
    action: "remove" | "force-reconnect";
  } | null>(null);
  const accountAction = useMutation({
    mutationFn: (request: { accountKey: string; action: "remove" | "force-reconnect" }) =>
      api.linkedinAction(request),
    onSuccess: (result, request) => {
      setConfirmAction(null);
      if (request.action === "remove") {
        toast.success("Connection removed. Imported messages are kept.");
        if (result.upstreamDeleted === false)
          toast.warning("Access revoked; provider disconnection is still pending.");
      } else if (result.url && result.intent_id) {
        setConnectUrl(result.url);
        setIntent({ id: result.intent_id, accountKey: request.accountKey });
        window.open(result.url, "_blank", "noopener,noreferrer");
      }
      void queryClient.invalidateQueries({ queryKey: ["replies"] });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ["replies"] });
    },
  });
  const attentionCount = accounts.filter((a) => linkedInConnectionView(a).attention).length;
  return (
    <details
      className="replies-linkedin border-b border-ink-rule/60 px-6 py-3"
      open={attentionCount > 0 || !!intent}
    >
      <summary className="replies-connection-summary">
        LinkedIn
        <span>
          {accounts.length === 0
            ? "Not connected"
            : attentionCount
              ? `${attentionCount} ${attentionCount === 1 ? "account needs" : "accounts need"} attention`
              : `${accounts.length} connected`}
        </span>
      </summary>
      <div className="replies-connection-list">
        {accounts.map((a) => {
          const view = linkedInConnectionView(a);
          const diagnostics = [
            ...new Set([a.permissionUpgradeError, a.backfill?.error, a.error].filter(Boolean)),
          ];
          return (
            <div key={a.key} className="replies-connection text-[12px] text-ink-muted">
              <div className="replies-connection-header">
                <div>
                  <strong className="replies-connection-name">
                    <Pii kind="name">{a.name}</Pii>
                  </strong>
                  <p className={view.attention ? "text-ink-blocked-2" : "text-ink-muted"}>
                    {view.title}
                  </p>
                </div>
                <div className="replies-connection-actions">
                  {(view.reconnect || view.needsPermissions) && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={
                        connect.isPending ||
                        accountAction.isPending ||
                        !!intent ||
                        (!!a.permissionUpgradeError && !view.reconnect)
                      }
                      onClick={() => connect.mutate(a.key)}
                      {...readOnly}
                    >
                      {connect.isPending && connect.variables === a.key
                        ? "Opening…"
                        : view.reconnect
                          ? "Reconnect"
                          : "Allow profile access"}
                    </Button>
                  )}
                  {view.connected && !view.needsPermissions && !view.running && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={sync.isPending || accountAction.isPending}
                      onClick={() => sync.mutate(a.key)}
                      {...readOnly}
                    >
                      {sync.isPending && sync.variables === a.key
                        ? "Starting…"
                        : view.paused
                          ? "Resume import"
                          : "Import history"}
                    </Button>
                  )}
                </div>
              </div>
              {view.description && (
                <p className="replies-connection-description">{view.description}</p>
              )}
              {a.backfill && !view.reconnect && !view.paused && (
                <div className="replies-sync">
                  <p>
                    {a.backfill.stage === "complete"
                      ? "History import complete"
                      : a.backfill.nextAttemptAt
                        ? `Daily limit reached. Resumes ${new Date(a.backfill.nextAttemptAt).toLocaleString()}.`
                        : "Importing conversation history…"}
                  </p>
                  {view.showProgress && a.backfill.senders && (
                    <>
                      <progress
                        aria-label={`Profiles checked for ${a.name}`}
                        value={a.backfill.senders.resolved}
                        max={a.backfill.senders.total}
                      />
                      <p className="mt-2">
                        {a.backfill.senders.resolved} of {a.backfill.senders.total} profiles checked
                      </p>
                    </>
                  )}
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={accountAction.isPending || connect.isPending || !!intent}
                  onClick={() => {
                    accountAction.reset();
                    setConfirmAction({ key: a.key, action: "force-reconnect" });
                  }}
                  {...readOnly}
                >
                  Force reconnect
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={accountAction.isPending || connect.isPending || !!intent}
                  onClick={() => {
                    accountAction.reset();
                    setConfirmAction({ key: a.key, action: "remove" });
                  }}
                  {...readOnly}
                >
                  Remove connection
                </Button>
              </div>
              {confirmAction?.key === a.key && (
                <div
                  className="my-3 space-y-3 rounded border border-ink-rule p-3"
                  role="group"
                  aria-label="Confirm connection change"
                >
                  <p className="text-ink-cream-2">
                    {confirmAction.action === "remove"
                      ? "Remove this LinkedIn connection from all workspaces? OneShot access will be revoked and pending sends cancelled. All imported messages and assignments stay saved."
                      : "Disconnect this account and open a fresh LinkedIn login? This affects all workspaces and cancels pending sends. All imported messages and assignments stay saved. Sign in to the same LinkedIn account. If the connection service is unavailable, the new login may still fail."}
                  </p>
                  {accountAction.error && (
                    <p role="alert" className="text-ink-blocked-2">
                      {accountAction.error.message}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={accountAction.isPending}
                      onClick={() =>
                        accountAction.mutate({ accountKey: a.key, action: confirmAction.action })
                      }
                      {...readOnly}
                    >
                      {accountAction.isPending
                        ? "Working…"
                        : confirmAction.action === "remove"
                          ? "Remove connection, keep messages"
                          : "Disconnect and reconnect"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={accountAction.isPending}
                      onClick={() => setConfirmAction(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
              {(a.backfill || diagnostics.length > 0 || a.lastCheckedAt) && (
                <details className="replies-sync-details">
                  <summary>Connection & import details</summary>
                  {a.lastCheckedAt && <p>Last history check {timeAgo(a.lastCheckedAt)}.</p>}
                  {diagnostics.map((message) => (
                    <p key={message} className="break-words">
                      {message}
                    </p>
                  ))}
                  {a.backfill && (
                    <>
                      {a.backfill.senders && (
                        <p>
                          {a.backfill.senders.resolved} of {a.backfill.senders.total} profiles
                          checked. Profile checks are one part of the history import.
                        </p>
                      )}
                      <div className="replies-import-table">
                        <table>
                          <caption className="sr-only">History import results by workspace</caption>
                          <thead>
                            <tr>
                              <th>Workspace</th>
                              <th>Messages</th>
                              <th>Matched replies</th>
                              <th>Unresolved</th>
                              <th>No prospect</th>
                              <th>Cadences stopped</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(a.backfill.counts).map(([workspace, c]) => (
                              <tr key={workspace}>
                                <th scope="row">{workspace}</th>
                                <td>{c.imported}</td>
                                <td>{c.matched}</td>
                                <td>{c.unresolved}</td>
                                <td>{c.noProspect}</td>
                                <td>{c.stoppedCadences}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {!!a.backfill.senders?.failed && (
                        <p>
                          {a.backfill.senders.failed} profiles were unavailable. Their messages
                          remain unresolved; these lookups will not be retried.
                        </p>
                      )}
                      {a.backfill.providerLimit && (
                        <p>
                          Daily allowance: {a.backfill.providerLimit.limit} profile lookups.
                          Requests are paced by the provider.
                        </p>
                      )}
                      <p>Import stage: {a.backfill.stage}</p>
                      {a.backfill.pending?.requestId && (
                        <p className="break-all">Request: {a.backfill.pending.requestId}</p>
                      )}
                    </>
                  )}
                </details>
              )}
            </div>
          );
        })}
        <div className="replies-connection-footer">
          {accounts.length ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={connect.isPending || accountAction.isPending || !!intent}
              onClick={() => connect.mutate(undefined)}
              {...readOnly}
            >
              {connect.isPending && !connect.variables
                ? "Opening connection…"
                : "Add another account"}
            </Button>
          ) : (
            // The first connection is made on Setup, where one button also
            // opens the profile-research session; this panel manages the
            // account afterwards.
            <Link
              to="/setup"
              hash="credentials"
              className="text-[12px] text-ink-cream-2 underline underline-offset-2"
            >
              Connect LinkedIn on Setup →
            </Link>
          )}
          {connectUrl && (
            <p className="text-[12px] text-ink-muted">
              <a className="underline" href={connectUrl} target="_blank" rel="noreferrer">
                Open LinkedIn login
              </a>{" "}
              · waiting for connection{status.error ? ` · ${status.error.message}` : ""}
            </p>
          )}
          <p className="max-w-[80ch] text-[11px] text-ink-muted">
            Imports may incur charges within your wallet limits. Matched replies stop cadences
            across workspaces.
          </p>
        </div>
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
  const { bodyRef, latestRef, onScroll, scrollToLatest, newMessage } = useReplyScroll(t.messages);
  const composerRef = useRef<HTMLDivElement>(null);
  const latestMessageId = t.messages.findLast((message) => !message.deleted)?.id;
  const profileUrl = linkedinUrlFor({ linkedinUrl: t.profileUrl });
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
    <article className="replies-thread">
      <div className="replies-thread-header">
        <button
          type="button"
          className="replies-back"
          onClick={onToggle}
          aria-label="Back to conversations"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="replies-recipient">
          <h2>
            {profileUrl ? (
              <a
                className="replies-profile-link"
                href={profileUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Open LinkedIn profile in a new tab"
              >
                <Pii kind="name">{t.name}</Pii>
                <ExternalLink size={14} aria-hidden="true" />
                <span className="sr-only"> — LinkedIn profile (opens in a new tab)</span>
              </a>
            ) : (
              <Pii kind="name">{t.name}</Pii>
            )}
          </h2>
          <p>
            {t.channel === "linkedin" ? "LinkedIn" : "Email"}
            {replyCompany(t.company) && (
              <>
                {" "}
                · <Pii kind="company">{replyCompany(t.company)!}</Pii>
              </>
            )}
          </p>
        </div>
        {!t.archivedAt && (
          <Button
            size="sm"
            variant="ghost"
            disabled={state.isPending}
            onClick={() => state.mutate(t.snoozedUntil ? "unsnooze" : "snooze")}
            {...readOnly}
          >
            <Clock3 size={14} />
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
          <Archive size={14} />
          {t.archivedAt ? "Restore" : "Archive"}
        </Button>
        {newMessage && (
          <Button size="sm" variant="secondary" onClick={scrollToLatest}>
            New message
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            const body = bodyRef.current;
            const composer = composerRef.current;
            if (!body || !composer) return;
            const editor = composer.querySelector<HTMLTextAreaElement>(".reply-textarea");
            const composerTop = composer.getBoundingClientRect().top;
            const editorRect = editor?.getBoundingClientRect();
            const targetTop =
              editorRect && editorRect.bottom - composerTop > body.clientHeight - 16
                ? editorRect.top - 16
                : composerTop;
            body.scrollTop += targetTop - body.getBoundingClientRect().top;
            (editor && !editor.disabled ? editor : body).focus({ preventScroll: true });
          }}
        >
          Reply
        </Button>
      </div>
      {expanded && (
        <div
          ref={bodyRef}
          className="replies-thread-body"
          role="region"
          onScroll={onScroll}
          tabIndex={0}
          aria-label="Conversation and reply"
        >
          {t.channel === "email" && (
            <h3 className="pt-4 text-[14px] font-medium">{t.subject || "(No subject)"}</h3>
          )}
          {t.snoozedUntil && (
            <p className="pt-3 text-[12px] text-ink-muted">
              Returns {new Date(t.snoozedUntil).toLocaleString()}
            </p>
          )}
          <details className="replies-contact-details">
            <summary>Contact details & assignment</summary>
            <div className="mt-3 flex flex-wrap gap-2">
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
                  {profileUrl && (
                    <a
                      href={profileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
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
          </details>
          {assignOpen && (
            <Assignment
              thread={t}
              onDone={() => {
                setAssignOpen(false);
                void invalidate();
              }}
            />
          )}
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
          <div className="replies-messages">
            {t.messages.map((m) => (
              <div
                key={m.id}
                data-message-id={m.id}
                ref={m.id === latestMessageId ? latestRef : undefined}
                className={`replies-message ${m.direction === "outbound" ? "is-outbound" : "is-inbound"}`}
              >
                <div className="mb-1 text-[11px] text-ink-muted">
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
          <div ref={composerRef} data-reply-composer>
            <ReplyOptionsComposer key={t.key} thread={t} />
          </div>
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
