import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

type Route = "/" | "/queue" | "/cadences" | "/receipts" | "/measure" | "/plays" | "/setup";

const G_PREFIX_MS = 800;

const G_TARGETS: Record<string, Route> = {
  h: "/",
  q: "/queue",
  c: "/cadences",
  r: "/receipts",
  m: "/measure",
  p: "/plays",
  s: "/setup",
};

function inEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const t = target.tagName;
  return t === "INPUT" || t === "TEXTAREA" || t === "SELECT";
}

/**
 * Global keyboard shortcuts:
 *   ⌘K / Ctrl+K   → toggle the command palette
 *   g then q      → /queue (Vim-style 2-key sequence within 800ms)
 *   g then h/c/r/m/p/s → other routes
 *   Esc           → close the palette if open (cmdk also handles this)
 *
 * The 'g' prefix is only captured when NOT typing in a form input, so
 * typing "g" in a textarea never hijacks the keystroke.
 */
export function useKeyboard(opts: {
  openPalette: () => void;
  closePalette: () => void;
  paletteOpen: boolean;
}): void {
  const navigate = useNavigate();

  // Keep a ref to the latest opts so the effect can read fresh values
  // without re-binding the listener (which would otherwise fire on every
  // palette open/close).
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    let waitingForG = false;
    let gTimer: ReturnType<typeof setTimeout> | null = null;

    const onKey = (e: KeyboardEvent): void => {
      const current = optsRef.current;

      // ⌘K / Ctrl+K — always available, even inside inputs.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (current.paletteOpen) current.closePalette();
        else current.openPalette();
        return;
      }

      if (e.key === "Escape" && current.paletteOpen) {
        // cmdk Dialog already handles ESC, but duplicate for safety.
        current.closePalette();
        return;
      }

      if (inEditable(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (waitingForG) {
        const dest = G_TARGETS[e.key.toLowerCase()];
        if (dest) {
          e.preventDefault();
          navigate({ to: dest });
        }
        waitingForG = false;
        if (gTimer) clearTimeout(gTimer);
        return;
      }

      if (e.key.toLowerCase() === "g") {
        waitingForG = true;
        if (gTimer) clearTimeout(gTimer);
        gTimer = setTimeout(() => {
          waitingForG = false;
        }, G_PREFIX_MS);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (gTimer) clearTimeout(gTimer);
    };
  }, [navigate]);
}
