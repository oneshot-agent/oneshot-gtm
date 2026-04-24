import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";

/**
 * Status pill — a small dot + label, used for chips like
 * "wallet: $12.40" or "ledger: warm". Quieter than a Badge;
 * meant to sit in the top status bar and inline meta rows.
 */
const pillStyles = cva(
  [
    "inline-flex items-center gap-1.5",
    "rounded-[var(--radius-sm)]",
    "px-2 py-0.5",
    "font-mono text-[11.5px]",
    "border",
  ].join(" "),
  {
    variants: {
      tone: {
        neutral: "text-ink-cream-2 border-ink-rule bg-transparent",
        receipt:
          "text-[color:var(--ink-receipt-2)] border-[color:var(--ink-receipt)]/30 bg-[color:var(--ink-receipt)]/8",
        spend:
          "text-[color:var(--ink-spend-2)] border-[color:var(--ink-spend)]/30 bg-[color:var(--ink-spend)]/8",
        blocked:
          "text-[color:var(--ink-blocked-2)] border-[color:var(--ink-blocked)]/30 bg-[color:var(--ink-blocked)]/8",
        signal:
          "text-[color:var(--ink-signal-2)] border-[color:var(--ink-signal)]/30 bg-[color:var(--ink-signal)]/8",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

const dotStyles = cva("h-[6px] w-[6px] rounded-full", {
  variants: {
    tone: {
      neutral: "bg-ink-muted",
      receipt: "bg-[color:var(--ink-receipt)]",
      spend: "bg-[color:var(--ink-spend)]",
      blocked: "bg-[color:var(--ink-blocked)]",
      signal: "bg-[color:var(--ink-signal)]",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export interface StatusPillProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof pillStyles> {
  label: string;
  value?: string | number;
}

export function StatusPill({ label, value, tone, className, ...rest }: StatusPillProps) {
  return (
    <span className={cn(pillStyles({ tone }), className)} {...rest}>
      <span className={dotStyles({ tone })} />
      <span className="text-ink-muted">{label}</span>
      {value !== undefined && <span className="text-ink-cream">{value}</span>}
    </span>
  );
}
