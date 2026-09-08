import { Link } from "@tanstack/react-router";
import { ArrowRight, ChevronDown, ChevronUp, Inbox, Receipt } from "lucide-react";
import type { QueueRowView, ReceiptView } from "@oneshot-gtm/shared-types";
import { useId, useState } from "react";
import { cn, timeAgo } from "../../lib/cn.ts";
import { applyMask } from "../../lib/mask.ts";
import { usePrivacy } from "../../lib/privacy.tsx";

/**
 * A reverse-chron signal feed — the "what's happening right now" list
 * the founder checks first thing in the morning. Merges two event
 * streams (receipts + queue rows) into one ruled timeline.
 *
 *   ● signed receipt   — something was sent, spent, or searched
 *   ◉ queued candidate — a trigger or finder landed a new target
 *
 * Each event links to its canonical source (receipt id / queue row) so
 * you can drill down. Pure client-side — no new API.
 */

interface FeedEvent {
  id: string;
  kind: "receipt" | "queue";
  at: string; // iso
  headline: string;
  meta: string;
  href?: string;
}

export function SignalFeed({
  receipts,
  queue,
  loading,
  error = false,
  limit = 10,
}: {
  receipts: ReceiptView[];
  queue: QueueRowView[];
  loading: boolean;
  error?: boolean;
  limit?: number;
}) {
  const { masked } = usePrivacy();
  const events = merge(receipts, queue, limit, masked);
  const [expanded, setExpanded] = useState(false);
  const feedId = useId();
  const visible = expanded ? events : events.slice(0, 3);

  return (
    <section className="flex flex-col border-b border-ink-rule">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-6 pb-3 pt-4">
        <h2 className="ln-eyebrow">Recent activity</h2>
        <div className="flex items-center gap-4 font-mono text-[11px] text-ink-muted">
          <Link
            to="/receipts"
            className="inline-flex min-h-8 items-center gap-1 hover:text-ink-cream"
          >
            Receipts <ArrowRight size={10} />
          </Link>
          <Link to="/queue" className="inline-flex min-h-8 items-center gap-1 hover:text-ink-cream">
            Review queue <ArrowRight size={10} />
          </Link>
        </div>
      </div>
      {error && (
        <p role="status" className="px-6 pb-3 text-[12px] text-ink-spend-2">
          Some activity couldn’t be refreshed. Showing available items; retrying automatically.
        </p>
      )}
      {loading ? (
        <div className="px-6 pb-5 font-mono text-[11.5px] text-ink-faint">…</div>
      ) : events.length === 0 && !error ? (
        <div className="px-6 pb-5">
          <p className="ln-note max-w-[56ch] text-[13.5px] text-ink-cream-2">
            No activity yet. Run a play to find your first prospects.
          </p>
        </div>
      ) : (
        <ol id={feedId} className="flex flex-col">
          {visible.map((e) => (
            <FeedLine key={e.id} event={e} />
          ))}
        </ol>
      )}
      {!loading && events.length > 3 && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={feedId}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-h-11 items-center gap-2 border-t border-ink-rule/60 px-6 py-3 text-left font-mono text-[11px] text-ink-muted hover:bg-ink-surface/60 hover:text-ink-cream focus-visible:outline-2 focus-visible:outline-ink-receipt"
        >
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {expanded ? "Show less" : `Show more · ${events.length - 3} more`}
        </button>
      )}
    </section>
  );
}

function FeedLine({ event }: { event: FeedEvent }) {
  const Icon = event.kind === "receipt" ? Receipt : Inbox;
  const tone =
    event.kind === "receipt"
      ? "text-[color:var(--ink-receipt-2)]"
      : "text-[color:var(--ink-signal-2)]";
  const body = (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex h-[18px] w-[18px] items-center justify-center",
          "rounded-[var(--radius-xs)] border border-ink-rule bg-ink-bg-deep shrink-0",
          tone,
        )}
      >
        <Icon size={10} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
        <span className="max-w-full truncate text-[13px] text-ink-cream">{event.headline}</span>
        <span className="max-w-full truncate font-mono text-[11px] text-ink-muted">
          · {event.meta}
        </span>
      </span>
      <time className="shrink-0 font-mono text-[11.5px] text-ink-muted" dateTime={event.at}>
        {timeAgo(event.at)}
      </time>
      {event.href && (
        <ArrowRight
          size={11}
          className="shrink-0 text-ink-faint transition-colors group-hover:text-ink-cream-2"
        />
      )}
    </>
  );

  const classes = cn(
    "group flex items-center gap-3 border-t border-ink-rule/60 px-6 py-2",
    "transition-colors duration-[var(--dur-stamp)]",
    event.href && "hover:bg-ink-surface/60 cursor-pointer",
  );

  if (event.href) {
    return (
      <li>
        <Link to={event.href} className={cn(classes, "no-underline")}>
          {body}
        </Link>
      </li>
    );
  }
  return <li className={classes}>{body}</li>;
}

function merge(
  receipts: ReceiptView[],
  queue: QueueRowView[],
  limit: number,
  masked: boolean,
): FeedEvent[] {
  const events: FeedEvent[] = [];

  for (const r of receipts) {
    events.push({
      id: `r-${r.id}`,
      kind: "receipt",
      at: r.createdAt,
      headline: `${r.playName} · ${r.callType}`,
      meta: r.costUsd != null ? `$${r.costUsd.toFixed(2)}` : "no cost on record",
      href: "/receipts",
    });
  }

  for (const q of queue) {
    const email = extractEmail(q.payload);
    const shownEmail = email ? applyMask(masked, "email", email) : "(no email)";
    events.push({
      id: `q-${q.id}`,
      kind: "queue",
      at: q.foundAt,
      headline: `${q.playName} · ${shownEmail}`,
      meta: `from ${q.source}`,
      href: "/queue",
    });
  }

  events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return events.slice(0, limit);
}

function extractEmail(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const email = p["email"] ?? p["founderEmail"];
  return typeof email === "string" ? email : null;
}
