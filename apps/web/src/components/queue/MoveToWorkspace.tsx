import { ArrowRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MoveTarget } from "../../lib/moveTargets.ts";
import { readOnly } from "../../lib/readOnly.ts";
import { Button } from "../primitives/Button.tsx";

/**
 * "move →" on a queue row: hand the prospect to another workspace's queue.
 * Pure: the page passes the roster (the same one the masthead switcher
 * polls), so a single-workspace install never shows the button and the row
 * fixture renders without a query client. A stopped destination is started
 * by the move route itself; the menu only says so.
 */
export function MoveToWorkspace({
  targets,
  onMove,
  disabled,
}: {
  targets: MoveTarget[];
  onMove: (workspace: string) => void;
  disabled?: boolean;
}): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (targets.length === 0) return null;
  return (
    <div ref={root} className="relative">
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Hand this prospect to another workspace's queue"
        onClick={() => setOpen((v) => !v)}
        {...readOnly}
      >
        move
        <ArrowRight size={12} />
      </Button>
      {open && (
        <ul
          role="menu"
          className="absolute right-0 z-20 mt-1 min-w-[180px] rounded border border-ink-rule bg-ink-surface py-1 text-left shadow-lg"
        >
          {targets.map((t) => (
            <li key={t.name} role="none">
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-ink-cream hover:bg-ink-bg-deep/60"
                onClick={() => {
                  setOpen(false);
                  onMove(t.name);
                }}
              >
                <span
                  aria-hidden="true"
                  className={
                    t.running
                      ? "h-[6px] w-[6px] rounded-full bg-[color:var(--ink-signal)]"
                      : "h-[6px] w-[6px] rounded-full bg-ink-muted"
                  }
                />
                <span className="font-mono">{t.name}</span>
                <span className="ml-auto text-[11px] text-ink-faint">
                  {t.running ? `:${t.port}` : "start & move"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
