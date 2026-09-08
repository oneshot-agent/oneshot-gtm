import { Save } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "../primitives/Button.tsx";
import { readOnly } from "../../lib/readOnly.ts";
import { sectionMeta, type SectionId } from "./constants.ts";

/**
 * One settings section: eyebrow + lede in the left column, the fields in the
 * right, and its own footer with the dirty count and a Save that submits only
 * this section's `<form>` (Enter in any of its inputs does the same).
 */
export function SectionShell({
  id,
  lede,
  children,
  dirtyCount,
  errorCount = 0,
  savedAt,
  saving,
  onSubmit,
  saveDisabled,
  saveTitle,
  saveLabel = "Save",
  footerNote,
}: {
  id: SectionId;
  lede?: ReactNode;
  children: ReactNode;
  dirtyCount: number;
  errorCount?: number;
  savedAt: number | null;
  saving: boolean;
  onSubmit: () => void;
  saveDisabled?: boolean;
  saveTitle?: string;
  saveLabel?: string;
  /** Extra footer text shown when nothing is dirty (e.g. "applies on the trigger"). */
  footerNote?: ReactNode;
}) {
  const meta = sectionMeta(id);
  const dirty = dirtyCount > 0;
  const blocked = errorCount > 0;
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (saving || blocked || !dirty) return;
    onSubmit();
  };
  return (
    <section
      id={id}
      // scroll-margin so a #hash jump doesn't hide the eyebrow under the
      // horizontal chip row on narrow screens.
      className="scroll-mt-14 border-b border-ink-rule lg:scroll-mt-0"
      aria-labelledby={`${id}-eyebrow`}
    >
      <form
        onSubmit={handleSubmit}
        className="grid grid-cols-1 gap-6 px-6 py-6 lg:grid-cols-[220px_1fr]"
      >
        <div>
          <div id={`${id}-eyebrow`} className="ln-eyebrow">
            {meta.eyebrow}
          </div>
          {lede && <p className="ln-note mt-2 max-w-[32ch] text-[13px] text-ink-cream-2">{lede}</p>}
        </div>
        <div className="flex flex-col gap-4">
          {children}
          <div className="mt-2 flex items-center justify-between gap-4 border-t border-ink-rule/60 pt-3">
            <div className="font-mono text-[11px]">
              {blocked ? (
                <span className="text-[color:var(--ink-blocked-2)]">
                  fix {errorCount} field{errorCount === 1 ? "" : "s"} to save
                </span>
              ) : dirty ? (
                <span className="text-[color:var(--ink-spend-2)]">
                  {dirtyCount} unsaved change{dirtyCount === 1 ? "" : "s"}
                </span>
              ) : savedAt != null ? (
                <span className="text-[color:var(--ink-receipt-2)]">
                  saved · <Ago at={savedAt} />
                </span>
              ) : (
                <span className="text-ink-faint">{footerNote ?? "no unsaved changes"}</span>
              )}
            </div>
            <Button
              type="submit"
              size="sm"
              variant={dirty ? "primary" : "secondary"}
              disabled={saving || blocked || !dirty || saveDisabled}
              title={saveTitle}
              {...readOnly}
            >
              <Save size={12} />
              {saving ? "Saving…" : saveLabel}
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}

/** "just now" → "2m ago", ticking, without pulling a date library in. */
function Ago({ at }: { at: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  const s = Math.floor((Date.now() - at) / 1000);
  if (s < 45) return <>just now</>;
  if (s < 3600) return <>{Math.floor(s / 60)}m ago</>;
  return <>{Math.floor(s / 3600)}h ago</>;
}
