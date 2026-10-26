import { useState, type ReactNode } from "react";
import { Check, Loader2, RotateCw } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../../api/client.ts";
import { usePrivacy } from "../../lib/privacy.tsx";
import { offersNearDuplicate, type OfferSkipView } from "@oneshot-gtm/shared-types";
import { cn } from "../../lib/cn.ts";
import { offerSkipLine } from "../../lib/offerSkip.ts";
import { readOnly } from "../../lib/readOnly.ts";
import { clearDraftGenerating, markDraftGenerating } from "../../lib/draftRunState.ts";
import {
  clearRowActivity,
  setRowActivity,
  useRowActivity,
  type RowActivityId,
} from "../../lib/rowActivity.ts";
import { Button } from "../primitives/Button.tsx";
import { Textarea } from "../primitives/Field.tsx";
import { Disclosure } from "../ledger/CaseList.tsx";

export interface OfferView {
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
  /** The founder approved it although it was rated a weak fit. */
  weakApproved?: boolean;
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
    ...(typeof r["weakApprovedAt"] === "string" && r["weakApprovedAt"].trim()
      ? { weakApproved: true }
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

/**
 * Start at the first candidate when the active offer is no longer in the
 * list. A candidate the judge rated a weak fit is passed over for the next
 * one that is not, and a candidate that is the active offer reworded
 * (`offersNearDuplicate`) is skipped; when every other candidate is one or
 * the other, Next goes through them in order. Picking one by hand still
 * reaches any of them.
 */
export function nextOfferIndex(
  offer: Pick<OfferView, "offer"> | null,
  candidates: readonly Pick<OfferView, "offer" | "relevance">[],
): number | null {
  if (candidates.length === 0) return null;
  const activeIndex = candidates.findIndex((candidate) => candidate.offer === offer?.offer);
  const next = (activeIndex + 1) % candidates.length;
  const order: number[] = [];
  for (let step = 1; step <= candidates.length; step++) {
    const i = (activeIndex + step) % candidates.length;
    if (i === activeIndex) continue;
    if (offer && offersNearDuplicate(offer.offer, candidates[i]!.offer)) continue;
    order.push(i);
  }
  return order.find((i) => candidates[i]!.relevance !== "weak") ?? order[0] ?? next;
}

/** One change to an offer, the body both offer routes take. */
export type OfferChange =
  | { offer: string; return?: string }
  | { regenerate: true }
  | { select: number };

/** What an offer change is doing, in words: the letter's working line shows it. */
export function offerChangeLabel(body: OfferChange): string {
  return "regenerate" in body
    ? "Writing 5 offers and their angles…"
    : "select" in body
      ? `Switching to offer ${body.select + 1}…`
      : "Saving your offer…";
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
  skip = null,
}: {
  rowId: number;
  payload: unknown;
  /** False once the row is sent or sending. */
  editable: boolean;
  /** The writer declined to write one: its reason (`QueueRowView.offerSkip`). */
  skip?: OfferSkipView | null;
}) {
  const qc = useQueryClient();
  const apply = useMutation({
    mutationFn: async (body: OfferChange) => {
      // Name each step as it runs: the letter shows it, and the offer block
      // locks its controls until it ends (rowActivity.ts).
      const token = setRowActivity(rowId, offerChangeLabel(body));
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
  // Approving a weak offer releases the send hold; the draft stands as it is.
  const approve = useMutation({
    mutationFn: async () => {
      const token = setRowActivity(rowId, "Approving the offer…");
      try {
        await api.setQueueOffer(rowId, { approveWeak: true });
      } finally {
        clearRowActivity(rowId, token);
      }
    },
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
    <OfferBlock
      activityId={rowId}
      offer={offerFromPayload(payload)}
      candidates={offerCandidatesFromPayload(payload)}
      editable={editable}
      change={{
        run: (body, done) => apply.mutate(body, { onSuccess: done }),
        pending: apply.isPending ? apply.variables : undefined,
      }}
      companyPages={hasCompanyPagesInPayload(payload)}
      emptyNote={
        skip
          ? offerSkipLine(skip)
          : "No offer yet. It is written from the row's research and your product brief."
      }
      approve={{
        run: () => approve.mutate(),
        pending: approve.isPending,
        title: "Send this offer as it stands, although it was rated a weak fit",
      }}
    />
  );
}

/** A weak-fit offer the founder has not approved, written or replaced yet: it holds the send. */
function offerAwaitsApproval(
  offer: Pick<OfferView, "relevance" | "weakApproved" | "editedBy"> | null,
): boolean {
  return offer?.relevance === "weak" && !offer.weakApproved && !offer.editedBy;
}

/** The offer block's small mono label: its meta line and each listed offer's tags. */
const EYEBROW = "font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-faint";

/**
 * The header's tokens, in reading order: which offer of the set, how the
 * judge rated it, where it came from. "Offer 1 of 5 · weak fit · from role only".
 */
export function offerMetaTokens(offer: OfferView | null, candidates: OfferView[]): string[] {
  const activeIndex = offer ? candidates.findIndex((c) => c.offer === offer.offer) : -1;
  return [
    activeIndex >= 0 && candidates.length > 1
      ? `offer ${activeIndex + 1} of ${candidates.length}`
      : "offer",
    offer?.relevance === "weak" && !offer.editedBy
      ? offer.weakApproved
        ? "weak fit, approved"
        : "weak fit"
      : null,
    offer?.editedBy === "founder" ? "yours" : offer?.level === "role" ? "from role only" : null,
  ].filter((t): t is string => t !== null);
}

/**
 * The offer block itself, whoever stores the offer: a queue row
 * (`ProspectOffer`) or a cadence's sequence (`SequenceOffer`). Every offer
 * action lives here: Edit offer, Next offer, New offers, Approve offer. The
 * owner runs the change; any work on `activityId` locks every control until
 * it ends, so two changes never race. The work is named once, on the
 * letter's working line, where its result lands.
 */
export function OfferBlock({
  activityId,
  offer,
  candidates,
  editable,
  change,
  companyPages,
  emptyNote,
  note,
  approve,
  locked = false,
}: {
  activityId: RowActivityId;
  offer: OfferView | null;
  candidates: OfferView[];
  /** False when the offer can no longer change. */
  editable: boolean;
  /** Runs one change; `done` closes the editor once it lands. */
  change: { run: (body: OfferChange, done: () => void) => void; pending: OfferChange | undefined };
  /** The research behind it holds text read from the company's own pages. */
  companyPages: boolean;
  /** What the block says while there is no offer. */
  emptyNote: string;
  /** A line under the offer: why it cannot change, say. */
  note?: ReactNode;
  /** Approve offer, shown while the active offer is a weak fit nobody approved. */
  approve?: { run: () => void; pending: boolean; title: string } | null;
  /** Other work on the letter the offer must not race (a redraft the page started). */
  locked?: boolean;
}) {
  const { masked } = usePrivacy();
  const activeIndex = offer ? candidates.findIndex((c) => c.offer === offer.offer) : -1;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(offer?.offer ?? "");
  const [returnText, setReturnText] = useState(offer?.return ?? "");

  const activity = useRowActivity(activityId);
  const pendingBody = change.pending;
  const busy = pendingBody !== undefined || approve?.pending === true || activity != null || locked;
  const writingNew = !!pendingBody && "regenerate" in pendingBody;
  const switchingTo = pendingBody && "select" in pendingBody ? pendingBody.select : null;
  // A founder's own offer is not in the ranked set: there is no next one to rotate to.
  const next =
    candidates.length > 1 && offer?.editedBy !== "founder"
      ? nextOfferIndex(offer, candidates)
      : null;
  const apply = (body: OfferChange): void => change.run(body, () => setEditing(false));

  if (masked) return null;
  if (!offer && !editable && !note) return null;

  return (
    <section aria-label="Offer" className="min-w-0">
      <div className={cn("mb-1 flex flex-wrap gap-x-2 gap-y-1", EYEBROW)}>
        {offerMetaTokens(offer, candidates).map((token, i) => (
          <span key={token} className="whitespace-nowrap">
            {i === 0 ? token : `· ${token}`}
          </span>
        ))}
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
                apply({
                  offer: text.trim(),
                  ...(returnText.trim() ? { return: returnText.trim() } : {}),
                })
              }
            >
              {pendingBody && "offer" in pendingBody && (
                <Loader2 size={11} className="animate-spin" />
              )}
              Save and redraft
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
          {!offer.editedBy && !companyPages && (
            <p className="m-0 mt-1 text-[11.5px] leading-5 text-ink-faint">
              written without the company's site
            </p>
          )}
        </>
      ) : (
        <p className="m-0 text-[12px] leading-5 text-ink-muted">{emptyNote}</p>
      )}
      {note && !editing && (
        <p className="m-0 mt-1 text-[11.5px] leading-5 text-ink-faint">{note}</p>
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
                    <span className={EYEBROW}>
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
                        onClick={() => apply({ select: i })}
                      >
                        {switchingTo === i && <Loader2 size={11} className="animate-spin" />}
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
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setText(offer?.offer ?? "");
              setReturnText(offer?.return ?? "");
              setEditing(true);
            }}
            {...readOnly}
          >
            Edit offer
          </Button>
          {next != null && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => apply({ select: next })}
              title="Use the next offer and rewrite the draft around it"
              {...readOnly}
            >
              {switchingTo === next ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <RotateCw size={11} />
              )}
              Next offer
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => apply({ regenerate: true })}
            {...readOnly}
          >
            {writingNew && <Loader2 size={11} className="animate-spin" />}
            New offers
          </Button>
          {approve && offerAwaitsApproval(offer) && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={approve.run}
              title={approve.title}
              {...readOnly}
            >
              {approve.pending ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Check size={11} />
              )}
              Approve offer
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
