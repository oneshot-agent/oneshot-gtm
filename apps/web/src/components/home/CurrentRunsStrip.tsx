import { Link } from "@tanstack/react-router";
import { ArrowRight, Loader2 } from "lucide-react";
import type { RunSummary } from "@oneshot-gtm/shared-types";
import { timeAgo } from "../../lib/cn.ts";
import { Badge } from "../primitives/Badge.tsx";

/**
 * Compact "in flight" strip on /home. Shows the founder a path back to any
 * currently-running /run dispatch — the URL `/run/<play>?runId=N` is the
 * durable handle, but most founders won't remember it after they navigate
 * away. This widget surfaces every `status='running'` row from the runs
 * table so they can click "Resume" to land back on the progress view.
 *
 * Pure presentation: data comes pre-baked from `HomeMetrics.currentRuns`
 * (capped at 5 server-side). Hides itself when the array is empty so /home
 * doesn't grow an empty section.
 */
export function CurrentRunsStrip({ runs }: { runs: RunSummary[] }): React.ReactElement | null {
  if (runs.length === 0) return null;

  return (
    <section className="border-b border-ink-rule">
      <header className="flex items-baseline justify-between border-b border-ink-rule px-6 py-2.5">
        <div className="ln-eyebrow flex items-center gap-2">
          <Loader2 size={12} className="animate-spin text-[color:var(--ink-receipt-2)]" />
          In flight
          <span className="font-mono text-[11px] text-ink-faint">· {runs.length}</span>
        </div>
        <span className="text-[11px] text-ink-faint">
          click <span className="font-mono text-ink-cream-2">resume</span> to hop back
        </span>
      </header>
      <table className="w-full">
        <tbody>
          {runs.map((r) => {
            const labelTotal = r.targetCount > 0 ? `/${r.targetCount}` : "";
            return (
              <tr key={r.id} className="border-b border-ink-rule/40 last:border-b-0">
                <td className="px-6 py-2.5 font-mono text-[12px] text-ink-cream-2">
                  {r.playName}
                </td>
                <td className="px-3 py-2.5">
                  <Badge tone="receipt">running</Badge>
                </td>
                <td className="px-3 py-2.5 font-mono text-[11.5px] text-ink-faint">
                  <span className="text-ink-cream-2">{r.draftedCount}</span>
                  {labelTotal} drafted ·{" "}
                  <span
                    className={
                      r.sentCount > 0 ? "text-[color:var(--ink-receipt-2)]" : "text-ink-muted"
                    }
                  >
                    {r.sentCount}
                  </span>{" "}
                  sent
                  {r.errorCount > 0 && (
                    <span className="text-[color:var(--ink-blocked-2)]">
                      {" "}
                      · {r.errorCount} err
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 font-mono text-[11px] text-ink-faint">
                  started {timeAgo(r.startedAt)}
                </td>
                <td className="px-6 py-2.5 text-right">
                  <Link
                    to="/run/$playName"
                    params={{ playName: r.playName }}
                    search={{ runId: r.id }}
                    className="inline-flex items-center gap-1 font-mono text-[12px] text-ink-cream-2 hover:text-ink-cream"
                  >
                    resume
                    <ArrowRight size={12} />
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
