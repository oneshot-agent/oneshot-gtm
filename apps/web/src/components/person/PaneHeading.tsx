import type { ReactNode } from "react";

/** The small mono heading over each part of the person pane. */
export function PaneHeading({ children, right }: { children: string; right?: ReactNode }) {
  return (
    <div className="mb-1 flex items-center justify-between gap-3">
      <h4 className="m-0 font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-ink-faint">
        {children}
      </h4>
      {right}
    </div>
  );
}
