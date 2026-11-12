import { formatCount } from "../../lib/cn.ts";
import {
  CADENCE_DUES,
  CADENCE_STEPS,
  INVITE_EXPIRING_DAYS,
  type CadenceDueFilter,
  type CadenceFilter,
  type CadenceFilterCounts,
  type CadenceStepFilter,
} from "../../lib/cadenceFilter.ts";
import { Button } from "../primitives/Button.tsx";

const STEP_LABELS: Record<CadenceStepFilter, string> = {
  all: "All steps",
  "linkedin-invite": "Connection request",
  "linkedin-waiting": "Waiting for acceptance",
  "linkedin-message": "LinkedIn message",
  "linkedin-breakup": "LinkedIn breakup",
  email: "Email",
  "direct-mail": "Direct mail",
};

const DUE_LABELS: Record<CadenceDueFilter, string> = {
  any: "Any time",
  overdue: "Overdue",
  soon: "Due in 24h",
  later: "Later",
  "invite-expiring": "Invite expiring",
};

const DUE_TITLES: Partial<Record<CadenceDueFilter, string>> = {
  overdue: "Past due and ready to send; a row waiting for acceptance is never overdue",
  later: "Due after the next 24 hours, or waiting for acceptance",
  "invite-expiring": `Invites withdrawn within ${INVITE_EXPIRING_DAYS} days if not accepted`,
};

function Chip({
  label,
  count,
  pressed,
  title,
  onClick,
}: {
  label: string;
  count: number;
  pressed: boolean;
  title?: string | undefined;
  onClick: () => void;
}) {
  return (
    <Button
      variant={pressed ? "secondary" : "ghost"}
      size="sm"
      aria-pressed={pressed}
      {...(title ? { title } : {})}
      onClick={onClick}
    >
      <span>{label}</span>
      <span className="ml-1 font-mono text-[10px] text-ink-muted">{formatCount(count)}</span>
    </Button>
  );
}

/**
 * Step and due chips over the cadence table. A step chip appears while any
 * listed row is on that step (`totals`, unfiltered) or it is the open view,
 * so a workspace without LinkedIn or mail steps sees none of theirs, and a
 * chip never jumps away when the other filter leaves it at 0. The same goes
 * for "Invite expiring".
 */
export function CadenceFilters({
  filter,
  counts,
  totals,
  onChange,
}: {
  filter: CadenceFilter;
  /** Each chip's count under the other dimension's choice. */
  counts: CadenceFilterCounts;
  /** The same counts with no filter: which chips the list can use at all. */
  totals: CadenceFilterCounts;
  onChange: (next: CadenceFilter) => void;
}) {
  const steps = (["all", ...CADENCE_STEPS] as const).filter(
    (s) => s === "all" || totals.step[s] > 0 || filter.step === s,
  );
  const dues = (["any", ...CADENCE_DUES] as const).filter(
    (d) => d !== "invite-expiring" || totals.due[d] > 0 || filter.due === d,
  );
  return (
    <div className="flex flex-col gap-1 border-b border-ink-rule px-6 py-2">
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Next step">
        <span className="mr-1 w-10 font-mono text-[11px] text-ink-faint">step</span>
        {steps.map((s) => (
          <Chip
            key={s}
            label={STEP_LABELS[s]}
            count={counts.step[s]}
            pressed={filter.step === s}
            onClick={() => onChange({ ...filter, step: s })}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Due">
        <span className="mr-1 w-10 font-mono text-[11px] text-ink-faint">due</span>
        {dues.map((d) => (
          <Chip
            key={d}
            label={DUE_LABELS[d]}
            count={counts.due[d]}
            pressed={filter.due === d}
            title={DUE_TITLES[d]}
            onClick={() => onChange({ ...filter, due: d })}
          />
        ))}
      </div>
    </div>
  );
}
