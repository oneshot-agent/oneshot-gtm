import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";

/**
 * Ledger card — warm surface, walnut hairline, a whisper of inset light.
 * No blur, no saturated colour. Cards are the page; chrome stays quiet.
 */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-lg)]",
        "bg-ink-surface text-ink-cream",
        "border border-ink-rule",
        "shadow-[var(--shadow-inset)]",
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "border-b border-ink-rule px-5 py-3",
        "flex items-center justify-between",
        "font-sans text-[13px] font-medium text-ink-cream-2",
        className,
      )}
      {...rest}
    />
  );
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5", className)} {...rest} />;
}

/**
 * Section header used above ungrouped content (eyebrow + optional meta).
 * Think: the little heading above a numbered entry in a bound ledger.
 */
export function SectionEyebrow({
  className,
  children,
  meta,
}: {
  className?: string;
  children: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3 py-2", className)}>
      <div className="ln-eyebrow">{children}</div>
      {meta && <div className="text-[11px] text-ink-faint ln-mono">{meta}</div>}
    </div>
  );
}
