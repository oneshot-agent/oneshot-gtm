import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../../api/client.ts";
import { usePrivacy } from "../../lib/privacy.tsx";
import { cn } from "../../lib/cn.ts";
import { clearDraftGenerating, markDraftGenerating } from "../../lib/draftRunState.ts";
import { clearRowActivity, setRowActivity, useRowActivity } from "../../lib/rowActivity.ts";
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
  /** The anchor the offer rests on and the fact behind it. */
  fit?: string;
  /** The relevance judge's label; `weak` ones only make up the five. */
  relevance?: "relevant" | "weak" | "irrelevant";
  /** 0–1: the judge's probability that it is relevant. */
  relevanceScore?: number;
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
    ...(typeof r["fit"] === "string" && r["fit"].trim() ? { fit: r["fit"] } : {}),
    ...(r["relevance"] === "relevant" ||
    r["relevance"] === "weak" ||
    r["relevance"] === "irrelevant"
      ? { relevance: r["relevance"] }
      : {}),
    ...(typeof r["relevanceScore"] === "number" && Number.isFinite(r["relevanceScore"])
      ? { relevanceScore: r["relevanceScore"] }
      : {}),
  };
}

/** "fit 4/5" from the judge's score, "relevant" when it gave only a label. */
export function offerFitLabel(o: Pick<OfferView, "relevance" | "relevanceScore">): string | null {
  if (o.relevanceScore !== undefined) {
    return `fit ${Math.min(5, Math.max(0, Math.round(o.relevanceScore * 5)))}/5`;
  }
  return o.relevance === "relevant" ? "relevant" : null;
}

/** True when the row's research holds text read from the company's own pages. */
export function hasCompanyPagesInPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const research = (payload as Record<string, unknown>)["productResearch"];
  if (!research || typeof research !== "object") return false;
  const sources = (research as Record<string, unknown>)["sources"];
  return (
    Array.isArray(sources) &&
    sources.some(
      (s) =>
        !!s &&
        typeof s === "object" &&
        typeof (s as Record<string, unknown>)["excerpt"] === "string" &&
        ((s as Record<string, unknown>)["excerpt"] as string).trim().length > 0,
    )
  );
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
  // Same entries the server counts (`offerCandidatesOf`: an offer with a
  // `steps` string), so the index sent as `{ select: i }` names the same offer.
  return Array.isArray(list)
    ? list
        .filter(
          (o) =>
            !!o &&
            typeof o === "object" &&
            typeof (o as Record<string, unknown>)["steps"] === "string",
        )
        .map(readOffer)
        .filter((o): o is OfferView => o !== null)
    : [];
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

  const activity = useRowActivity(rowId);
  const apply = useMutation({
    mutationFn: async (
      body: { offer: string; return?: string } | { regenerate: true } | { select: number },
    ) => {
      // Name each step as it runs, so the offer block and the letter show
      // the same work (rowActivity.ts).
      const token = setRowActivity(
        rowId,
        "regenerate" in body
          ? "Writing 5 offers and their angles…"
          : "select" in body
            ? `Switching to offer ${body.select + 1}…`
            : "Saving your offer…",
      );
      try {
        await api.setQueueOffer(rowId, body);
        setRowActivity(rowId, "Rewriting the draft around the offer…", token);
        const stamp = markDraftGenerating(rowId);
        try {
          await api.regenerateDraft(rowId);
          return { redrafted: true as const };
        } catch (err) {
          return { redrafted: false as const, message: (err as Error).message };
        } finally {
          clearDraftGenerating(rowId, stamp);
        }
      } finally {
        clearRowActivity(rowId, token);
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

  // Any offer work on this row (here, or Next offer in the letter) locks
  // every offer control until it ends, so two changes never race.
  const busy = apply.isPending || activity != null;
  const pendingBody = apply.isPending ? apply.variables : undefined;
  const writingNew = !!pendingBody && "regenerate" in pendingBody;
  const switchingTo = pendingBody && "select" in pendingBody ? pendingBody.select : null;

  if (masked) return null;
  if (!offer && !editable) return null;

  return (
    <section aria-label="Offer" className="min-w-0">
      <div className="mb-1 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-faint">
        <span>offer</span>
        {offer?.level === "role" && !offer.editedBy && <span>· from role only</span>}
        {offer?.editedBy === "founder" && <span>· yours</span>}
        {offer?.relevance === "weak" && !offer.editedBy && <span>· weak fit</span>}
        {activity && (
          <span
            aria-hidden="true"
            className="inline-flex items-center gap-1 normal-case tracking-normal text-[color:var(--ink-receipt-2)]"
          >
            · <Loader2 size={11} className="animate-spin" /> {activity}
          </span>
        )}
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
              disabled={busy || !text.trim()}
              onClick={() =>
                apply.mutate({
                  offer: text.trim(),
                  ...(returnText.trim() ? { return: returnText.trim() } : {}),
                })
              }
            >
              {apply.isPending ? (
                <>
                  <Loader2 size={11} className="animate-spin" /> Saving…
                </>
              ) : (
                "Save and redraft"
              )}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : offer ? (
        <>
          <p
            className={cn(
              "m-0 text-[13px] leading-5 text-ink-cream transition-opacity [text-wrap:pretty]",
              busy && "opacity-50",
            )}
          >
            {offer.offer}
          </p>
          {offer.return && (
            <p className="m-0 mt-1 text-[12px] leading-5 text-ink-muted [text-wrap:pretty]">
              Returns: {offer.return}
            </p>
          )}
          {offer.fit && (
            <p className="m-0 mt-1 text-[12px] leading-5 text-ink-muted [text-wrap:pretty]">
              Fit: {offer.fit}
            </p>
          )}
          {!offer.editedBy && !hasCompanyPagesInPayload(payload) && (
            <p className="m-0 mt-1 text-[11.5px] leading-5 text-ink-faint">
              written without the company's site
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
                  {(offerFitLabel(c) || c.relevance === "weak") && (
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-faint">
                      {[offerFitLabel(c), c.relevance === "weak" ? "weak fit" : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  )}
                  {editable && (
                    <span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => apply.mutate({ select: i })}
                      >
                        {switchingTo === i ? (
                          <>
                            <Loader2 size={11} className="animate-spin" /> Switching…
                          </>
                        ) : (
                          "Use this offer"
                        )}
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
            disabled={busy}
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
            disabled={busy}
            onClick={() => apply.mutate({ regenerate: true })}
          >
            {writingNew ? (
              <>
                <Loader2 size={11} className="animate-spin" /> Writing…
              </>
            ) : (
              "New offers"
            )}
          </Button>
        </div>
      )}
    </section>
  );
}
