import { cn } from "../../lib/cn.ts";

export interface CadenceStep {
  /** Day offset from enrollment (0 = first send). */
  day: number;
  label: string;
  /** When true, this is the final "breakup" touch — dot is amber, not cobalt. */
  breakup?: boolean;
}

/**
 * A small horizontal timeline of cadence steps — day-0 send on the left,
 * follow-ups walking right, breakup amber. When there's only one step the
 * timeline reads "one-touch · no follow-ups".
 */
export function CadenceTimeline({
  steps,
  className,
}: {
  steps: CadenceStep[];
  className?: string;
}) {
  if (steps.length === 0) {
    return <div className={cn("ln-note text-[11.5px] text-ink-faint", className)}>no cadence</div>;
  }
  if (steps.length === 1) {
    return (
      <div className={cn("flex items-center gap-2 text-[11.5px] text-ink-faint", className)}>
        <span className="h-[6px] w-[6px] rounded-full bg-[color:var(--ink-signal)]" />
        <span className="font-mono">one-touch · day 0</span>
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-0 overflow-hidden", className)}>
      {steps.map((s, i) => {
        const isLast = i === steps.length - 1;
        return (
          <span key={`${s.day}-${s.label}`} className="flex min-w-0 items-center">
            <span className="flex flex-col items-center gap-0.5">
              <span
                aria-hidden="true"
                className={cn(
                  "h-[6px] w-[6px] rounded-full",
                  s.breakup
                    ? "bg-[color:var(--ink-spend)]"
                    : i === 0
                      ? "bg-[color:var(--ink-signal)]"
                      : "bg-[color:var(--ink-signal)]/60",
                )}
              />
              <span className="whitespace-nowrap font-mono text-[10px] text-ink-faint">
                d{s.day}
              </span>
              <span className="whitespace-nowrap text-[10px] text-ink-muted">{s.label}</span>
            </span>
            {!isLast && (
              <span
                aria-hidden="true"
                className={cn("mx-2 mb-[14px] h-px w-6 shrink-0", "bg-ink-rule")}
              />
            )}
          </span>
        );
      })}
    </div>
  );
}
