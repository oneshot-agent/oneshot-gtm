import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";

/**
 * Ledger badge. Tones map to product semantics:
 *   receipt → meeting booked / replied / delivered (patina green)
 *   spend   → $ outbound (cognac amber)
 *   blocked → bounced / rejected (oxblood)
 *   signal  → rare informational (cobalt)
 *   neutral → everything else
 */
const badgeStyles = cva(
  [
    "inline-flex items-center gap-1 rounded-[var(--radius-xs)]",
    "px-1.5 py-[1.5px]",
    "font-sans text-[10.5px] font-medium",
    "tracking-[0.02em] uppercase",
    "ring-1 ring-inset",
    "whitespace-nowrap",
  ].join(" "),
  {
    variants: {
      tone: {
        neutral: "bg-ink-surface-2 text-ink-cream-2 ring-ink-rule",
        receipt:
          "bg-[color:var(--ink-receipt)]/10 text-[color:var(--ink-receipt-2)] ring-[color:var(--ink-receipt)]/30",
        spend:
          "bg-[color:var(--ink-spend)]/10 text-[color:var(--ink-spend-2)] ring-[color:var(--ink-spend)]/30",
        blocked:
          "bg-[color:var(--ink-blocked)]/10 text-[color:var(--ink-blocked-2)] ring-[color:var(--ink-blocked)]/30",
        signal:
          "bg-[color:var(--ink-signal)]/10 text-[color:var(--ink-signal-2)] ring-[color:var(--ink-signal)]/30",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeStyles> {}

export function Badge({ className, tone, ...rest }: BadgeProps) {
  return <span className={cn(badgeStyles({ tone }), className)} {...rest} />;
}
