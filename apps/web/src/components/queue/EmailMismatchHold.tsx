import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueueRowView } from "@oneshot-gtm/shared-types";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api/client.ts";
import { usePrivacy } from "../../lib/privacy.tsx";
import { readOnly } from "../../lib/readOnly.ts";
import { Button } from "../primitives/Button.tsx";

/**
 * The row's send is held because its address lands at none of the companies
 * person research says they work at now. Fixing the address or the company
 * clears it; so does sending to this address anyway, which applies to this
 * exact address only.
 */
export function EmailMismatchHold({
  hold,
  rowId,
}: {
  hold: NonNullable<QueueRowView["sendHold"]>;
  rowId?: number;
}) {
  const { masked } = usePrivacy();
  const qc = useQueryClient();
  const approve = useMutation({
    mutationFn: () => api.approveEmailMismatch(rowId!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["queue"] });
      toast.success("address approved · the draft can be sent");
    },
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: ["queue"] });
      toast.error(`couldn't approve the address · ${err.message}`);
    },
  });
  return (
    <details className="text-[12px] leading-5 text-[color:var(--ink-blocked-2)]">
      <summary className="cursor-pointer font-medium">Held · email mismatch</summary>
      <div role="note" className="mt-2">
        <p>{masked ? "Address details hidden in privacy mode." : hold.reason}</p>
        <p>Regenerating the draft will not clear this hold.</p>
        {rowId != null && (
          <Button
            size="sm"
            variant="ghost"
            className="mt-1"
            disabled={approve.isPending}
            onClick={() => approve.mutate()}
            title="Send to this exact address; a changed address is checked again"
            {...readOnly}
          >
            {approve.isPending && <Loader2 size={11} className="animate-spin" />}
            Send to this address anyway
          </Button>
        )}
      </div>
    </details>
  );
}
