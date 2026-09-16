import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { DraftVersionView } from "@oneshot-gtm/shared-types";
import { timeAgo } from "../../lib/cn.ts";

/**
 * The drafts a row went through before the one on screen — what the founder
 * regenerated, rotated away from, or (for a sent row) finally sent. Loads on
 * first open; the current `open` version is the letter above, so it is not
 * repeated here.
 */

const OUTCOME_LABEL: Record<string, string> = {
  regenerate: "regenerated",
  rotate: "rotated away",
  redraft: "re-drafted by the drain",
  abandoned: "abandoned",
  sent: "sent",
  auto_sent: "sent by the drain",
};

export function versionLabel(v: DraftVersionView): string {
  if (v.outcome === "discarded") return OUTCOME_LABEL[v.discardReason ?? "redraft"] ?? "discarded";
  return OUTCOME_LABEL[v.outcome] ?? v.outcome;
}

export function DraftHistory({
  queryKey,
  load,
}: {
  queryKey: readonly unknown[];
  load: () => Promise<{ versions: DraftVersionView[] }>;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey, queryFn: load, enabled: open });
  const earlier = (query.data?.versions ?? []).filter((v) => v.outcome !== "open");
  return (
    <details
      className="mt-3 text-xs text-ink-muted"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer">
        {query.data ? `earlier drafts (${earlier.length})` : "earlier drafts"}
      </summary>
      {query.isLoading && <p className="mt-2 text-ink-faint">loading…</p>}
      {query.isError && <p className="mt-2 text-[color:var(--ink-blocked-2)]">could not load</p>}
      {query.data && earlier.length === 0 && (
        <p className="mt-2 text-ink-faint">none — this is the first draft for this step.</p>
      )}
      <ol className="mt-2 flex flex-col gap-3">
        {earlier.map((v) => (
          <li key={v.id} className="border-l border-ink-rule pl-3">
            <div className="font-mono text-[11px] text-ink-faint">
              {versionLabel(v)}
              {v.closedAt ? ` · ${timeAgo(v.closedAt)}` : ""}
              {v.angle ? ` · angle: ${v.angle.text}` : ""}
            </div>
            <div className="mt-1 text-ink-cream-2">{v.subject}</div>
            <p className="mt-1 whitespace-pre-wrap text-ink-muted">{v.body}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}
