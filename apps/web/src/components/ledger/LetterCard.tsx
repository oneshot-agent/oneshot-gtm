import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { heldSummary } from "../../lib/flagLabels.ts";
import { Badge } from "../primitives/Badge.tsx";
import { ReceiptEdge } from "../primitives/ReceiptEdge.tsx";
import { SheetHeading } from "./SheetHeading.tsx";

/**
 * The letter: the right half of an open row. Subject as the only heading,
 * the state in words under it, the body in prose, actions on the foot. The
 * foot is the total line — receipt green under a letter that can be sent
 * right now — and the card ends in the receipt's torn edge. Presentational:
 * the page owns every mutation and hands in the buttons.
 */
export function LetterCard({
  meta,
  subject,
  stateLine,
  body,
  afterBody,
  foot,
  sendable = false,
}: {
  /** Right end of the heading: "drafted 6d ago · preview, not sent". */
  meta?: ReactNode;
  subject: string;
  /** Under the subject: a `DraftStateLine`, or anything in its voice. */
  stateLine?: ReactNode;
  body: string;
  /** Under the body, inside the card (an editor that opens on demand). */
  afterBody?: ReactNode;
  foot?: { left?: ReactNode; right?: ReactNode } | null;
  /** Paints the foot rule receipt green: the founder can send this now. */
  sendable?: boolean;
}) {
  return (
    <div className="min-w-0">
      <SheetHeading label="the letter" right={meta} />
      <div className="rounded-t-[var(--radius-sm)] border border-b-0 border-ink-rule bg-ink-bg-deep">
        <div className="px-5 pt-4">
          <div className="text-[13px] font-medium leading-5 text-ink-cream">{subject}</div>
          {stateLine ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] leading-4">
              {stateLine}
            </div>
          ) : null}
          <div className="my-3 h-px bg-ink-rule" />
          <pre className="ln-prose m-0 max-h-[420px] overflow-auto whitespace-pre-wrap text-[13px] text-ink-cream-2">
            {body}
          </pre>
          {afterBody}
        </div>
        {foot ? (
          <div
            className={cn(
              "mx-5 mt-5 flex flex-wrap items-center justify-between gap-3 border-t py-3",
              sendable ? "border-[color:var(--ink-receipt)]" : "border-ink-rule",
            )}
          >
            <span className="flex items-center gap-2">{foot.left}</span>
            <span className="flex flex-wrap items-center gap-3">{foot.right}</span>
          </div>
        ) : (
          <div className="pb-4" />
        )}
      </div>
      <ReceiptEdge />
    </div>
  );
}

/** The dashed bar that stands in for a letter that does not exist yet. */
export function LetterEmpty({
  note,
  actions,
  below,
  heading = true,
}: {
  note: string;
  actions?: ReactNode;
  /** Under the bar (an editor that opens on demand). */
  below?: ReactNode;
  heading?: boolean;
}) {
  return (
    <div className="min-w-0">
      {heading ? <SheetHeading label="the letter" /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-dashed border-ink-rule px-5 py-3.5">
        <span className="text-[12px] text-ink-muted">{note}</span>
        {actions ? <span className="flex flex-wrap items-center gap-2">{actions}</span> : null}
      </div>
      {below}
    </div>
  );
}

/**
 * A draft's state in words: sent; held, with the flags named and what to do
 * about them; or clean. `children` follow on the same line — receipt links,
 * an Explain, a stale-draft badge.
 */
export function DraftStateLine({
  sent,
  flags,
  dryRun = true,
  children,
}: {
  sent: boolean;
  flags: string[];
  dryRun?: boolean;
  children?: ReactNode;
}) {
  const held = sent ? null : heldSummary(flags);
  return (
    <>
      {sent ? (
        <Badge tone="receipt">sent</Badge>
      ) : held ? (
        <>
          <Badge tone={held.kind === "lint" ? "blocked" : "spend"}>held · {held.kind}</Badge>
          <span className={held.kind === "lint" ? "text-ink-blocked-2" : "text-ink-spend-2"}>
            {held.text}
          </span>
          <span className="text-ink-muted">· {held.next}</span>
        </>
      ) : (
        <span className="text-ink-muted">{dryRun ? "preview" : "drafted"} · no flags</span>
      )}
      {children}
    </>
  );
}
