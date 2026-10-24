import type { QueueRowView } from "@oneshot-gtm/shared-types";
import { flagAdvice } from "../../lib/flagLabels.ts";
import { FitHold } from "./FitHold.tsx";

type SendHold = NonNullable<QueueRowView["sendHold"]>;

/**
 * The row's send is held because its active offer was rated a weak fit. Same
 * look as the fit hold. The summary says what releases it (the offer block's
 * Approve offer, Next offer, Edit offer); the body only what does not.
 */
export function WeakOfferHold() {
  return (
    <details className="text-[12px] leading-5 text-[color:var(--ink-blocked-2)]">
      <summary className="cursor-pointer font-medium">
        Held · weak offer · {flagAdvice("weak-offer")}
      </summary>
      <p role="note" className="mt-2">
        Queue approval and the offer are separate. Regenerating the draft will not clear this hold.
      </p>
    </details>
  );
}

/** The letter's note for whichever hold the row's send is under. */
export function SendHoldNote({ hold }: { hold: SendHold }) {
  return hold.code === "weak-offer" ? <WeakOfferHold /> : <FitHold hold={hold} />;
}
