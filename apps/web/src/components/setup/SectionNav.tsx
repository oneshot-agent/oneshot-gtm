import { cn } from "../../lib/cn.ts";
import { SECTIONS, type SectionId } from "./constants.ts";

/**
 * Jump list for the settings sections. A sticky rail on wide screens, a
 * horizontal chip row above the fold on narrow ones. Each item is a real
 * `#id` anchor for copy-link, but the click is handled by hand: a native
 * hash navigation pushes a history entry without TanStack's `__TSR_key`,
 * which desyncs the router's back/forward index (see the proposedIcp strip
 * in IcpSection for the same constraint).
 */
export function SectionNav({
  dirty,
  active,
}: {
  dirty: Partial<Record<SectionId, boolean>>;
  active: SectionId | null;
}) {
  const unsaved = SECTIONS.filter((s) => dirty[s.id]).length;
  return (
    <nav
      aria-label="Setup sections"
      className={cn(
        "border-b border-ink-rule bg-ink-bg/95 backdrop-blur-[2px]",
        "sticky top-0 z-10 flex gap-1 overflow-x-auto px-4 py-2",
        "lg:static lg:top-auto lg:z-auto lg:flex-col lg:gap-0.5 lg:overflow-visible lg:border-b-0 lg:border-r lg:px-3 lg:py-5",
      )}
    >
      {SECTIONS.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          aria-current={active === s.id ? "location" : undefined}
          onClick={(e) => {
            e.preventDefault();
            jumpToSection(s.id);
          }}
          className={cn(
            "flex shrink-0 items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5",
            "font-sans text-[12.5px] whitespace-nowrap transition-colors duration-[var(--dur-stamp)]",
            active === s.id
              ? "bg-ink-surface text-ink-cream"
              : "text-ink-muted hover:bg-ink-surface/60 hover:text-ink-cream-2",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              dirty[s.id] ? "bg-[color:var(--ink-spend)]" : "bg-transparent",
            )}
          />
          {s.label}
          {dirty[s.id] && <span className="sr-only"> (unsaved changes)</span>}
        </a>
      ))}
      <div
        className={cn(
          "hidden lg:block lg:mt-3 lg:px-2.5 font-mono text-[10.5px]",
          unsaved > 0 ? "text-[color:var(--ink-spend-2)]" : "text-ink-faint",
        )}
      >
        {unsaved > 0 ? `${unsaved} section${unsaved === 1 ? "" : "s"} unsaved` : "all saved"}
      </div>
    </nav>
  );
}

/**
 * Scroll a section into view and record the hash without adding a history
 * entry. `<main>` is the scroll container, so scrollIntoView (nearest
 * scrollable ancestor) is the right primitive — not window.scrollTo.
 */
export function jumpToSection(id: SectionId, behavior: ScrollBehavior = "smooth"): void {
  document.getElementById(id)?.scrollIntoView({ behavior, block: "start" });
  window.history.replaceState(window.history.state, "", `#${id}`);
}
