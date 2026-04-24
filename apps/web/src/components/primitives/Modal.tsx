import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Button } from "./Button.tsx";
import { cn } from "../../lib/cn.ts";

/**
 * Ledger modal. No blur, no drop of fake depth — just the page darkened
 * and the modal card stamped on top with walnut rules. Escape closes;
 * click outside closes; focus trapped to the card while open.
 */
export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = 560,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className={cn(
        "fixed inset-0 z-50 grid place-items-center p-4",
        "bg-[color:var(--ink-bg)]/80",
      )}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={cn(
          "relative max-h-[84vh] overflow-hidden",
          "rounded-[var(--radius-lg)] border border-ink-rule bg-ink-surface",
          "shadow-[var(--shadow-ink-bleed)]",
        )}
        style={{ width: `min(${width}px, 92vw)` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-ink-rule px-5 py-3.5">
          <div className="min-w-0">
            <div
              className="truncate text-ink-cream"
              style={{
                fontFamily: "var(--font-display)",
                fontSize: 19,
                letterSpacing: "-0.01em",
              }}
            >
              {title}
            </div>
            {subtitle && (
              <div className="mt-0.5 font-mono text-[11.5px] text-ink-muted">{subtitle}</div>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1.5"
          >
            <X size={14} />
          </Button>
        </div>
        <div className="max-h-[64vh] overflow-y-auto p-5">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-ink-rule bg-ink-bg/40 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
