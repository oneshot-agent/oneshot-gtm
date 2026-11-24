import type { ProspectTimelineEvent } from "@oneshot-gtm/shared-types";
import { ChevronRight, Mail, MessageSquare, MessageSquareReply, Phone } from "lucide-react";
import { useState } from "react";
import { cn, timeAgo } from "../../lib/cn.ts";
import { formatDuration, outcomeTitle } from "../../lib/dialler.ts";
import { useMask, usePrivacy } from "../../lib/privacy.tsx";
import { DeliveryBadge, DeliveryWarning, deliveryWarningText } from "../queue/DeliveryWarning.tsx";

/** The channel mark on a touch; milestones (surfaced, decided, outcomes) carry none. */
function ChannelIcon({ touch }: { touch: ProspectTimelineEvent }) {
  const props = { size: 12, "aria-hidden": true, className: "shrink-0 text-ink-faint" } as const;
  if (touch.kind === "reply") return <MessageSquareReply {...props} />;
  const channel = touch.channel ?? (touch.kind === "call" ? "call" : null);
  if (channel === "email") return <Mail {...props} />;
  if (channel === "call") return <Phone {...props} />;
  if (channel === "sms") return <MessageSquare {...props} />;
  if (channel === "linkedin") {
    // Lucide carries no brand marks; the two letters read as LinkedIn at this size.
    return (
      <span
        aria-hidden="true"
        className="inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-[2px] border border-ink-faint font-mono text-[7px] font-semibold leading-none text-ink-faint"
      >
        in
      </span>
    );
  }
  return <span aria-hidden="true" className="inline-block w-3 shrink-0" />;
}

/** Whether the touch has anything to open: a body, a call or a delivery mismatch. */
function expandable(touch: ProspectTimelineEvent): boolean {
  return !!touch.body || !!touch.call || deliveryWarningText(touch.delivery) != null;
}

function CallDetail({ call }: { call: NonNullable<ProspectTimelineEvent["call"]> }) {
  const mask = useMask();
  const facts = [
    outcomeTitle(call.outcome),
    call.durationSec != null ? formatDuration(call.durationSec) : null,
    call.member ? `by ${mask("name", call.member)}` : null,
  ].filter(Boolean);
  return (
    <div className="text-[12px] leading-5 text-ink-cream-2">
      <p className="m-0 font-mono text-[11px] text-ink-muted">{facts.join(" · ")}</p>
      {call.note && (
        <p className="m-0 mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{call.note}</p>
      )}
    </div>
  );
}

function TouchRow({
  touch,
  highlightPlay,
}: {
  touch: ProspectTimelineEvent;
  highlightPlay?: string | null;
}) {
  const { masked } = usePrivacy();
  const [open, setOpen] = useState(false);
  // Bodies, notes and subjects are about the person: privacy mode keeps labels and times.
  const canOpen = !masked && expandable(touch);
  const line = (
    <>
      <span className="w-[72px] shrink-0 text-right font-mono text-[11px] text-ink-faint">
        {timeAgo(touch.at)}
      </span>
      <ChannelIcon touch={touch} />
      <span className="shrink-0 whitespace-nowrap text-ink-cream-2">{touch.label}</span>
      {touch.playName && (
        <span
          className={cn(
            "shrink-0 font-mono text-[11px]",
            highlightPlay && touch.playName === highlightPlay ? "text-ink-cream" : "text-ink-faint",
          )}
        >
          {touch.playName}
        </span>
      )}
      {touch.detail && !masked && (
        <span className="min-w-0 truncate text-ink-muted">{touch.detail}</span>
      )}
      <DeliveryBadge delivery={touch.delivery} />
      {canOpen && (
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={cn(
            "ml-auto shrink-0 text-ink-faint transition-transform",
            open && "rotate-90",
          )}
        />
      )}
    </>
  );
  const rowClass = "flex w-full min-w-0 items-center gap-2 text-left text-[12px] leading-4";
  return (
    <li className="min-w-0">
      {canOpen ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn(rowClass, "cursor-pointer hover:text-ink-cream")}
        >
          {line}
        </button>
      ) : (
        <div className={rowClass}>{line}</div>
      )}
      {canOpen && open && (
        <div className="mt-1 mb-2 flex flex-col gap-2 pl-[80px]">
          <DeliveryWarning delivery={touch.delivery} />
          {touch.call && <CallDetail call={touch.call} />}
          {touch.body ? (
            <div
              tabIndex={0}
              role="region"
              aria-label={`${touch.label} body`}
              className="max-h-48 overflow-y-auto rounded-sm border border-ink-rule p-3 text-[12px] leading-5 text-ink-cream-2 focus-visible:outline focus-visible:outline-1"
            >
              <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{touch.body}</p>
            </div>
          ) : (
            touch.kind === "sequence" &&
            !touch.call && (
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                body not captured
              </span>
            )
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Every touch on every channel, newest first, one line each. A line with a
 * body, a call or a delivery mismatch opens in place. `highlightPlay` lifts
 * the page's own play out of the rest.
 */
export function TouchTimeline({
  touches,
  highlightPlay,
}: {
  touches: ProspectTimelineEvent[];
  highlightPlay?: string | null;
}) {
  if (touches.length === 0) {
    return <p className="m-0 text-[12px] text-ink-muted">Nothing yet.</p>;
  }
  // Keyed on what the touch is, not its position, so a touch arriving or
  // another play's step landing in between keeps the open ones open. Only
  // touches equal in every field share a base, and those are interchangeable.
  const seen = new Map<string, number>();
  const keyed = touches.map((t) => {
    const base = [
      t.at,
      t.kind,
      t.channel ?? "",
      t.label,
      t.playName ?? "",
      t.detail ?? "",
      t.call?.id ?? "",
    ].join("|");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { t, key: `${base}|${n}` };
  });
  return (
    <ol className="m-0 flex list-none flex-col gap-1 p-0">
      {keyed.map(({ t, key }) => (
        <TouchRow key={key} touch={t} highlightPlay={highlightPlay} />
      ))}
    </ol>
  );
}
