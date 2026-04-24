import { cn } from "../../lib/cn.ts";

/**
 * A compact dot progress indicator — one dot per cadence step, filled
 * for completed and outlined for pending. Used in the cadences table
 * to show how far along a given prospect is in their sequence.
 *
 *   ● ● ○ ○     step 2 of 4
 */
export function StepProgress({
  current,
  total,
  tone = "neutral",
  className,
}: {
  current: number;
  total: number;
  tone?: "neutral" | "receipt" | "signal" | "spend" | "blocked";
  className?: string;
}) {
  if (total <= 0) {
    return <span className={cn("font-mono text-[11px] text-ink-faint", className)}>—</span>;
  }
  const dots = Array.from({ length: total }, (_, i) => i < current);
  const toneVar: Record<string, string> = {
    neutral: "var(--ink-cream-2)",
    receipt: "var(--ink-receipt)",
    signal: "var(--ink-signal)",
    spend: "var(--ink-spend)",
    blocked: "var(--ink-blocked)",
  };
  const fill = toneVar[tone] ?? "var(--ink-cream-2)";

  return (
    <span
      className={cn("inline-flex items-center gap-1", className)}
      aria-label={`step ${current} of ${total}`}
      title={`step ${current} of ${total}`}
    >
      {dots.map((done, i) => (
        <span
          // Position IS the identity for a fixed-length progress bar — there
          // is no other unique data per dot. Index keys are correct here.
          // oxlint-disable-next-line react/no-array-index-key
          key={i}
          aria-hidden="true"
          className={cn("h-[6px] w-[6px] rounded-full")}
          style={{
            background: done ? fill : "transparent",
            border: done ? "none" : "1px solid var(--ink-rule)",
          }}
        />
      ))}
    </span>
  );
}
