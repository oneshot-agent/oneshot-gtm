import { loadConfig, type QueueRow } from "@oneshot-gtm/core";
import { resolveQueueTarget } from "@oneshot-gtm/find";
import {
  isProspectOffer,
  OFFER_MAX,
  OFFER_PROMPT_VERSION,
  offerAnglesWritten,
  withOfferAngles,
  type ProspectOffer,
} from "@oneshot-gtm/plays";

/**
 * What the two offer routes share: a queue row's (queue-offer.ts) and a
 * cadence's (cadences.ts). One body, one change per request:
 * `{ approveWeak: true }`, `{ regenerate: true }`, `{ select: i }`, or the
 * founder's own `{ offer, steps?, return? }`. Where the offer is stored, and
 * what may change it, is each route's own.
 */
export interface OfferEditBody {
  offer?: unknown;
  steps?: unknown;
  return?: unknown;
  regenerate?: unknown;
  select?: unknown;
  approveWeak?: unknown;
}

/** A refused change: the message and its HTTP status. */
export interface OfferEditError {
  error: string;
  status: number;
}

export function isOfferEditError(value: unknown): value is OfferEditError {
  return (
    !!value && typeof value === "object" && typeof (value as OfferEditError).error === "string"
  );
}

/** The request's JSON object body (an empty body is `{}`); null when it is not one. */
export async function readOfferEditBody(req: Request): Promise<OfferEditBody | null> {
  try {
    const raw = await req.text();
    const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as OfferEditBody;
  } catch {
    return null;
  }
}

/**
 * The row's payload with the trigger's edge, not the current offer's angles:
 * new angles take the founder's as material. Null when it is not a JSON object.
 */
export function offerTarget(
  row: Pick<QueueRow, "payload_json" | "source">,
): Record<string, unknown> | null {
  try {
    const target = resolveQueueTarget(row, { offerAngles: false });
    return target && typeof target === "object" && !Array.isArray(target)
      ? (target as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

interface OfferInput {
  target: Record<string, unknown>;
  playName: string;
}

/**
 * `{ select: i }`: the i-th offer (0-based) made active, its angles written
 * if it has none yet, and the list with that copy in its place. `owner`
 * names what holds the offers in the 400 ("row", "sequence").
 */
export async function selectOfferCandidate(
  candidates: ProspectOffer[],
  select: unknown,
  input: OfferInput,
  owner: string,
): Promise<{ offer: ProspectOffer; candidates: ProspectOffer[] } | OfferEditError> {
  const index = typeof select === "number" ? select : Number.NaN;
  const chosen = Number.isInteger(index) ? candidates[index] : undefined;
  if (!chosen) return { error: `no offer #${String(select)} on this ${owner}`, status: 400 };
  const offer = offerAnglesWritten(chosen) ? chosen : await withOfferAngles(chosen, input);
  return { offer, candidates: candidates.map((c, i) => (i === index ? offer : c)) };
}

/**
 * `{ offer, steps?, return? }`: the founder's text as an offer of theirs,
 * never re-derived after this, with angles written for it. The old offer's
 * steps and evidence were reasoning for a different offer; the founder's
 * text stands on its own unless they give steps.
 */
export async function founderOffer(
  body: OfferEditBody,
  input: OfferInput,
): Promise<ProspectOffer | OfferEditError> {
  const text = typeof body.offer === "string" ? body.offer.trim() : "";
  if (!text) return { error: "offer must be a non-empty string", status: 400 };
  if (text.length > OFFER_MAX.offer * 2) {
    return { error: `offer is over ${OFFER_MAX.offer * 2} characters`, status: 400 };
  }
  // Same rule as a written offer: none without a brief to ground it.
  if (!loadConfig().productBrief?.trim()) {
    return { error: "No offer can be used without a product brief.", status: 422 };
  }
  const ret = typeof body.return === "string" ? body.return.trim() : "";
  if (ret.length > OFFER_MAX.return * 2) {
    return { error: `return is over ${OFFER_MAX.return * 2} characters`, status: 400 };
  }
  return await withOfferAngles(
    {
      offer: text,
      steps: typeof body.steps === "string" ? body.steps.trim() : "",
      evidence: [],
      stage: "",
      level: "role",
      ...(ret ? { return: ret } : {}),
      version: OFFER_PROMPT_VERSION,
      inputHash: "founder",
      editedBy: "founder",
      derivedAt: new Date().toISOString(),
    },
    input,
  );
}

/**
 * `{ approveWeak: true }`: the approval stamp for the stored active offer,
 * and the guards that bind it to the offer read here (offer key → value as
 * stored, null: absent), so an offer that became active meanwhile is never
 * approved. Only the active offer carries it: its copy among the candidates
 * stays unapproved, so switching away and back asks again. Null when the
 * offer is not held as a weak fit.
 */
export function weakApproval(stored: unknown): {
  approved: ProspectOffer;
  stamp: { weakApprovedAt: string };
  expect: Record<string, string | null>;
} | null {
  const offer = isProspectOffer(stored) ? stored : null;
  if (!offer || offer.relevance !== "weak" || offer.editedBy === "founder") return null;
  const weakApprovedAt = new Date().toISOString();
  const text = (key: string): string | null => {
    const v = (offer as unknown as Record<string, unknown>)[key];
    return typeof v === "string" ? v : null;
  };
  return {
    approved: { ...offer, weakApprovedAt },
    stamp: { weakApprovedAt },
    expect: {
      offer: offer.offer,
      derivedAt: text("derivedAt"),
      inputHash: text("inputHash"),
      relevance: "weak",
      editedBy: null,
    },
  };
}
