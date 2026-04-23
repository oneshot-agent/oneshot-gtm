import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";

const badgeStyles = cva(
  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
  {
    variants: {
      tone: {
        neutral: "bg-zinc-800/60 text-zinc-300 ring-zinc-700",
        green: "bg-emerald-900/30 text-emerald-300 ring-emerald-700/40",
        yellow: "bg-amber-900/30 text-amber-300 ring-amber-700/40",
        red: "bg-red-900/30 text-red-300 ring-red-700/40",
        blue: "bg-sky-900/30 text-sky-300 ring-sky-700/40",
        purple: "bg-purple-900/30 text-purple-300 ring-purple-700/40",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeStyles> {}

export function Badge({ className, tone, ...rest }: BadgeProps) {
  return <span className={cn(badgeStyles({ tone }), className)} {...rest} />;
}
