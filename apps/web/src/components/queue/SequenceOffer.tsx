import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CadenceView } from "@oneshot-gtm/shared-types";
import { Check, Loader2, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api/client.ts";
import { readOnly } from "../../lib/readOnly.ts";
import { clearRowActivity, setRowActivity, useRowActivity } from "../../lib/rowActivity.ts";
import {
  redraftsAfterOfferChange,
  sequenceOfferEditable,
  sequenceOfferNote,
  sequenceOfferViews,
} from "../../lib/sequenceOffer.ts";
import { Button } from "../primitives/Button.tsx";
import {
  hasCompanyPagesInPayload,
  nextOfferIndex,
  OfferBlock,
  offerChangeLabel,
  type OfferChange,
} from "./ProspectOffer.tsx";

type SequenceOfferChange = OfferChange | { approveWeak: true };

/**
 * The row-activity key for a cadence's offer work: the sent queue row it is
 * kept on, so the letter and the offer block show the same label.
 */
export function sequenceOfferActivityId(c: Pick<CadenceView, "prospectId" | "offer">): number {
  return c.offer?.queueRowId ?? -c.prospectId;
}

/**
 * One change to the sequence's offer, then the next step redrafted around
 * it (the server dropped the old preview), each step named on the shared
 * row activity, as the queue's offer block does.
 */
function useSequenceOfferChange(c: CadenceView) {
  const qc = useQueryClient();
  const activityId = sequenceOfferActivityId(c);
  const redraft = redraftsAfterOfferChange(c);
  return useMutation({
    mutationFn: async (body: SequenceOfferChange) => {
      const token = setRowActivity(
        activityId,
        "approveWeak" in body ? "Approving the offer…" : offerChangeLabel(body),
      );
      try {
        await api.setCadenceOffer(c.prospectId, c.playName, body);
        if (!redraft) return { redrafted: null };
        setRowActivity(activityId, "Rewriting the draft around the offer…", token);
        try {
          await api.previewCadenceNext(c.prospectId, c.playName);
          return { redrafted: true as const };
        } catch (err) {
          return { redrafted: false as const, message: (err as Error).message };
        }
      } finally {
        clearRowActivity(activityId, token);
      }
    },
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["cadences"] });
      void qc.invalidateQueries({ queryKey: ["cadence-drafts", c.prospectId, c.playName] });
      if (result.redrafted === null) toast.success("offer saved · the next email restates it");
      else if (result.redrafted) toast.success("offer saved · next step redrafted, not sent");
      else
        toast.error(
          `offer saved, but the next step was not redrafted · ${result.message}. Generate the draft.`,
        );
    },
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: ["cadences"] });
      toast.error(`couldn't update the offer · ${err.message}`);
    },
  });
}

/**
 * The offer a cadence's follow-ups restate, in the card's case column: the
 * queue's offer block, writing to the sequence. Read-only when the first
 * email carried it.
 */
export function SequenceOffer({
  cadence,
  locked = false,
}: {
  cadence: CadenceView;
  /** The page is redrafting the step: an offer change now would race it. */
  locked?: boolean;
}) {
  const change = useSequenceOfferChange(cadence);
  const activity = useRowActivity(sequenceOfferActivityId(cadence));
  const view = cadence.offer;
  if (!view) return null;
  const { offer, candidates } = sequenceOfferViews(view);
  const editable = sequenceOfferEditable(cadence);
  const pending = change.isPending ? change.variables : undefined;
  return (
    <OfferBlock
      activityId={sequenceOfferActivityId(cadence)}
      offer={offer}
      candidates={candidates}
      editable={editable}
      change={{
        run: (body, done) => change.mutate(body, { onSuccess: done }),
        pending: pending && !("approveWeak" in pending) ? pending : undefined,
      }}
      companyPages={hasCompanyPagesInPayload(cadence.queuePayload)}
      emptyNote="No offer yet. One is written from the sent row's research, the thread so far and your product brief."
      note={sequenceOfferNote(view)}
      locked={locked}
      actions={
        editable && view.weak ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={change.isPending || activity != null || locked}
            onClick={() => change.mutate({ approveWeak: true })}
            title="Send the follow-ups with this offer as it stands, although it was rated a weak fit"
            {...readOnly}
          >
            {pending && "approveWeak" in pending ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Check size={11} />
            )}
            Approve offer
          </Button>
        ) : null
      }
    />
  );
}

/** The letter's Next offer: the sequence's next ranked offer, then a redraft around it. */
export function NextSequenceOfferButton({
  cadence,
  locked = false,
}: {
  cadence: CadenceView;
  locked?: boolean;
}) {
  const change = useSequenceOfferChange(cadence);
  const activity = useRowActivity(sequenceOfferActivityId(cadence));
  const view = cadence.offer;
  if (!view || view.founderEdited || !sequenceOfferEditable(cadence)) return null;
  const { offer, candidates } = sequenceOfferViews(view);
  const next = nextOfferIndex(offer, candidates);
  if (next == null || candidates.length < 2) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={change.isPending || activity != null || locked}
      onClick={() => change.mutate({ select: next })}
      title="Use the sequence's next offer and redraft the step around it"
      {...readOnly}
    >
      {change.isPending ? <Loader2 size={11} className="animate-spin" /> : <RotateCw size={11} />}
      {change.isPending ? "Switching…" : "Next offer"}
    </Button>
  );
}
