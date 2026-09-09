import { useId } from "react";

/**
 * The torn bottom edge of a receipt — the brand mark's own tear
 * (`apps/web/public/icon.svg`), drawn as a repeating tooth so it fits any
 * width. Sits directly under a card that has no bottom border: the teeth are
 * filled with the card's surface and stroked with the same walnut rule, so
 * the edge reads as the card ending, not a decoration under it.
 */
export function ReceiptEdge({ className }: { className?: string }) {
  const id = useId();
  const patternId = `tear-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg
      width="100%"
      height="11"
      aria-hidden="true"
      className={className}
      style={{ display: "block" }}
    >
      <defs>
        <pattern id={patternId} width="16" height="11" patternUnits="userSpaceOnUse">
          <path
            d="M0 0 L8 10 L16 0"
            fill="var(--ink-bg-deep)"
            stroke="var(--ink-rule)"
            strokeWidth="1"
          />
        </pattern>
      </defs>
      <rect width="100%" height="11" fill={`url(#${patternId})`} />
    </svg>
  );
}
