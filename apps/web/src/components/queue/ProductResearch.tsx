import { ExternalLink } from "lucide-react";
import { usePrivacy } from "../../lib/privacy.tsx";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sourceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Show the saved evidence, without inventing a new summary or attributing every draft claim to it. */
export function ProductResearch({ payload }: { payload: unknown }) {
  const { masked } = usePrivacy();
  const research = record(record(payload)?.productResearch);
  if (!research) return null;
  const sources = (Array.isArray(research.sources) ? research.sources : []).flatMap((value) => {
    const source = record(value);
    if (!source) return [];
    const url = sourceUrl(source.url);
    const excerpt = typeof source.excerpt === "string" ? source.excerpt.trim() : "";
    return url || excerpt ? [{ url, excerpt }] : [];
  });
  const at = typeof research.researchedAt === "string" ? new Date(research.researchedAt) : null;
  const date = at && Number.isFinite(at.getTime()) ? at.toLocaleDateString() : null;
  return (
    <section aria-label="Product research" className="min-w-0 border-t border-ink-rule pt-4">
      <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
        Product research
      </h3>
      {masked ? (
        <p className="mt-2 text-[12px] text-ink-muted">Research hidden in privacy mode.</p>
      ) : (
        <>
          <p className="mt-2 text-[12px] leading-4 text-ink-muted">
            Saved product context available to the draft writer.
            {research.status === "partial" && " Research is partial."}
            {date && (
              <>
                {" "}
                Retrieved <time dateTime={at!.toISOString()}>{date}</time>.
              </>
            )}
          </p>
          {sources.length ? (
            sources.map((source, index) => (
              <div key={`${source.url ?? ""}:${source.excerpt}`} className="mt-3 min-w-0">
                {source.url ? (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex max-w-full items-center gap-1 text-[12px] text-ink-cream-2 underline underline-offset-2"
                  >
                    <ExternalLink size={12} aria-hidden="true" className="shrink-0" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">{source.url}</span>
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ) : (
                  <p className="text-[12px] text-ink-muted">Source link unavailable</p>
                )}
                {source.excerpt ? (
                  <div
                    tabIndex={0}
                    role="region"
                    aria-label={`Saved source excerpt ${index + 1}`}
                    className="mt-2 max-h-64 overflow-y-auto rounded-sm border border-ink-rule p-3 text-[12px] leading-5 text-ink-cream-2 focus-visible:outline focus-visible:outline-1"
                  >
                    <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {source.excerpt
                        .replace(/!\[[^\]\n]*\]\([^\n]*?\)/g, "")
                        .replace(/\n{3,}/g, "\n\n")}
                    </p>
                  </div>
                ) : (
                  <p className="mt-2 text-[12px] text-ink-muted">No saved excerpt available.</p>
                )}
              </div>
            ))
          ) : (
            <p className="mt-2 text-[12px] text-ink-muted">No saved product sources available.</p>
          )}
        </>
      )}
    </section>
  );
}
