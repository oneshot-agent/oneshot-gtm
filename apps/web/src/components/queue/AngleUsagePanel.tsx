import type { AngleUsageView, DraftUsageView, TriggerView } from "@oneshot-gtm/shared-types";
import { isNeverSent } from "../../lib/angleRetire.ts";
import { cn } from "../../lib/cn.ts";
import { replyLabel } from "../../lib/replyRate.ts";
import { Button } from "../primitives/Button.tsx";
import { Explain } from "../primitives/Explain.tsx";

/**
 * What the founder did with each configured angle, shown inside the trigger
 * config editor under `yourEdge`, and how often its sends were answered — the
 * side-by-side a founder reads to compare angles (a lesson against an
 * opportunity, say). Counts are distinct prospects. `retire`
 * only rewrites the editor text (lib/angleRetire.ts); the editor's own save
 * is the write.
 */

function usageLine(label: string, u: DraftUsageView): string {
  const parts = [`${u.sent} sent`, `${u.regenerated} regenerated`];
  if (u.rotated > 0) parts.push(`${u.rotated} rotated`);
  if (u.autoSent > 0) parts.push(`${u.autoSent} auto-sent`);
  if (u.sent + u.autoSent > 0) parts.push(replyLabel(u.replied, u.sent + u.autoSent));
  return `${label} ${parts.join(" / ")}`;
}

function angleCounts(a: AngleUsageView): string {
  return [
    `offered ${a.offered}`,
    `rotated ${a.rotatedAway}`,
    `redrafted ${a.redrafted}`,
    `sent ${a.sent}`,
    ...(a.autoSent > 0 ? [`auto ${a.autoSent}`] : []),
    // Per person reached (reviewed or unattended, counted once), so the
    // sample threshold says "people".
    ...(a.reached > 0 ? [replyLabel(a.replied, a.reached, "people")] : []),
  ].join(" · ");
}

export function AngleUsagePanel({
  angleUsage,
  draftUsage,
  voiceUsage,
  formatUsage,
  onRetire,
  disabled,
}: {
  angleUsage: TriggerView["angleUsage"];
  draftUsage: TriggerView["draftUsage"];
  /** The same outcomes split by the founder's voice card; absent on older callers. */
  voiceUsage?: TriggerView["voiceUsage"];
  /** Intro outcomes by first-touch format arm; absent until a format setting drafted something. */
  formatUsage?: TriggerView["formatUsage"];
  /** Remove an angle from the editor text. Absent = read-only. */
  onRetire?: (angleText: string) => void;
  disabled?: boolean;
}): React.ReactElement | null {
  if (!angleUsage) return null;
  const hasAny =
    angleUsage.angles.some((a) => a.offered > 0 || a.autoSent > 0) ||
    angleUsage.generated.offered > 0;
  return (
    <div className="ln-note flex flex-col gap-1.5 text-[12px] text-ink-cream-2">
      <div className="font-mono text-[11px] text-ink-faint">
        {draftUsage
          ? `drafts · ${usageLine("intro", draftUsage.intro)} · ${usageLine("follow-up", draftUsage.followUp)}`
          : "drafts · nothing drafted on this play yet"}
        <Explain concept="angleUsage" />
      </div>
      {voiceUsage && voiceUsage.voiced.sent + voiceUsage.voiced.regenerated > 0 && (
        <div className="font-mono text-[11px] text-ink-faint">
          {`voice · ${usageLine("on", voiceUsage.voiced)} · ${usageLine("off", voiceUsage.plain)}`}
        </div>
      )}
      {formatUsage && Object.keys(formatUsage).length > 0 && (
        <div className="font-mono text-[11px] text-ink-faint">
          {`first-touch format · ${Object.entries(formatUsage)
            .map(([arm, u]) => usageLine(arm, u))
            .join(" · ")}`}
          <Explain concept="firstTouchFormat" />
        </div>
      )}
      {!hasAny && (
        <div className="text-ink-faint">
          No angle has been put in front of you yet — counts appear once drafts are reviewed.
        </div>
      )}
      <ol className="flex flex-col gap-1">
        {angleUsage.angles.map((a, i) => {
          const neverSent = isNeverSent(a);
          return (
            <li
              key={a.text}
              className={cn(
                "flex items-baseline gap-2",
                neverSent ? "text-ink-faint" : "text-ink-cream-2",
              )}
              title={a.text}
            >
              <span className="font-mono text-[11px] text-ink-faint">#{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">{a.text}</span>
              <span className="shrink-0 font-mono text-[11px]">
                {angleCounts(a)}
                {neverSent ? " · never sent" : ""}
              </span>
              {onRetire && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  title="Remove this angle from the edge text above; save to apply"
                  onClick={() => onRetire(a.text)}
                >
                  retire
                </Button>
              )}
            </li>
          );
        })}
        {angleUsage.generated.offered > 0 && (
          <li
            className="flex items-baseline gap-2 text-ink-muted"
            title="alternatives the rotate button generated"
          >
            <span className="font-mono text-[11px] text-ink-faint">gen</span>
            <span className="min-w-0 flex-1 truncate">generated alternatives</span>
            <span className="shrink-0 font-mono text-[11px]">
              {angleCounts(angleUsage.generated)}
            </span>
          </li>
        )}
      </ol>
    </div>
  );
}
