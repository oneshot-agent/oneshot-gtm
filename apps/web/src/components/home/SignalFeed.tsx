import { Link } from "@tanstack/react-router";
import { ArrowRight, Inbox, Receipt } from "lucide-react";
import type { QueueRowView, ReceiptView } from "@oneshot-gtm/shared-types";
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
  limit = 10,
}: {
  receipts: ReceiptView[];
  queue: QueueRowView[];
  loading: boolean;
  limit?: number;
}) {
  const { masked } = usePrivacy();
  const events = merge(receipts, queue, limit, masked);

  return (
    <section className="flex flex-col border-b border-ink-rule">
      <div className="flex items-baseline justify-between px-6 pb-2 pt-5">
        <div className="ln-eyebrow">Signal feed</div>
        <div className="font-mono text-[11px] text-ink-faint">newest first · refresh · 30s</div>
      </div>
      {loading ? (
        <div className="px-6 pb-5 font-mono text-[11.5px] text-ink-faint">…</div>
      ) : events.length === 0 ? (
        <div className="px-6 pb-5">
          <p className="ln-note max-w-[56ch] text-[13.5px] text-ink-cream-2">
            Nothing on the wire yet. Send a play or run a trigger — events stream in here as they
            happen.
          </p>
        </div>
      ) : (
        <ol className="flex flex-col">
          {events.map((e) => (
            <FeedLine key={e.id} event={e} />
          ))}
        </ol>
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
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate text-ink-cream">{event.headline}</span>
        <span className="truncate font-mono text-[11.5px] text-ink-faint">· {event.meta}</span>
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
