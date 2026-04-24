import { Check, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "./Button.tsx";
import { cn } from "../../lib/cn.ts";

/**
 * Empty state — a single founder note + optional CLI hint. No
 * illustration, no blank-state clip art; the note speaks to the
 * founder directly in Plex Sans (no italics, no serif).
 *
 * Example:
 *   <EmptyNote
 *     note="No receipts yet. One always beats zero."
 *     cli="oneshot-gtm motion show-hn"
 *   />
 */
export function EmptyNote({
  note,
  cli,
  children,
  className,
}: {
  note: ReactNode;
  cli?: string;
  children?: ReactNode;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-4 py-10 px-6",
        "border border-dashed border-ink-rule rounded-[var(--radius-lg)]",
        "bg-[color:var(--ink-surface)]/40",
        className,
      )}
    >
      <div
        className="max-w-[56ch] text-ink-cream-2"
        style={{ fontSize: 15, lineHeight: 1.55, fontWeight: 400 }}
      >
        {note}
      </div>

      {cli && (
        <div className="flex items-center gap-2">
          <code
            className={cn(
              "ln-mono text-[12.5px] text-ink-cream-2",
              "rounded-[var(--radius-sm)] border border-ink-rule bg-ink-bg-deep",
              "px-2.5 py-1.5",
            )}
          >
            $ {cli}
          </code>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(cli);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            aria-label="copy command"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            <span className="text-[11px]">{copied ? "copied" : "copy"}</span>
          </Button>
        </div>
      )}

      {children && <div className="mt-1">{children}</div>}
    </div>
  );
}
