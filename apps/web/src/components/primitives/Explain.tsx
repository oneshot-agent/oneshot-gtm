import { Popover } from "@base-ui/react/popover";
import { Info } from "lucide-react";
import { getConcept, type ConceptId } from "../../lib/concepts.ts";

/** Inline, touch- and keyboard-accessible help. Events stay out of row actions. */
export function Explain({ concept, detail }: { concept: ConceptId; detail?: string }) {
  const entry = getConcept(concept);
  if (!entry) return null;
  return (
    <Popover.Root>
      <Popover.Trigger
        type="button"
        aria-label={`Explain ${entry.title}`}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") event.stopPropagation();
        }}
        className="ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-full align-middle text-ink-muted hover:bg-ink-surface hover:text-ink-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--ink-signal)]"
      >
        <Info size={13} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} className="z-[100]">
          <Popover.Popup
            onClick={(event) => event.stopPropagation()}
            className="max-w-[min(320px,calc(100vw-24px))] rounded-[var(--radius-sm)] border border-ink-rule bg-ink-bg-deep p-4 text-left font-sans text-[13px] normal-case leading-relaxed tracking-normal text-ink-cream shadow-xl"
          >
            <Popover.Title className="mb-1 font-semibold">{entry.title}</Popover.Title>
            <Popover.Description className="text-ink-muted">
              {detail ?? entry.body}
            </Popover.Description>
            {entry.href && (
              <a
                href={entry.href}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-block underline underline-offset-2"
              >
                Read the docs
              </a>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
