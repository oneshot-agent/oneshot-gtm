import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, Clock, Copy, Mail, MessageSquare, Phone, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { PlayDescriptor } from "@oneshot-gtm/shared-types";
import { api } from "../api/client.ts";
import { Button } from "../components/primitives/Button.tsx";
import { Input } from "../components/primitives/Field.tsx";
import { SkeletonRow } from "../components/primitives/Skeleton.tsx";
import { CadenceTimeline, type CadenceStep } from "../components/plays/CadenceTimeline.tsx";
import { cn } from "../lib/cn.ts";

export const Route = createFileRoute("/plays")({
  component: PlaysPage,
});

const CHANNEL_ICON = {
  email: Mail,
  sms: MessageSquare,
  voice: Phone,
  linkedin: MessageSquare,
} as const;

// Mirror of apps/server/src/api/run.ts SUPPORTED — plays whose targets the
// SSE /api/run endpoint knows how to dispatch.
const RUNNABLE_PLAYS = new Set([
  "show-hn",
  "job-change",
  "post-funding",
  "accelerator-batch",
  "hiring-signal",
  "podcast-guest",
  "stack-consolidation",
  "repo-interest",
  "luma-events",
]);

/**
 * Per-play metadata the API doesn't expose yet — human description + day-
 * offset timeline. Values mirror the sequences defined in
 * packages/plays/src/_cadence.ts on the server.
 */
const PLAY_META: Record<string, { description: string; steps: CadenceStep[] }> = {
  "show-hn": {
    description:
      "One-touch founder-to-founder reply to a recent Show HN post, referencing a specific comment thread.",
    steps: [{ day: 0, label: "send" }],
  },
  "job-change": {
    description:
      "Trigger: prospect started a new role at a target company. Day-0 send; day-5 follow-up; day-14 breakup.",
    steps: [
      { day: 0, label: "send" },
      { day: 5, label: "follow-up" },
      { day: 14, label: "breakup", breakup: true },
    ],
  },
  "post-funding": {
    description:
      "Trigger: prospect's company announced a round. Day-3 congrats; day-9 follow-up; day-18 breakup.",
    steps: [
      { day: 0, label: "send" },
      { day: 9, label: "follow-up" },
      { day: 18, label: "breakup", breakup: true },
    ],
  },
  "accelerator-batch": {
    description:
      "Founder-to-founder outreach within or across accelerator batches (YC, OD, SPC, Antler, Techstars).",
    steps: [
      { day: 0, label: "send" },
      { day: 5, label: "follow-up" },
      { day: 12, label: "breakup", breakup: true },
    ],
  },
  concierge: {
    description:
      "Autonomous voice onboarding for new signups. Pre-call email → voice call → post-call summary email.",
    steps: [
      { day: 0, label: "prep email" },
      { day: 0, label: "voice" },
      { day: 0, label: "summary" },
    ],
  },
  "demo-no-show": {
    description:
      "Same-day SMS + email recovery for demo no-shows; cadence engine handles day-3 follow-up.",
    steps: [
      { day: 0, label: "sms + email" },
      { day: 3, label: "follow-up" },
    ],
  },
  "competitor-switch": {
    description:
      "Migration-honesty pitch for prospects using a competing vendor. Optional G2 / BuiltWith scrape.",
    steps: [{ day: 0, label: "send" }],
  },
  "stack-consolidation": {
    description:
      "Consolidation-honesty pitch for repos wiring up several API vendors. Fed by the github-topics finder.",
    steps: [{ day: 0, label: "send" }],
  },
  "repo-interest": {
    description:
      "Complementary intro to someone who starred an adjacent repo in your space. Fed by the github-stars finder.",
    steps: [{ day: 0, label: "send" }],
  },
  "luma-events": {
    description:
      "Forward-looking pitch to publicly-visible attendees of upcoming Luma events whose topic + city overlap with the founder's ICP. Fed by the luma-events finder.",
    steps: [{ day: 0, label: "send" }],
  },
  "hiring-signal": {
    description:
      "Triggered by a job post at a target company. One-touch email to the hiring manager with your ramp-time claim.",
    steps: [{ day: 0, label: "send" }],
  },
  "podcast-guest": {
    description:
      "One-touch reply to a recent podcast guest referencing a specific moment from the episode.",
    steps: [{ day: 0, label: "send" }],
  },
  "breakup-revive": {
    description:
      "Pattern-interrupt for ledger cold leads (60–90 days). Pulled from `listColdProspects`.",
    steps: [{ day: 0, label: "revive" }],
  },
};

