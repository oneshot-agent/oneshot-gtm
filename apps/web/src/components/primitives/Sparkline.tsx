import { useId, useMemo } from "react";
import { cn } from "../../lib/cn.ts";

interface SparklineProps {
  /** Values in chronological order. First is oldest, last is newest. */
  values: number[];
  width?: number;
  height?: number;
  /** Stroke colour (CSS colour). Defaults to the receipt tone. */
  tone?: "receipt" | "spend" | "blocked" | "signal" | "muted";
  /** Animate the stroke drawing in on mount. */
  animateIn?: boolean;
  /** Draw a subtle area fill under the line. */
  fill?: boolean;
  /** Show a filled dot at the last point (current reading). */
  tip?: boolean;
  className?: string;
  "aria-label"?: string;
}

const TONE_VAR: Record<NonNullable<SparklineProps["tone"]>, string> = {
  receipt: "var(--ink-receipt)",
  spend: "var(--ink-spend)",
  blocked: "var(--ink-blocked)",
  signal: "var(--ink-signal)",
  muted: "var(--ink-muted)",
};

/**
 * A tiny SVG sparkline. No chart library — just a smooth polyline over
 * the values you give it, optionally with a faint fill and a tip dot.
 * The line draws in like an EKG on mount when `animateIn` is true.
 */
export function Sparkline({
  values,
  width = 120,
  height = 28,
  tone = "receipt",
  animateIn = true,
  fill = true,
  tip = true,
  className,
  "aria-label": ariaLabel,
}: SparklineProps) {
  const id = useId();
  const colour = TONE_VAR[tone];

  const { path, area, tipX, tipY, length } = useMemo(
    () => buildPath(values, width, height),
    [values, width, height],
  );

  if (values.length === 0) {
    return (
      <svg
        width={width}
        height={height}
        className={cn("block", className)}
        role="img"
        aria-label={ariaLabel ?? "no data"}
      />
    );
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("block", className)}
      role="img"
      aria-label={ariaLabel ?? "sparkline"}
    >
      {fill && (
        <defs>
          <linearGradient id={`${id}-g`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colour} stopOpacity="0.28" />
            <stop offset="100%" stopColor={colour} stopOpacity="0" />
          </linearGradient>
        </defs>
      )}
      {fill && <path d={area} fill={`url(#${id}-g)`} />}
      <path
        d={path}
        fill="none"
        stroke={colour}
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={
          animateIn
            ? ({
                strokeDasharray: length,
                strokeDashoffset: length,
                animation: "ln-draw 600ms var(--ease-reveal) forwards",
                ["--ln-dash-length" as string]: `${length}`,
              } as React.CSSProperties)
            : undefined
        }
      />
      {tip && (
        <circle
          cx={tipX}
          cy={tipY}
          r={1.8}
          fill={colour}
          style={
            animateIn
              ? ({
                  opacity: 0,
                  animation: "ln-settle 280ms var(--ease-reveal) 500ms forwards",
                } as React.CSSProperties)
              : undefined
          }
        />
      )}
    </svg>
  );
}

function buildPath(values: number[], width: number, height: number) {
  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const n = values.length;
  const step = n > 1 ? w / (n - 1) : 0;

  const pts = values.map((v, i) => {
    const x = pad + i * step;
    const y = pad + (1 - (v - min) / range) * h;
    return [x, y] as const;
  });

  const path = pts
    .map(([x, y], i) =>
      i === 0 ? `M${x.toFixed(2)},${y.toFixed(2)}` : `L${x.toFixed(2)},${y.toFixed(2)}`,
    )
    .join(" ");
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const area = `${path} L${last[0].toFixed(2)},${(height - pad).toFixed(2)} L${first[0].toFixed(2)},${(
    height - pad
  ).toFixed(2)} Z`;

  // Approximate polyline length for stroke-dasharray drawing animation.
  let length = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i]![0] - pts[i - 1]![0];
    const dy = pts[i]![1] - pts[i - 1]![1];
    length += Math.sqrt(dx * dx + dy * dy);
  }
  length = Math.max(length, 1);

  return { path, area, tipX: last[0], tipY: last[1], length };
}
