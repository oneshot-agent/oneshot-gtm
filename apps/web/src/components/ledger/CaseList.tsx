import { ChevronRight, ExternalLink } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import type { CaseRow } from "../../lib/queueCase.ts";

/**
 * The case column's evidence: key/value rows where a fact has a key
 * ("title: Co-Founder & CEO"), full-width lines where it does not
 * ("upcoming event"). Keys sit in a 92px mono gutter; a row can carry a link
 * or a tone (a passed event's date in oxblood, an overdue step in amber).
 */
export interface CaseListRow extends CaseRow {
  href?: string;
  tone?: "blocked" | "spend";
}

// Literal class strings per tone — Tailwind cannot see a concatenated name.
const ROW_TONE = { blocked: "text-ink-blocked-2", spend: "text-ink-spend-2" } as const;

export function CaseList({ rows, className }: { rows: CaseListRow[]; className?: string }) {
  if (rows.length === 0) return null;
  return (
    <div className={cn("grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-1 leading-4", className)}>
      {rows.map((r) => (
        <Fragment key={`${r.key ?? ""}|${r.value}`}>
          {r.key ? (
            <span className="pt-px font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-faint">
              {r.key}
            </span>
          ) : null}
          <span
            className={cn(
              "min-w-0 break-words",
              r.key ? "text-ink-cream-2" : "col-span-2 text-ink-muted",
              r.tone && ROW_TONE[r.tone],
            )}
          >
            {r.href ? (
              <a
                href={r.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-ink-cream-2 underline decoration-ink-rule underline-offset-2 hover:text-ink-cream hover:decoration-ink-cream-2"
              >
                <ExternalLink size={11} /> {r.value}
              </a>
            ) : (
              r.value
            )}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * A quiet disclosure — mono eyebrow with a chevron that turns when open. The
 * score breakdown and the payload json live behind one; so does a sent
 * step's body on /cadences.
 */
export function Disclosure({
  label,
  summary,
  children,
  className,
}: {
  label: string;
  /** Something to sit before the label on the summary line (a chip). */
  summary?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={cn("group/disclosure text-ink-faint", className)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        {summary}
        <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint group-hover/disclosure:text-ink-cream-2">
          <ChevronRight
            size={12}
            className="transition-transform group-open/disclosure:rotate-90"
          />
          {label}
        </span>
      </summary>
      {children}
    </details>
  );
}

/** The row's raw payload, behind a disclosure at the foot of the case. */
export function PayloadJson({ value }: { value: unknown }) {
  return (
    <Disclosure label="payload json">
      <pre className="mt-2 max-h-[300px] overflow-auto rounded-[var(--radius-sm)] border border-ink-rule bg-ink-bg-deep p-3 font-mono text-[11.5px] leading-[1.55] text-ink-cream-2">
        {JSON.stringify(value, null, 2)}
      </pre>
    </Disclosure>
  );
}
