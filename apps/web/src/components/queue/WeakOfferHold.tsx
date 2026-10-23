import type { QueueRowView } from "@oneshot-gtm/shared-types";
import { flagAdvice } from "../../lib/flagLabels.ts";
import { FitHold } from "./FitHold.tsx";

type SendHold = NonNullable<QueueRowView["sendHold"]>;

/**
 * The row's send is held because its active offer was rated a weak fit. Same
 * look as the fit hold; the founder releases it from the offer block
 * (Approve offer, Next offer, Edit offer), so this only says why and what to do.
 */
export function WeakOfferHold({ hold }: { hold: SendHold }) {
  return (
    <details className="text-[12px] leading-5 text-[color:var(--ink-blocked-2)]">
      <summary className="cursor-pointer font-medium">
        Held · weak offer · {flagAdvice("weak-offer")}
      </summary>
      <div role="note" className="mt-2 space-y-2">
        <p>{hold.reason}</p>
        <p>
          Queue approval and the offer are separate. Regenerating the draft will not clear this
          hold.
        </p>
      </div>
    </details>
  );
}

/** The letter's note for whichever hold the row's send is under. */
export function SendHoldNote({ hold }: { hold: SendHold }) {
  return hold.code === "weak-offer" ? <WeakOfferHold hold={hold} /> : <FitHold hold={hold} />;
}
