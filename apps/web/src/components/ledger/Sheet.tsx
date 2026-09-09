import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

/**
 * The open row: a sheet under the entry that reads left to right — the case,
 * then the letter. No boxes: hierarchy comes from type and hairlines, and the
 * one accent on the page is the total line under a sendable letter.
 *
 * `indent` lines the sheet up under the identity cell: the queue has a
 * chevron and a checkbox before it, /prospects a chevron only, /cadences a
 * 32px checkbox inside `px-6`.
 */
export function Sheet({
  colSpan,
  indent,
  theCase,
  theLetter,
  className,
}: {
  colSpan: number;
  indent: "pl-16" | "pl-10" | "pl-14";
  theCase: ReactNode;
  theLetter: ReactNode;
  className?: string;
}) {
  return (
    <tr className={cn("border-b border-ink-rule/60 bg-ink-bg-deep/50", className)}>
      <td colSpan={colSpan} className={cn("py-5 pr-6", indent)}>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,8fr)] xl:gap-10">
          <div className="flex min-w-0 flex-col gap-3 text-[12px] text-ink-muted">{theCase}</div>
          <div className="min-w-0">{theLetter}</div>
        </div>
      </td>
    </tr>
  );
}

/** A hairline between blocks of the case column. */
export function Rule() {
  return <div className="mt-1 h-px bg-ink-rule" />;
}
