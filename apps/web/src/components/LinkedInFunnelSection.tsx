import type { LinkedInFunnel, LinkedInRate } from "@oneshot-gtm/shared-types";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client.ts";
import { cn, formatCount } from "../lib/cn.ts";
import { EmptyNote } from "./primitives/EmptyNote.tsx";
import { Explain } from "./primitives/Explain.tsx";
import { SkeletonRow } from "./primitives/Skeleton.tsx";

const STEP_KINDS = [
  { label: "all invites", value: undefined },
  { label: "first touch", value: "first-touch" },
  { label: "continuation", value: "continuation" },
  { label: "friend", value: "friend" },
] as const;

const pct = (r: number | null): string => (r === null ? "n/a" : `${(r * 100).toFixed(1)}%`);
const ofRate = (r: LinkedInRate): string => `${r.count} of ${r.of} · ${pct(r.rate)}`;

interface FunnelRow {
  label: string;
  value: (f: LinkedInFunnel) => string;
  help?: "linkedinAccepted" | "linkedinRepliedFirst";
}

const ROWS: FunnelRow[] = [
  { label: "Invites sent", value: (f) => formatCount(f.invitesSent) },
  { label: "Pending", value: (f) => formatCount(f.pending) },
  {
    label: "Withdrawn",
    value: (f) =>
      `${f.withdrawn.total} · timeout ${f.withdrawn.timeout} · manual ${f.withdrawn.manual} · unrecorded ${f.withdrawn.unknown}`,
  },
  {
    label: "Accepted",
    help: "linkedinAccepted",
    value: (f) =>
      `${f.accepted.total} · ${pct(f.accepted.rate)} · by invitation ${f.accepted.viaInvitation} · by conversation ${f.accepted.viaConversation}`,
  },
  {
    label: "Median days to accept",
    value: (f) =>
      f.accepted.medianDaysToAccept === null
        ? "n/a"
        : `${f.accepted.medianDaysToAccept} (over ${f.accepted.daysKnown})`,
  },
  { label: "First message sent", value: (f) => formatCount(f.firstMessageSent) },
  {
    label: "Replied to the first message",
    help: "linkedinRepliedFirst",
    value: (f) => ofRate(f.repliedToFirstMessage),
  },
  { label: "Replied at any point", value: (f) => ofRate(f.repliedAtAnyPoint) },
];

/** The LinkedIn funnel (#792): this workspace, split by whether the note carried an evidence clause. */
export function LinkedInFunnelSection({ sinceDays }: { sinceDays: number | undefined }) {
  const [stepKind, setStepKind] = useState<string | undefined>(undefined);
  const [play, setPlay] = useState<string | undefined>(undefined);
  const q = useQuery({
    queryKey: ["measure", "linkedin", sinceDays, play, stepKind],
    queryFn: () =>
      api.measureLinkedIn({
        ...(sinceDays !== undefined ? { sinceDays } : {}),
        ...(play ? { play } : {}),
        ...(stepKind ? { stepKind } : {}),
      }),
    staleTime: 30_000,
  });
  const view = q.data;
  const columns: Array<{ label: string; funnel: LinkedInFunnel }> = view
    ? [
        { label: "All", funnel: view.funnel },
        { label: "With evidence clause", funnel: view.variants.withEvidence },
        { label: "Without", funnel: view.variants.withoutEvidence },
        ...(view.variants.unrecorded.invitesSent > 0
          ? [{ label: "Before it was recorded", funnel: view.variants.unrecorded }]
          : []),
        ...(view.friend.invitesSent > 0 ? [{ label: "Friend invites", funnel: view.friend }] : []),
      ]
    : [];

  return (
    <section className="border-b border-ink-rule" aria-label="LinkedIn funnel">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-6 pb-2 pt-5">
        <div className="ln-eyebrow">LinkedIn funnel{view ? ` · ${view.workspace}` : ""}</div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-muted">
          <label className="flex items-center gap-1.5">
            step
            <select
              className="rounded border border-ink-rule bg-ink-bg-deep px-1.5 py-0.5 text-ink-cream"
              value={stepKind ?? ""}
              onChange={(e) => setStepKind(e.target.value || undefined)}
            >
              {STEP_KINDS.map((s) => (
                <option key={s.label} value={s.value ?? ""}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            play
            <select
              className="rounded border border-ink-rule bg-ink-bg-deep px-1.5 py-0.5 text-ink-cream"
              value={play ?? ""}
              onChange={(e) => setPlay(e.target.value || undefined)}
            >
              <option value="">all plays</option>
              {(view?.plays ?? []).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {q.isLoading ? (
        Array.from({ length: 4 }, (_, i) => <SkeletonRow key={i} />)
      ) : !view || (view.funnel.invitesSent === 0 && view.friend.invitesSent === 0) ? (
        <div className="px-6 pb-6">
          <EmptyNote note="No LinkedIn invites sent in this view yet. Once invites go out, the funnel lands here." />
        </div>
      ) : (
        <>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                <th className="px-6 py-2 text-left font-medium">step</th>
                {columns.map((c) => (
                  <th key={c.label} className="py-2 pr-6 text-right font-medium">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row, i) => (
                <tr
                  key={row.label}
                  className={cn("border-t border-ink-rule/60", i % 2 === 1 && "bg-ink-surface/20")}
                >
                  <td className="px-6 py-2 text-ink-cream">
                    {row.label}
                    {row.help && <Explain concept={row.help} />}
                  </td>
                  {columns.map((c) => (
                    <td key={c.label} className="py-2 pr-6 text-right font-mono text-ink-muted">
                      {row.value(c.funnel)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-6 pb-4 pt-2 text-[11px] text-ink-faint">
            A person counts once per row. Accepted by conversation misses most accepts on invites
            sent before GTM read the invitation status; `oneshot-gtm linkedin invites` lists each
            invite to compare with LinkedIn.
          </p>
        </>
      )}
    </section>
  );
}
