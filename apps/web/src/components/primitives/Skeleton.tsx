import { cn } from "../../lib/cn.ts";

/**
 * Content-shaped skeleton. No shimmer — a quiet walnut wash that matches
 * the final text length. The goal is zero layout shift on data arrival:
 * pass the expected `lines` count and character width so the placeholder
 * holds the space precisely.
 */
export function Skeleton({
  className,
  lines = 1,
  widths,
  rounded = true,
}: {
  className?: string;
  lines?: number;
  /** Per-line width as a CSS value (e.g. "70%"). Falls back to a varied default. */
  widths?: string[];
  rounded?: boolean;
}) {
  const rows = Array.from({ length: lines }, (_, i) => {
    const w = widths?.[i] ?? defaultWidth(i, lines);
    return (
      <span
        key={i}
        className={cn(
          "block h-[10px]",
          rounded ? "rounded-[2px]" : "",
          "bg-[color:var(--ink-rule)]/60",
        )}
        style={{ width: w, marginTop: i === 0 ? 0 : 8 }}
      />
    );
  });
  return (
    <span className={cn("inline-flex w-full flex-col", className)} aria-hidden="true" data-skeleton>
      {rows}
    </span>
  );
}

function defaultWidth(i: number, n: number): string {
  if (n === 1) return "72%";
  if (i === n - 1) return "48%";
  return i % 2 === 0 ? "92%" : "80%";
}

/** Skeleton shaped like a large display numeral. */
export function SkeletonNumber({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block h-[72px] w-[120px] rounded-[var(--radius-sm)] bg-[color:var(--ink-rule)]/55",
        className,
      )}
    />
  );
}

/** A row-shaped skeleton for ruled lists. */
export function SkeletonRow({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("flex items-center gap-3 border-b border-ink-rule px-3 py-2.5", className)}
    >
      <span className="h-[10px] w-[120px] rounded-[2px] bg-[color:var(--ink-rule)]/60" />
      <span className="h-[10px] flex-1 rounded-[2px] bg-[color:var(--ink-rule)]/45" />
      <span className="h-[10px] w-[60px] rounded-[2px] bg-[color:var(--ink-rule)]/40" />
    </div>
  );
}
