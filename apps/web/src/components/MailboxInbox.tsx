import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type {
  MailboxConnectionRequest,
  MailboxHealthView,
  MailboxThreadView,
} from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { Button } from "./primitives/Button.tsx";
import { Input } from "./primitives/Field.tsx";
import { Badge } from "./primitives/Badge.tsx";
import { timeAgo } from "../lib/cn.ts";
import { readOnly } from "../lib/readOnly.ts";
import { IS_DEMO } from "../api/demo.ts";

/** Render connection health and settings for the workspace's receiving mailboxes. */
export function MailboxConnections({ mailboxes }: { mailboxes: MailboxHealthView[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (!mailboxes.length) return null;
  return (
    <details
      className="border-b border-ink-rule/60 px-6 py-3"
      open={mailboxes.some((m) => m.status === "error")}
    >
      <summary className="cursor-pointer font-mono text-[12px] text-ink-muted">
        {mailboxes.filter((m) => m.status === "connected").length} of {mailboxes.length} receiving
        mailboxes connected
        {mailboxes.some((m) => m.backfillRemaining) ? " · importing history" : ""}
      </summary>
      <div className="mt-3 space-y-3">
        {mailboxes.map((m) => (
          <div key={m.identityId} className="text-[12px] text-ink-muted">
            <div className="flex flex-wrap items-center gap-2">
              <span>{m.address}</span>
              <Badge tone={m.status === "error" ? "blocked" : "neutral"}>{m.status}</Badge>
              <span>
                {m.lastSyncAt ? `synced ${timeAgo(m.lastSyncAt)}` : "waiting for first sync"}
              </span>
              {m.backfillRemaining && <span>history import incomplete</span>}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing(editing === m.identityId ? null : m.identityId)}
                {...readOnly}
              >
                Connection settings
              </Button>
            </div>
            {m.error && <p className="mt-1 text-[color:var(--ink-blocked-2)]">{m.error}</p>}
            {editing === m.identityId && (
              <MailboxConnectionForm mailbox={m} onDone={() => setEditing(null)} />
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

/** Collect and submit IMAP/SMTP credentials for one mailbox identity. */
function MailboxConnectionForm({
  mailbox,
  onDone,
}: {
  mailbox: MailboxHealthView;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<MailboxConnectionRequest>({
    identityId: mailbox.identityId,
    address: mailbox.address,
    imap: { host: "", port: 993, secure: true, user: mailbox.address, pass: "" },
    smtp: { host: "", port: 587, secure: false, user: mailbox.address, pass: "" },
  });
  const save = useMutation({
    mutationFn: () => api.mailboxConnect(form),
    onSuccess: () => {
      toast.success("Mailbox connected");
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <form
      className="mt-3 space-y-3 border border-ink-rule/60 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <p>
        Use an app password or the credentials supplied by your mailbox provider. Saved privately
        for this workspace.
      </p>
      {(["imap", "smtp"] as const).map((kind) => (
        <fieldset key={kind} className="grid gap-2 sm:grid-cols-2">
          <legend className="mb-2 uppercase">{kind}</legend>
          {(["host", "port", "user", "pass"] as const).map((field) => (
            <label key={field}>
              <span className="mb-1 block">
                {field === "pass" ? "App password" : field === "user" ? "Username" : field}
              </span>
              <Input
                required
                type={field === "pass" ? "password" : field === "port" ? "number" : "text"}
                autoComplete={field === "pass" ? "new-password" : "off"}
                value={form[kind][field]}
                onChange={(e) =>
                  setForm({
                    ...form,
                    [kind]: {
                      ...form[kind],
                      [field]: field === "port" ? Number(e.target.value) : e.target.value,
                    },
                  })
                }
              />
            </label>
          ))}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form[kind].secure}
              onChange={(e) =>
                setForm({ ...form, [kind]: { ...form[kind], secure: e.target.checked } })
              }
            />
            TLS from connection start (otherwise require STARTTLS)
          </label>
        </fieldset>
      ))}
      <Button type="submit" size="sm" disabled={save.isPending} {...readOnly}>
        {save.isPending ? "Checking connections…" : "Verify and connect"}
      </Button>
    </form>
  );
}

/** Render an expandable mailbox conversation with local state controls. */
export function MailboxThreadRow({
  thread: t,
  children,
}: {
  thread: MailboxThreadView;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [matchEmail, setMatchEmail] = useState("");
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["inbox"] });
  const ids = t.items.filter((i) => i.kind === "reply").map((i) => i.id);
  const state = useMutation({
    mutationFn: (change: { read?: boolean; archived?: boolean }) =>
      api.mailboxState({ threadKey: t.threadKey, observedReplyIds: ids, ...change }),
    onSuccess: invalidate,
    onError: (e: Error) => {
      toast.error(e.message);
      void invalidate();
    },
  });
  const history = useMutation({
    mutationFn: () => api.mailboxHistory(t.threadKey),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });
  const match = useMutation({
    mutationFn: () => api.mailboxMatch(t.threadKey, matchEmail),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });
  // Mark only the snapshot displayed on opening. New arrivals remain unread,
  // and explicitly marking an open thread unread does not immediately undo it.
  const opened = useRef(false);
  useEffect(() => {
    if (expanded && !opened.current && !IS_DEMO) {
      if (t.unread) state.mutate({ read: true });
      if (!t.historyComplete) history.mutate();
    }
    opened.current = expanded;
  }, [expanded, t.historyComplete, t.unread, state, history]);
  return (
    <div className="border-b border-ink-rule/60">
      <div className="flex flex-wrap items-center gap-2 pr-6">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-3 px-6 py-3 text-left hover:bg-ink-surface/60"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="min-w-0 flex-1">
            <span
              className={`block truncate text-[13px] text-ink-cream ${t.unread ? "font-semibold" : ""}`}
            >
              {t.unread ? "● " : ""}
              {t.name ?? t.email}
              {t.company ? ` · ${t.company}` : ""}
            </span>
            <span className="block truncate text-[12px] text-ink-muted">
              {t.reply.subject || "(no subject)"}
            </span>
            <span className="block font-mono text-[10px] text-ink-faint">
              {t.mailboxAddress} · {timeAgo(t.lastActivityAt)}
            </span>
          </span>
          {t.reply.bounceKind ? (
            <Badge tone="blocked">delivery failure · {t.reply.bounceKind}</Badge>
          ) : t.reply.kind !== "human" ? (
            <Badge tone={t.reply.kind === "auto" ? "neutral" : "blocked"}>
              {t.reply.kind === "unsubscribe"
                ? "opted out"
                : t.reply.kind === "auto_permanent"
                  ? "mailbox unavailable"
                  : "automatic reply"}
            </Badge>
          ) : (
            t.reply.intent && <Badge tone="neutral">{t.reply.intent}</Badge>
          )}
          {!t.prospectId && <Badge tone="neutral">no match</Badge>}
        </button>
        <Button
          size="sm"
          variant="ghost"
          disabled={state.isPending}
          {...readOnly}
          onClick={() => state.mutate({ read: t.unread })}
        >
          {t.unread ? "Mark read" : "Mark unread"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={state.isPending}
          {...readOnly}
          onClick={() => state.mutate({ archived: !t.archivedAt })}
        >
          {t.archivedAt ? "Restore" : "Archive"}
        </Button>
      </div>
      {expanded && (
        <div className="space-y-3 bg-ink-bg-deep/50 px-6 py-3">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
            <Input
              value={matchEmail}
              onChange={(e) => setMatchEmail(e.target.value)}
              placeholder="Existing prospect’s email"
              aria-label="Match to prospect email"
              className="max-w-xs"
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={!matchEmail.trim() || match.isPending}
              {...readOnly}
              onClick={() => match.mutate()}
            >
              {t.prospectId ? "Change match" : "Match prospect"}
            </Button>
          </div>
          {t.items.map((item, index) => (
            <div
              key={item.kind === "reply" ? item.id : `${item.at}:${index}`}
              className="rounded-sm border border-ink-rule/60 bg-ink-surface/20 px-3 py-2"
            >
              <div className="mb-1 font-mono text-[10px] uppercase text-ink-faint">
                {item.kind === "reply" ? t.email : "You"} · {timeAgo(item.at)}
              </div>
              <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap text-[12px] leading-relaxed text-ink-cream-2">
                {item.body || "(No text body)"}
              </pre>
            </div>
          ))}
          {!t.historyComplete && (
            <Button
              size="sm"
              variant="ghost"
              disabled={history.isPending}
              onClick={() => history.mutate()}
            >
              {history.isPending && <Loader2 size={12} className="animate-spin" />}
              {history.isPending ? "Loading full history…" : "Load more history"}
            </Button>
          )}
          {children}
        </div>
      )}
    </div>
  );
}
