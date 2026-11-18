import { Link } from "@tanstack/react-router";
import type { CallListRow } from "@oneshot-gtm/shared-types";

/**
 * A row with no usable number. Where the prospect has a queue row, it links
 * there, where a phone lookup can run. This is the one place to swap in the
 * queue's Find phone button once it lands.
 */
export function NoNumber({ row }: { row: Pick<CallListRow, "queueId" | "name" | "company"> }) {
  const q = row.name ?? row.company;
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[11px] text-ink-faint">
      No number
      {row.queueId != null && q && (
        <Link
          to="/prospects"
          search={{ q }}
          className="text-ink-muted underline underline-offset-2 hover:text-ink-cream"
        >
          Find phone on its queue row
        </Link>
      )}
    </span>
  );
}
