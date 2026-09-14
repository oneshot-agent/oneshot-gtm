import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { SheetHeading } from "./SheetHeading.tsx";

/**
 * The open row: a sheet under the entry that reads left to right — the case,
 * then the letter. No boxes: hierarchy comes from type and hairlines, and the
 * one accent on the page is the total line under a sendable letter.
 *
 * All ledger tables reserve 64px before the identity. The expanded sheet
 * shares that gutter and column split across Queue, Prospects and Cadences.
 */
export function Sheet({
  colSpan,
  theCase,
  theLetter,
  className,
}: {
  colSpan: number;
  theCase: ReactNode;
  theLetter: ReactNode;
  className?: string;
}) {
  return (
    <tr className={cn("border-b border-ink-rule/60 bg-ink-bg-deep/50", className)}>
      <td colSpan={colSpan} className="py-5 pl-16 pr-6">
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,8fr)] xl:gap-10">
          <div className="min-w-0 text-[12px] text-ink-muted">{theCase}</div>
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

/** Align case content with the subject inside the adjacent letter. */
export function CaseSection({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0">
      <SheetHeading label="the case" />
      <div className="flex flex-col gap-4 pt-[17px]">{children}</div>
    </div>
  );
}
