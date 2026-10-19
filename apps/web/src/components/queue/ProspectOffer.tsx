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
  /** What the firm gets back when the job is done. */
  return: string;
  /** Reasons it pays back: the letter's angles. */
  angles: string[];
  editedBy?: "founder";
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : [];
}

function readOffer(o: unknown): OfferView | null {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (typeof r["offer"] !== "string" || !r["offer"].trim()) return null;
  return {
    offer: r["offer"],
    steps: typeof r["steps"] === "string" ? r["steps"] : "",
    evidence: strings(r["evidence"]),
    stage: typeof r["stage"] === "string" ? r["stage"] : "",
    level: r["level"] === "role" ? "role" : "researched",
    return: typeof r["return"] === "string" ? r["return"] : "",
    angles: strings(r["angles"]),
    ...(r["editedBy"] === "founder" ? { editedBy: "founder" as const } : {}),
  };
}

/** The prospect offer stored on a queue payload, when it has one. */
export function offerFromPayload(payload: unknown): OfferView | null {
  if (!payload || typeof payload !== "object") return null;
  return readOffer((payload as Record<string, unknown>)["offer"]);
}

/** The ranked offers written for the row (the active one among them), best return first. */
export function offerCandidatesFromPayload(payload: unknown): OfferView[] {
  if (!payload || typeof payload !== "object") return [];
  const list = (payload as Record<string, unknown>)["offerCandidates"];
  return Array.isArray(list) ? list.map(readOffer).filter((o): o is OfferView => o !== null) : [];
}

/** Start at the first candidate when the active offer is no longer in the list. */
export function nextOfferIndex(
  offer: Pick<OfferView, "offer"> | null,
  candidates: readonly Pick<OfferView, "offer">[],
): number | null {
  if (candidates.length === 0) return null;
  const activeIndex = candidates.findIndex((candidate) => candidate.offer === offer?.offer);
  return (activeIndex + 1) % candidates.length;
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
  const candidates = offerCandidatesFromPayload(payload);
  const activeIndex = offer ? candidates.findIndex((c) => c.offer === offer.offer) : -1;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(offer?.offer ?? "");
  const [returnText, setReturnText] = useState(offer?.return ?? "");

  const apply = useMutation({
    mutationFn: async (
      body: { offer: string; return?: string } | { regenerate: true } | { select: number },
    ) => {
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
        {activeIndex >= 0 && candidates.length > 1 && (
          <span>
            · {activeIndex + 1} of {candidates.length}
          </span>
        )}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            aria-label="Offer for this prospect"
          />
          <Textarea
            value={returnText}
            onChange={(e) => setReturnText(e.target.value)}
            rows={1}
            placeholder="What they get back, and how they'd count it"
            aria-label="What the offer returns"
          />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              disabled={apply.isPending || !text.trim()}
              onClick={() =>
                apply.mutate({
                  offer: text.trim(),
                  ...(returnText.trim() ? { return: returnText.trim() } : {}),
                })
              }
            >
              {apply.isPending ? "rewriting…" : "Save and redraft"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : offer ? (
        <>
          <p className="m-0 text-[13px] leading-5 text-ink-cream [text-wrap:pretty]">
            {offer.offer}
          </p>
          {offer.return && (
            <p className="m-0 mt-1 text-[12px] leading-5 text-ink-muted [text-wrap:pretty]">
              Returns: {offer.return}
            </p>
          )}
        </>
      ) : (
        <p className="m-0 text-[12px] leading-5 text-ink-muted">
          No offer yet. It is written from the row's research and your product brief.
        </p>
      )}
      {offer &&
        !editing &&
        (offer.steps || offer.evidence.length > 0 || offer.angles.length > 0) && (
          <Disclosure label="How and why" className="mt-2">
            <div className="mt-2 flex flex-col gap-2 border-l border-ink-rule pl-3 text-[12px] leading-5">
              {offer.steps && <p className="m-0 text-ink-cream-2">How: {offer.steps}</p>}
              {offer.angles.length > 0 && (
                <div className="flex flex-col gap-1">
                  <p className="m-0 text-ink-muted">Why it pays back, one per touch:</p>
                  <ol className="m-0 list-decimal pl-5 text-ink-cream-2">
                    {offer.angles.map((a) => (
                      <li key={a} className="[overflow-wrap:anywhere]">
                        {a}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {offer.stage && <p className="m-0 text-ink-muted">Stage: {offer.stage}</p>}
              {offer.evidence.map((e) => (
                <p key={e} className="m-0 text-ink-muted [overflow-wrap:anywhere]">
                  “{e}”
                </p>
              ))}
            </div>
          </Disclosure>
        )}
      {!editing && candidates.length > 1 && (
        <Disclosure label={`Other offers (${candidates.length - 1})`} className="mt-2">
          <ol className="m-0 mt-2 flex list-none flex-col gap-2 border-l border-ink-rule pl-3 text-[12px] leading-5">
            {candidates.map((c, i) =>
              i === activeIndex ? null : (
                <li key={c.offer} className="flex flex-col gap-1">
                  <span className="text-ink-cream-2 [text-wrap:pretty]">
                    {i + 1}. {c.offer}
                  </span>
                  {c.return && <span className="text-ink-muted">Returns: {c.return}</span>}
                  {editable && (
                    <span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={apply.isPending}
                        onClick={() => apply.mutate({ select: i })}
                      >
                        Use this offer
                      </Button>
                    </span>
                  )}
                </li>
              ),
            )}
          </ol>
        </Disclosure>
      )}
      {editable && !editing && (
        <div className="mt-2 flex gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setText(offer?.offer ?? "");
              setReturnText(offer?.return ?? "");
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
            {apply.isPending ? "writing…" : "New offers"}
          </Button>
        </div>
      )}
    </section>
  );
}
