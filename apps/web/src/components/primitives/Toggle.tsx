import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";

/**
 * A pill toggle — the ledger's on/off affordance.
 *
 *   on   → signal-cobalt fill, cream thumb flush right
 *   off  → walnut fill, muted thumb flush left
 *
 * Built on <button role="switch"> for accessibility. Focus-visible ring
 * is the standard cobalt focus ring. Size is compact (28×16) so it fits
 * in a row without dominating it.
 */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
  size = "md",
  className,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "type"> & {
  checked: boolean;
  onChange?: (next: boolean) => void;
  label?: string;
  size?: "sm" | "md";
}) {
  const dims =
    size === "sm" ? { w: 24, h: 14, dot: 10, inset: 2 } : { w: 28, h: 16, dot: 12, inset: 2 };
  const dotX = checked ? dims.w - dims.dot - dims.inset : dims.inset;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange?.(!checked)}
      className={cn(
        "relative inline-flex shrink-0 items-center",
        "rounded-full border transition-[background,border-color,box-shadow]",
        "duration-[var(--dur-stamp)] ease-[var(--ease-standard)]",
        "focus-visible:outline-none",
        "disabled:opacity-40 disabled:cursor-not-allowed",
        checked
          ? "border-[color:var(--ink-signal)]/45 bg-[color:var(--ink-signal)]/35"
          : "border-ink-rule bg-ink-bg-deep hover:border-ink-rule-2",
        className,
      )}
      style={{ width: dims.w, height: dims.h }}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute rounded-full",
          "transition-[transform,background,box-shadow]",
          "duration-[var(--dur-stamp)] ease-[var(--ease-standard)]",
          checked
            ? "bg-[color:var(--ink-signal-2)] shadow-[0_0_0_1px_color-mix(in_oklch,var(--ink-signal)_40%,transparent)]"
            : "bg-[color:var(--ink-muted)]",
        )}
        style={{
          width: dims.dot,
          height: dims.dot,
          transform: `translateX(${dotX}px)`,
          top: (dims.h - dims.dot) / 2,
          left: 0,
        }}
      />
    </button>
  );
}
