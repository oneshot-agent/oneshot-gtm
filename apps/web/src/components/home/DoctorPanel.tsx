import { ChevronDown, ChevronRight } from "lucide-react";
import { useRef, useState } from "react";
import type { DoctorCheck, DoctorGroup } from "@oneshot-gtm/shared-types";
import { Badge } from "../primitives/Badge.tsx";
import { EmptyNote } from "../primitives/EmptyNote.tsx";
import { SkeletonRow } from "../primitives/Skeleton.tsx";
import { cn } from "../../lib/cn.ts";
import { summarizeDoctor, worstOf, type DoctorTone as Tone } from "../../lib/doctorSummary.ts";

const GROUP_ORDER: Array<{ key: DoctorGroup; label: string }> = [
  { key: "install", label: "install" },
  { key: "senders", label: "senders" },
  { key: "deliverability", label: "deliverability" },
  { key: "finders", label: "finders" },
  { key: "spend", label: "spend" },
];

function toneFor(severity: DoctorCheck["severity"]): Tone {
  return severity === "ok" ? "receipt" : severity === "warn" ? "spend" : "blocked";
}

/**
 * Sum the `today N/cap` usage suffixes off sender messages — tolerant, like
 * StatusBar's shortValue: rows that don't parse are just left out of the sum.
 */
function senderUsage(checks: DoctorCheck[]): string | null {
  let sent = 0;
  let cap = 0;
  let any = false;
  for (const c of checks) {
    const m = /today (\d+)\/(\d+)/.exec(c.message);
    if (!m) continue;
    any = true;
    sent += Number(m[1]);
    cap += Number(m[2]);
  }
  return any ? `${sent}/${cap} sent today` : null;
}

function groupSummary(key: DoctorGroup, checks: DoctorCheck[]): { text: string; tone: Tone } {
  const fails = checks.filter((c) => c.severity === "fail").length;
  const warns = checks.filter((c) => c.severity === "warn").length;
  if (fails > 0) return { text: `${fails} failing`, tone: "blocked" };
  if (warns > 0) return { text: `${warns} warning${warns === 1 ? "" : "s"}`, tone: "spend" };
  if (key === "senders") {
    const identities = checks.filter((c) => c.name.startsWith("sender ")).length;
    const usage = senderUsage(checks);
    return {
      text: `${identities} identit${identities === 1 ? "y" : "ies"}${usage ? ` · ${usage}` : ""} · ok`,
      tone: "receipt",
    };
  }
  return { text: `all ${checks.length} ok`, tone: "receipt" };
}

/**
 * Group headers carry it, so rows drop redundant label text: "sender " rows
 * show just the identity, and the repeated bare "deliverability" label
 * disappears entirely (its message names the mailbox).
 */
function rowLabel(group: DoctorGroup, name: string): string | null {
  if (group === "senders" && name.startsWith("sender ")) return name.slice("sender ".length);
  if (group === "deliverability" && name === "deliverability") return null;
  return name;
}

const SUMMARY_TONE_CLASS: Record<Tone, string> = {
  receipt: "text-ink-faint",
  spend: "text-[color:var(--ink-spend-2)]",
  blocked: "text-[color:var(--ink-blocked-2)]",
};

export function DoctorPanel({
  checks,
  isLoading,
  error,
}: {
  checks: DoctorCheck[] | undefined;
  isLoading: boolean;
  error?: string | null;
}) {
  // Seed expansion once from the first loaded data: unhealthy groups open,
  // healthy groups collapsed. A background refetch must not slam a group the
  // founder opened (or close one they're reading), hence the seed-once ref.
  const [open, setOpen] = useState<Partial<Record<DoctorGroup, boolean>>>({});
  const seeded = useRef(false);
  if (!seeded.current && checks && checks.length > 0) {
    seeded.current = true;
    const initial: Partial<Record<DoctorGroup, boolean>> = {};
    for (const { key } of GROUP_ORDER) {
      initial[key] = worstOf(checks.filter((c) => (c.group ?? "install") === key)) !== "ok";
    }
    setOpen(initial);
  }

  if (isLoading && !checks) {
    return (
      <div>
        {Array.from({ length: 3 }, (_, i) => (
          <SkeletonRow key={i} />
        ))}
      </div>
    );
  }
  if (error || !checks) {
    return <EmptyNote note="Couldn't run doctor — check the server log and refresh." />;
  }

  const overall = summarizeDoctor(checks);

  return (
    <div className="rounded-[var(--radius-sm)] border border-ink-rule bg-ink-bg-deep">
      <div className="flex items-center justify-between border-b border-ink-rule/60 px-4 py-2">
        <span className="ln-eyebrow">health</span>
        <span className={cn("font-mono text-[11px]", SUMMARY_TONE_CLASS[overall.tone])}>
          {overall.text}
        </span>
      </div>
      {GROUP_ORDER.map(({ key, label }) => {
        const rows = checks.filter((c) => (c.group ?? "install") === key);
        if (rows.length === 0) return null;
        const summary = groupSummary(key, rows);
        const expanded = open[key] ?? false;
        return (
          <div key={key}>
            <button
              type="button"
              onClick={() => setOpen((o) => ({ ...o, [key]: !expanded }))}
              className={cn(
                "flex w-full items-center gap-2 border-b border-ink-rule/60 px-4 py-2.5 text-left",
                "transition-colors duration-[var(--dur-stamp)] hover:bg-ink-surface/60",
              )}
            >
              <span className="text-ink-faint">
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </span>
              <span className="ln-eyebrow flex-1">{label}</span>
              <span className={cn("font-mono text-[11px]", SUMMARY_TONE_CLASS[summary.tone])}>
                {summary.text}
              </span>
            </button>
            {expanded &&
              rows.map((c, i) => {
                const name = rowLabel(key, c.name);
                return (
                  <div
                    key={`${key}:${c.name}:${i}`}
                    className="ln-row"
                    data-tone={toneFor(c.severity)}
                  >
                    <Badge
                      tone={
                        c.severity === "ok"
                          ? "receipt"
                          : c.severity === "warn"
                            ? "spend"
                            : "blocked"
                      }
                    >
                      {c.severity}
                    </Badge>
                    <div className="min-w-0 flex-1 py-1">
                      <div className="text-[13px] leading-snug">
                        {name ? (
                          <span className="mr-2 font-mono text-[11px] text-ink-muted">{name}</span>
                        ) : null}
                        <span className="text-ink-cream">{c.message}</span>
                      </div>
                      {c.hint ? (
                        <div className="ln-note mt-0.5 text-[11.5px] text-ink-muted">
                          → {c.hint}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
