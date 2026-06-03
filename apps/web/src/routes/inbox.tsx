import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { InboxReplyView } from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { Badge } from "../components/primitives/Badge.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { EmptyNote } from "../components/primitives/EmptyNote.tsx";
import { SkeletonRow } from "../components/primitives/Skeleton.tsx";
import { cn, timeAgo } from "../lib/cn.ts";

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
  const inbox = useQuery({
    queryKey: ["inbox"],
    queryFn: () => api.inbox(),
    refetchInterval: 60_000,
  });

  const replies = inbox.data?.replies ?? [];
  const error = inbox.data?.error;

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
            {inbox.data ? `${replies.length} repl${replies.length === 1 ? "y" : "ies"}` : "…"}
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
          Replies arrive in your OneShot mailbox. The cadence engine reads them to stop a sequence
          on reply — to respond, use your own email client.
        </div>
      </section>

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
      ) : (
        <div>
          {replies.map((r, i) => (
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
            <span className="truncate text-[13px] text-ink-cream">{who}</span>
            {company ? (
              <span className="truncate font-mono text-[11px] text-ink-faint">· {company}</span>
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
          <div className="mb-2 font-mono text-[11px] text-ink-faint">from {reply.fromRaw}</div>
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-[1.6] text-ink-cream-2">
            {reply.body || "(no body)"}
          </pre>
        </div>
      )}
    </>
  );
}
