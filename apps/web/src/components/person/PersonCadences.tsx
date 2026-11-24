import type { CadenceView } from "@oneshot-gtm/shared-types";
import { timeAgo } from "../../lib/cn.ts";
import { Badge } from "../primitives/Badge.tsx";
import { PaneHeading } from "./PaneHeading.tsx";

/** One cadence: its play, status and where it stands. */
export function CadenceLine({ c }: { c: CadenceView }) {
  return (
    <li className="flex items-center gap-2">
      <span>{c.playName}</span>
      <Badge
        tone={c.status === "replied" ? "receipt" : c.status === "active" ? "signal" : "neutral"}
      >
        {c.status}
      </Badge>
      <span className="font-mono text-[11px] text-ink-faint">
        step {Math.min(c.currentStep + 1, c.followupCount + 1)}/{c.followupCount + 1}
        {c.nextDueAt && c.status === "active" ? ` · next ${timeAgo(c.nextDueAt)}` : ""}
        {c.stopReason ? ` · ${c.stopReason.replace(/_/g, " ")}` : ""}
      </span>
    </li>
  );
}

/** Every cadence this person is or was on; nothing when there are none. */
export function PersonCadences({ cadences }: { cadences: CadenceView[] }) {
  if (cadences.length === 0) return null;
  return (
    <section aria-label="Cadences">
      <PaneHeading>cadences</PaneHeading>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px] text-ink-cream-2">
        {cadences.map((c) => (
          <CadenceLine key={`${c.prospectId}-${c.playName}`} c={c} />
        ))}
      </ul>
    </section>
  );
}
