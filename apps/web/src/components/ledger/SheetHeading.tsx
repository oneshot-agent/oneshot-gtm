import type { ReactNode } from "react";

/** The eyebrow + hairline that opens each half of an open row's sheet. */
export function SheetHeading({ label, right }: { label: string; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-3">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        {label}
      </span>
      <span className="h-px flex-1 bg-ink-rule" />
      {right ? <span className="font-mono text-[11px] text-ink-muted">{right}</span> : null}
    </div>
  );
}