function PlaysPage() {
  const plays = useQuery({ queryKey: ["plays"], queryFn: api.plays });

  // Pull a wide window of receipts once and group them client-side so we can
  // show per-play "signed N this month" without an API change.
  const receipts = useQuery({
    queryKey: ["receipts", "plays-catalogue"],
    queryFn: () => api.receipts({ limit: 500 }),
    staleTime: 60_000,
  });
  const receiptCounts = groupByPlay(receipts.data?.receipts ?? []);

  const [copiedName, setCopiedName] = useState<string | null>(null);

  return (
    <div className="-mx-6 -my-6 flex flex-col">
      {/* Masthead */}
      <section className="flex items-end justify-between gap-4 border-b border-ink-rule px-6 pb-5 pt-6">
        <div>
          <div className="ln-eyebrow">The Ledger · Plays</div>
          <h1
            className="mt-1 text-ink-cream"
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 44,
              fontWeight: 600,
              letterSpacing: "-0.025em",
              lineHeight: 0.98,
            }}
          >
            The motion catalogue.
          </h1>
          <p className="ln-note mt-2 max-w-[64ch] text-[13px] text-ink-cream-2">
            Ten motion plays. Each one is a known signal you can act on — trigger, cadence,
            anti-slop lint, signed receipt. Run from the CLI or, for the six queue-drain plays, from
            the dashboard.
          </p>
        </div>
        <div className="font-mono text-[11px] text-ink-faint">
          {plays.data ? (
            <>
              {plays.data.plays.length} <span className="text-ink-muted">plays</span>
            </>
          ) : (
            "…"
          )}
        </div>
      </section>

      {/* Plays ledger — one rich row per play */}
      <section>
        {plays.isLoading ? (
          <div>
            {Array.from({ length: 8 }, (_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : (
          <div>
            {plays.data?.plays.map((p, i) => {
              const meta = PLAY_META[p.name];
              const runnable = RUNNABLE_PLAYS.has(p.name);
              const count = receiptCounts.get(p.name) ?? 0;
              return (
                <div
                  key={p.name}
                  className={cn(
                    "group grid gap-x-6 gap-y-3 px-6 py-5",
                    "grid-cols-[minmax(220px,280px)_1fr_auto]",
                    "border-b border-ink-rule/60",
                    "transition-colors duration-[var(--dur-stamp)]",
                    "hover:bg-ink-surface/40",
                    i % 2 === 1 && "bg-ink-surface/20",
                  )}
                >
                  {/* Left: name + channel chips + receipt badge */}
                  <div className="flex flex-col gap-2.5">
                    <div className="flex items-baseline gap-2">
                      <code
                        className="font-mono text-[15px] font-medium text-ink-cream"
                        style={{ fontFeatureSettings: '"zero"' }}
                      >
                        {p.name}
                      </code>
                      {runnable && (
                        <span className="font-mono text-[10px] text-ink-faint">· runnable</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1 text-ink-muted">
                        {p.channels.map((ch) => {
                          const Icon = CHANNEL_ICON[ch] ?? Mail;
                          return (
                            <span
                              key={ch}
                              className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-[var(--radius-xs)] border border-ink-rule"
                              title={ch}
                            >
                              <Icon size={10} />
                            </span>
                          );
                        })}
                      </div>
                      <span className="font-mono text-[11px] text-ink-faint">
                        {p.followupCount} follow-up{p.followupCount === 1 ? "" : "s"}
                        {p.hasBreakup ? " · breakup" : ""}
                      </span>
                    </div>
                    <div className="font-mono text-[11px] text-ink-faint">
                      {count > 0 ? (
                        <span>
                          <span className="text-[color:var(--ink-receipt-2)]">{count}</span> receipt
                          {count === 1 ? "" : "s"} signed
                        </span>
                      ) : (
                        <span>no receipts yet</span>
                      )}
                    </div>
                  </div>

                  {/* Middle: description + cadence timeline + CLI */}
                  <div className="flex flex-col gap-3 min-w-0">
                    {meta?.description && (
                      <p className="ln-note text-[13px] text-ink-cream-2">{meta.description}</p>
                    )}
                    <CadenceEditor play={p} />
                    <code
                      className={cn(
                        "block overflow-x-auto whitespace-nowrap rounded-[var(--radius-sm)]",
                        "border border-ink-rule bg-ink-bg-deep px-2.5 py-1.5",
                        "font-mono text-[12px] text-ink-cream-2",
                      )}
                    >
                      $ {p.cliInvocation}
                    </code>
                  </div>

                  {/* Right: actions */}
                  <div className="flex flex-col items-end gap-1.5">
                    {runnable && (
                      <Link
                        to="/run/$playName"
                        params={{ playName: p.name }}
                        className="inline-flex"
                      >
                        <Button variant="primary" size="sm">
                          <Play size={12} /> run
                        </Button>
                      </Link>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard.writeText(p.cliInvocation);
                        setCopiedName(p.name);
                        setTimeout(() => setCopiedName((n) => (n === p.name ? null : n)), 1500);
                      }}
                    >
                      {copiedName === p.name ? (
                        <>
                          <Check size={12} /> copied
                        </>
                      ) : (
                        <>
                          <Copy size={12} /> copy
                        </>
                      )}
                    </Button>
                    {!runnable && (
                      <span className="font-mono text-[10px] text-ink-faint">CLI only</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function groupByPlay<T extends { playName: string }>(rows: T[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.playName, (m.get(r.playName) ?? 0) + 1);
  return m;
}

/**
 * Cadence timeline + inline timing editor for a play. The day-0 send is fixed;
 * the founder edits each follow-up's cumulative day (1–120, strictly
 * increasing). Save persists a per-play override; reset clears it back to the
 * code default. Structure (which prompts, breakup position) isn't editable.
 */
function CadenceEditor({ play }: { play: PlayDescriptor }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [days, setDays] = useState<number[]>(play.steps.map((s) => s.day));

  // Re-sync local state from the server after save/reset — but never while the
  // founder is mid-edit (a background refetch, e.g. on window focus, must not
  // clobber in-progress input).
  useEffect(() => {
    if (!editing) setDays(play.steps.map((s) => s.day));
  }, [play.steps, editing]);

  const save = useMutation({
    mutationFn: (next: number[] | null) => api.setCadence(play.name, next),
    onSuccess: (_data, next) => {
      void qc.invalidateQueries({ queryKey: ["plays"] });
      setEditing(false);
      toast.success(next === null ? `${play.name} · cadence reset` : `${play.name} · timing saved`);
    },
    onError: (err) => toast.error(`couldn't save · ${err.message}`),
  });

  const timeline: CadenceStep[] = [
    { day: 0, label: "send" },
    ...play.steps.map((s) => ({
      day: s.day,
      label: s.label,
      breakup: s.isBreakup,
    })),
  ];
  const hasFollowups = play.steps.length > 0;
  const isModified = JSON.stringify(days) !== JSON.stringify(play.defaultDays);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <CadenceTimeline steps={timeline} />
        {hasFollowups && !editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1 font-mono text-[10px] text-ink-faint underline decoration-ink-rule underline-offset-2 hover:text-ink-cream-2"
          >
            <Clock size={10} /> edit timing
          </button>
        )}
      </div>
      {editing && (
        <div className="flex flex-col gap-2 rounded-[var(--radius-sm)] border border-ink-rule bg-ink-bg-deep p-3">
          <div className="flex flex-wrap items-end gap-3">
            {play.steps.map((s, i) => (
              <label key={s.label} className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                  {s.label} · day
                </span>
                <Input
                  type="number"
                  min={1}
                  max={120}
                  value={days[i] ?? 1}
                  onChange={(e) => {
                    const v = Math.max(1, Math.min(120, Number.parseInt(e.target.value, 10) || 1));
                    setDays((prev) => prev.map((d, j) => (j === i ? v : d)));
                  }}
                  className="w-20 font-mono text-[12px]"
                />
              </label>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(days)}>
              {save.isPending ? "saving…" : "save"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={save.isPending || !isModified}
              onClick={() => save.mutate(null)}
              title="Restore the code-default timing"
            >
              reset to default
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={save.isPending}
              onClick={() => {
                setDays(play.steps.map((s) => s.day));
                setEditing(false);
              }}
            >
              cancel
            </Button>
          </div>
          <p className="font-mono text-[10px] text-ink-faint">
            cumulative days from the day-0 send · strictly increasing · 1–120 · default{" "}
            {play.defaultDays.map((d) => `d${d}`).join(" · ")}
          </p>
        </div>
      )}
    </div>
  );
}
