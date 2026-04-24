import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { Sparkline } from "./Sparkline.tsx";
import { SkeletonNumber } from "./Skeleton.tsx";

/**
 * The founder's hero number. Huge Fraunces numeral + a tight caption
 * underneath + an optional sparkline at the right edge. Loading renders
 * a size-matched skeleton so the layout doesn't shift when data lands.
 */
export function MetricTile({
  label,
  value,
  caption,
  tone = "neutral",
  trend,
  scale = "xl",
  loading,
  className,
  suffix,
  prefix,
}: {
  label: string;
  value: ReactNode;
  caption?: ReactNode;
  tone?: "neutral" | "receipt" | "spend" | "blocked" | "signal";
  trend?: number[];
  scale?: "sm" | "md" | "lg" | "xl";
  loading?: boolean;
  className?: string;
  suffix?: string;
  prefix?: string;
}) {
  const valueFontSize = SCALE[scale].number;
  const accent = TONE_COLOR[tone];

  return (
    <div
      className={cn(
        "relative overflow-hidden",
        "rounded-[var(--radius-lg)] border border-ink-rule bg-ink-surface",
        "shadow-[var(--shadow-inset)]",
        "p-5",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="ln-eyebrow">{label}</div>

          <div className="mt-2 flex items-baseline gap-1 text-ink-cream ln-numeral">
            {prefix && (
              <span className="text-ink-muted" style={{ fontSize: valueFontSize * 0.5 }}>
                {prefix}
              </span>
            )}
            {loading ? (
              <SkeletonNumber />
            ) : (
              <span style={{ fontSize: valueFontSize, lineHeight: 0.96 }}>{value}</span>
            )}
            {suffix && (
              <span className="text-ink-muted ln-mono" style={{ fontSize: valueFontSize * 0.28 }}>
                {suffix}
              </span>
            )}
          </div>

          {caption && <div className="mt-2 text-[12px] text-ink-muted ln-mono">{caption}</div>}
        </div>

        {trend && trend.length > 1 && (
          <Sparkline
            values={trend}
            tone={tone === "neutral" ? "muted" : tone}
            width={88}
            height={32}
            className="mt-1 shrink-0"
            aria-label={`${label} trend`}
          />
        )}
      </div>

      {/* subtle tone accent on the left edge */}
      {tone !== "neutral" && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-[2px]"
          style={{ background: accent }}
        />
      )}
    </div>
  );
}

const SCALE = {
  sm: { number: 36 },
  md: { number: 48 },
  lg: { number: 64 },
  xl: { number: 84 },
};

const TONE_COLOR: Record<string, string> = {
  neutral: "transparent",
  receipt: "var(--ink-receipt)",
  spend: "var(--ink-spend)",
  blocked: "var(--ink-blocked)",
  signal: "var(--ink-signal)",
};
