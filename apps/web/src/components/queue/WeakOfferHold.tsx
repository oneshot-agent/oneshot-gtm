import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueueRowView } from "@oneshot-gtm/shared-types";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api/client.ts";
import { readOnly } from "../../lib/readOnly.ts";
import { Button } from "../primitives/Button.tsx";
import { FitHold } from "./FitHold.tsx";

type SendHold = NonNullable<QueueRowView["sendHold"]>;

/**
 * The row's send is held because its active offer was rated a weak fit. Same
 * look as the fit hold; the founder releases it by rewriting the offer,
 * picking another, or approving this one as it stands.
 */
export function WeakOfferHold({
  rowId,
  hold,
  editable = true,
}: {
  rowId: number;
  hold: SendHold;
  /** False once the row is sending: the offer can no longer change. */
  editable?: boolean;
}) {
  const qc = useQueryClient();
  const approve = useMutation({
    mutationFn: () => api.setQueueOffer(rowId, { approveWeak: true }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["queue"] });
      toast.success("offer approved · the draft can be sent");
    },
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: ["queue"] });
      toast.error(`couldn't approve the offer · ${err.message}`);
    },
  });
  return (
    <details className="text-[12px] leading-5 text-[color:var(--ink-blocked-2)]">
      <summary className="cursor-pointer font-medium">Held · weak offer</summary>
      <div role="note" className="mt-2 space-y-2">
        <p>{hold.reason}</p>
        <p>
          Queue approval and the offer are separate. Regenerating the draft will not clear this
          hold.
        </p>
        {editable && (
          <Button
            variant="secondary"
            size="sm"
            disabled={approve.isPending}
            onClick={() => approve.mutate()}
            title="Send this offer as it stands, although it was rated a weak fit"
            {...readOnly}
          >
            {approve.isPending ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Check size={11} />
            )}
            {approve.isPending ? "Approving…" : "Approve offer"}
          </Button>
        )}
      </div>
    </details>
  );
}

/** The letter's note for whichever hold the row's send is under. */
export function SendHoldNote({
  rowId,
  hold,
  editable,
}: {
  rowId: number;
  hold: SendHold;
  editable?: boolean;
}) {
  return hold.code === "weak-offer" ? (
    <WeakOfferHold rowId={rowId} hold={hold} {...(editable !== undefined ? { editable } : {})} />
  ) : (
    <FitHold hold={hold} />
  );
}
