import { Sparkles } from "lucide-react";
import { lazy, Suspense, useState } from "react";

// Heavy half (assistant-ui runtime + drawer) is lazy-loaded on first open so
// @assistant-ui/react stays out of the main bundle.
const StrategistPanel = lazy(() => import("./StrategistPanel.tsx"));

/**
 * Global strategist dock: a lightweight floating launcher (always in the main
 * bundle) plus a lazily-loaded chat drawer. The panel mounts on first open and
 * then stays mounted (toggled via translate) so chat history survives
 * close/reopen — and, since the dock lives in __root, across page navigation.
 */
export function StrategistDock() {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);

  return (
    <>
      {/* Launcher — bottom-right floating button (no assistant-ui dependency) */}
      <button
        type="button"
        onClick={() => {
          setEverOpened(true);
          setOpen((v) => !v);
        }}
        aria-label={open ? "Close strategist" : "Open strategist"}
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full border border-ink-rule bg-ink-surface px-4 py-2.5 font-mono text-[11px] uppercase tracking-wider text-ink-cream shadow-lg transition-colors hover:border-ink-rule-2 hover:bg-ink-surface-2"
      >
        <Sparkles size={14} />
        Strategist
      </button>

      {everOpened && (
        <Suspense fallback={null}>
          <StrategistPanel open={open} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
