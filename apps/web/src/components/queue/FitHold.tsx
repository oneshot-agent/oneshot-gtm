import type { QueueRowView } from "@oneshot-gtm/shared-types";
import { usePrivacy } from "../../lib/privacy.tsx";

export function FitHold({ hold }: { hold: NonNullable<QueueRowView["sendHold"]> }) {
  const { masked } = usePrivacy();
  return (
    <details className="text-[12px] leading-5 text-[color:var(--ink-blocked-2)]">
      <summary className="cursor-pointer font-medium">Held · fit review</summary>
      <div role="note" className="mt-2">
        <p>{masked ? "Fit assessment hidden in privacy mode." : hold.reason}</p>
        <p>
          Queue approval and customer fit are separate. Review this person's fit before sending.
          Regenerating the draft will not clear this hold.
        </p>
      </div>
    </details>
  );
}
