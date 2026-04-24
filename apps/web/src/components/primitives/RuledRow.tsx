import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

type Tone = "neutral" | "receipt" | "spend" | "blocked" | "signal";

/**
 * The ledger row — a ruled line with a left colour gutter, primary
 * content (left + centre), and optional trailing meta. Hover lifts
 * the surface a half-step; selection darkens the gutter and sets a
 * cream left-edge underline.
 */
export function RuledRow({
  tone = "neutral",
  selected,
  onClick,
  className,
  children,
  leading,
  trailing,
  hoverable = true,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  tone?: Tone;
  selected?: boolean;
  onClick?: () => void;
  leading?: ReactNode;
  trailing?: ReactNode;
  hoverable?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "ln-row",
        onClick ? "cursor-pointer" : "",
        hoverable && "hover:bg-ink-surface-2",
        selected && "bg-ink-surface-2",
        "transition-colors duration-[var(--dur-stamp)]",
        className,
      )}
      data-tone={tone}
      onClick={onClick}
      {...rest}
    >
      {leading && <div className="flex shrink-0 items-center">{leading}</div>}
      <div className="flex-1 min-w-0 flex items-center gap-3">{children}</div>
      {trailing && (
        <div className="flex shrink-0 items-center gap-2 text-[12px] text-ink-muted ln-mono">
          {trailing}
        </div>
      )}
    </div>
  );
}
