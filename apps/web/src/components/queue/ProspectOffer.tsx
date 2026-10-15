import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../../api/client.ts";
import { usePrivacy } from "../../lib/privacy.tsx";
import { Button } from "../primitives/Button.tsx";
import { Textarea } from "../primitives/Field.tsx";
import { Disclosure } from "../ledger/CaseList.tsx";

interface OfferView {
  offer: string;
  steps: string;
  evidence: string[];
  stage: string;
  level: "researched" | "role";
  editedBy?: "founder";
}

/** The prospect offer stored on a queue payload, when it has one. */
export function offerFromPayload(payload: unknown): OfferView | null {
  if (!payload || typeof payload !== "object") return null;
  const o = (payload as Record<string, unknown>)["offer"];
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (typeof r["offer"] !== "string" || !r["offer"].trim()) return null;
  return {
    offer: r["offer"],
    steps: typeof r["steps"] === "string" ? r["steps"] : "",
    evidence: Array.isArray(r["evidence"])
      ? r["evidence"].filter((e): e is string => typeof e === "string")
      : [],
    stage: typeof r["stage"] === "string" ? r["stage"] : "",
    level: r["level"] === "role" ? "role" : "researched",
    ...(r["editedBy"] === "founder" ? { editedBy: "founder" as const } : {}),
  };
}

/**
 * The offer the letter opens with: what the product would deliver for this
 * firm, written from the row's research. The founder can rewrite it or ask
 * for a new one; either way the draft is regenerated around it.
 */
export function ProspectOffer({
  rowId,
  payload,
  editable,
}: {
  rowId: number;
  payload: unknown;
  /** False once the row is sent or sending. */
  editable: boolean;
}) {
  const { masked } = usePrivacy();
  const qc = useQueryClient();
  const offer = offerFromPayload(payload);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(offer?.offer ?? "");

  const apply = useMutation({
    mutationFn: async (body: { offer: string } | { regenerate: true }) => {
      await api.setQueueOffer(rowId, body);
      try {
        await api.regenerateDraft(rowId);
        return { redrafted: true as const };
      } catch (err) {
        return { redrafted: false as const, message: (err as Error).message };
      }
    },
    onSuccess: (result) => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ["queue"] });
      if (result.redrafted) toast.success("offer saved · draft rewritten around it, not sent");
      else
        toast.error(
          `offer saved, but the draft still carries the old one · ${result.message}. Regenerate the draft.`,
        );
    },
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: ["queue"] });
      toast.error(`couldn't update the offer · ${err.message}`);
    },
  });

  if (masked) return null;
  if (!offer && !editable) return null;

  return (
    <section aria-label="Offer" className="min-w-0">
      <div className="mb-1 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-faint">
        <span>offer</span>
        {offer?.level === "role" && !offer.editedBy && <span>· from role only</span>}
        {offer?.editedBy === "founder" && <span>· yours</span>}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            aria-label="Offer for this prospect"
          />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              disabled={apply.isPending || !text.trim()}
              onClick={() => apply.mutate({ offer: text.trim() })}
            >
              {apply.isPending ? "rewriting…" : "Save and redraft"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : offer ? (
        <p className="m-0 text-[13px] leading-5 text-ink-cream [text-wrap:pretty]">{offer.offer}</p>
      ) : (
        <p className="m-0 text-[12px] leading-5 text-ink-muted">
          No offer yet. It is written from the row's research and your product brief.
        </p>
      )}
      {offer && !editing && (offer.steps || offer.evidence.length > 0) && (
        <Disclosure label="How and why" className="mt-2">
          <div className="mt-2 flex flex-col gap-2 border-l border-ink-rule pl-3 text-[12px] leading-5">
            {offer.steps && <p className="m-0 text-ink-cream-2">How: {offer.steps}</p>}
            {offer.stage && <p className="m-0 text-ink-muted">Stage: {offer.stage}</p>}
            {offer.evidence.map((e) => (
              <p key={e} className="m-0 text-ink-muted [overflow-wrap:anywhere]">
                “{e}”
              </p>
            ))}
          </div>
        </Disclosure>
      )}
      {editable && !editing && (
        <div className="mt-2 flex gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setText(offer?.offer ?? "");
              setEditing(true);
            }}
          >
            Edit offer
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={apply.isPending}
            onClick={() => apply.mutate({ regenerate: true })}
          >
            {apply.isPending ? "writing…" : "New offer"}
          </Button>
        </div>
      )}
    </section>
  );
}
