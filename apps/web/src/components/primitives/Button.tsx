import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";

/**
 * Ledger Button.
 *
 *   primary   — stamped cream button (the only cream button on a page).
 *   secondary — surface with walnut rule.
 *   ghost     — unadorned; hover darkens only.
 *   danger    — oxblood outline, never a filled red.
 *   accent    — cobalt outline for rare informational actions.
 */
const buttonStyles = cva(
  [
    "relative inline-flex items-center justify-center gap-1.5",
    "font-sans font-medium",
    "rounded-[var(--radius-sm)]",
    "transition-[background,color,border-color,box-shadow,transform]",
    "duration-[var(--dur-stamp)] ease-[var(--ease-standard)]",
    "active:translate-y-[0.5px]",
    "focus-visible:outline-none",
    "disabled:cursor-not-allowed disabled:opacity-50",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: [
          "bg-ink-cream text-ink-bg",
          "hover:bg-ink-cream-2",
          "shadow-[var(--shadow-stamp)]",
        ].join(" "),
        secondary: [
          "bg-ink-surface text-ink-cream",
          "border border-ink-rule",
          "hover:bg-ink-surface-2 hover:border-ink-rule-2",
        ].join(" "),
        ghost: [
          "bg-transparent text-ink-cream-2",
          "hover:bg-ink-surface hover:text-ink-cream",
        ].join(" "),
        danger: [
          "bg-transparent text-[color:var(--ink-blocked-2)]",
          "border border-[color:var(--ink-blocked)]",
          "hover:bg-[color:var(--ink-blocked)]/12",
        ].join(" "),
        accent: [
          "bg-transparent text-[color:var(--ink-signal-2)]",
          "border border-[color:var(--ink-signal)]",
          "hover:bg-[color:var(--ink-signal)]/10",
        ].join(" "),
      },
      size: {
        sm: "h-7 px-2.5 text-[12px] tracking-[0.005em]",
        md: "h-8 px-3 text-[13px]",
        lg: "h-10 px-4 text-[14px]",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonStyles> {}

export function Button({ className, variant, size, ...rest }: ButtonProps) {
  return <button className={cn(buttonStyles({ variant, size }), className)} {...rest} />;
}
