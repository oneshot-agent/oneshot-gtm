/**
 * What the reject box opens with.
 *
 * A row already carries the best first draft of a rejection reason, in one
 * of two places, and until this the box was always empty:
 *
 *  - the person gate's verdict reason, when the verdict was `reject` or
 *    `unclear`. That sentence is literally "why they don't fit", which is
 *    exactly why `stampFitReason` refuses to promote it to the fit line;
 *  - the finder's own note, once the machine prefix is gone, but only a
 *    machine negative (`auto: …`). A finder note without the prefix is
 *    provenance ("Bruno going to Corgi Founders Breakfast Club"), not a
 *    reason, and prefilling it hid the one tier that reads the dossier:
 *    the box opened with the event name and the LLM fallback never ran.
 *
 * The prefix matters: `auto:` is how `isAutoRejected` in score-prospects and
 * the pre-v26 `isHumanDecision` arm tell a machine negative from a human one,
 * and they read `notes` unconditionally. A human who re-saves an `auto: …`
 * note verbatim has just mislabeled their own decision, so the prefix never
 * survives into the box, and the server refuses it on the way back.
 */

import { FIT_DECISION_REASONS, type DecisionReason } from "@oneshot-gtm/shared-types";

export type RejectReasonSource = "person-gate" | "notes" | null;

/**
 * The one question the reject box asks: why. Each answer is a structured
 * reason (#813). Only the fit judgments teach the ICP; the rest say the person
 * was fine and the moment, the draft, or an existing relationship was not.
 */
const teaches = (value: DecisionReason): boolean => FIT_DECISION_REASONS.includes(value);
export const REJECT_DECISION_REASONS: ReadonlyArray<{
  value: DecisionReason;
  label: string;
  teachesIcp: boolean;
}> = [
  { value: "wrong_audience", label: "Not our audience", teachesIcp: teaches("wrong_audience") },
  { value: "wrong_person", label: "Wrong person", teachesIcp: teaches("wrong_person") },
  { value: "bad_timing", label: "Bad timing", teachesIcp: teaches("bad_timing") },
  {
    value: "already_contacted",
    label: "Already in touch",
    teachesIcp: teaches("already_contacted"),
  },
  { value: "draft_problem", label: "Draft problem", teachesIcp: teaches("draft_problem") },
  { value: "other", label: "Other", teachesIcp: teaches("other") },
];

/** What picking a category does, in the founder's terms. */
export function decisionReasonEffect(reason: DecisionReason | "" | null | undefined): string {
  if (!reason) return "Pick one, or reject without a reason.";
  return REJECT_DECISION_REASONS.find((r) => r.value === reason)?.teachesIcp
    ? "Counts as ICP evidence: the tool learns who you don't sell to."
    : "Doesn't affect the ICP.";
}

/**
 * One-tap detail under each category: appended to the note, so the common
 * specifics never need typing.
 */
export const REJECT_DETAIL_CHIPS: Partial<Record<DecisionReason, readonly string[]>> = {
  wrong_audience: ["wrong stage", "wrong industry", "no real product yet", "competitor"],
  wrong_person: ["not the buyer", "too junior", "left the company"],
  bad_timing: ["too early", "revisit next quarter"],
  already_contacted: ["emailed before", "already a customer", "talking elsewhere"],
};

/**
 * The category a few typed words belong to, or null when they name none.
 * Covers every detail chip and the phrases founders actually type; anything
 * else is left to the model, never guessed here. Order matters: a relationship
 * or a timing phrase wins over a fit word that happens to share the sentence.
 */
const TEXT_RULES: ReadonlyArray<readonly [RegExp, DecisionReason]> = [
  [
    /\b(already|previously)\s+(contacted|emailed|messaged|pitched|reached|in touch|a customer|talking|spoke|spoken)\b|\b(emailed|contacted|messaged|reached out)\s+(before|already|earlier)\b|\bexisting customer\b|\balready (a |our )?(customer|client|user)\b|\btalking elsewhere\b|\bduplicate\b|\bknow (him|her|them)\b/i,
    "already_contacted",
  ],
  [
    /\bdraft\b|\bcopy\b|\b(bad|wrong|weak) (email|angle|hook|subject)\b|\brewrite\b|\btypo\b/i,
    "draft_problem",
  ],
  [
    /\btoo early\b|\bbad timing\b|\bnot (right )?now\b|\blater\b|\bnext (quarter|month|year)\b|\brevisit\b|\bjust raised\b|\bmid[- ]raise\b/i,
    "bad_timing",
  ],
  [
    /\bnot the (buyer|decision[- ]maker|right person)\b|\bwrong (person|role|contact)\b|\btoo junior\b|\bleft the company\b|\b(recruiter|investor|intern|student|assistant|event host|consultant)\b/i,
    "wrong_person",
  ],
  [
    /\bwrong (stage|industry|audience|market|segment|size)\b|\bno (real )?product\b|\bcompetitor\b|\btoo (big|large|small|late[- ]stage|mature)\b|\bnot (our|the) (audience|icp|customer|market)\b|\b(b2c|consumer)\b/i,
    "wrong_audience",
  ],
];

export function decisionReasonForText(text: string | null | undefined): DecisionReason | null {
  const t = str(text);
  if (!t) return null;
  for (const [pattern, reason] of TEXT_RULES) if (pattern.test(t)) return reason;
  return null;
}

export interface RejectReasonSuggestion {
  text: string;
  source: RejectReasonSource;
  /** The category the prefill implies, when its source names one. */
  decisionReason: DecisionReason | null;
}

/** The flat one-tap list, for surfaces that record a note without a category. */
export const REJECT_REASON_CHIPS = [
  "wrong stage",
  "wrong industry",
  "not the buyer",
  "already a customer",
  "competitor",
  "no real product yet",
] as const;

/** Anything shorter than this after stripping is a token, not a reason. */
const MIN_REASON_CHARS = 8;

/**
 * `auto: role — x`, `auto: ICP — YC W26 — x`, `auto: dedup — not re-sent`:
 * the gate name (one word, when there is one) and, for the cohort gate, the
 * cohort label, come off; the sentence stays.
 */
const AUTO_PREFIX = /^auto:\s*(?:[a-z][\w-]{0,14}\s*[—-]\s*)?/i;
const COHORT_LABEL = /^[A-Z][\w .]{1,40}?\s+[—-]\s+/;

/** The gates' pass-through strings. Never a reason. Mirrors `_fit-reason.ts`. */
const NOT_A_REASON = new Set([
  "no icp set; pass-through",
  "no role text available",
  "no role text at discovery; deferred to enrichment",
  "classifier unavailable pre-spend; deferred",
  "no role text in any tier",
]);
const DIAGNOSTIC =
  /^(?:fill-the-gap enrichment|product research unavailable|no role text|classifier unavailable|no icp set|csv import)\b/i;

function str(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

/**
 * A machine negative with its prefix removed, or "" when the note is not one.
 * Only `auto:` notes are reasons; anything else on a pending or approved row
 * is the finder's provenance line, which the LLM tier reads as evidence
 * instead of the founder reading it as a verdict.
 */
export function reasonFromNotes(notes: string | null | undefined): string {
  let s = str(notes);
  if (!s || !AUTO_PREFIX.test(s)) return "";
  s = s.replace(AUTO_PREFIX, "").replace(COHORT_LABEL, "").trim();
  if (s.length < MIN_REASON_CHARS || NOT_A_REASON.has(s.toLowerCase()) || DIAGNOSTIC.test(s)) {
    return "";
  }
  return s;
}

export function suggestRejectReason(input: {
  payload: unknown;
  notes: string | null | undefined;
  /** The prospect-level verdict reason, when the caller has the detail row. */
  icpVerdictReason?: string | null;
}): RejectReasonSuggestion {
  const p =
    input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
      ? (input.payload as Record<string, unknown>)
      : {};
  const verdict = str(p["icpVerdict"]).toLowerCase();
  if (verdict === "reject" || verdict === "unclear") {
    const reason = str(p["icpVerdictReason"]) || str(input.icpVerdictReason);
    if (reason.length >= MIN_REASON_CHARS && !DIAGNOSTIC.test(reason)) {
      // The person gate judges the role, so its "no" is about the person.
      return { text: reason, source: "person-gate", decisionReason: "wrong_person" };
    }
  }
  const fromNotes = reasonFromNotes(input.notes);
  if (fromNotes) {
    return {
      text: fromNotes,
      source: "notes",
      decisionReason: decisionReasonFromGate(input.notes),
    };
  }
  return { text: "", source: null, decisionReason: null };
}

/**
 * The category a machine note's gate implies: `auto: ICP — …` is the company
 * check, `auto: role — …` the person check, `auto: dedup — …` a known contact.
 */
function decisionReasonFromGate(notes: string | null | undefined): DecisionReason | null {
  const gate = /^auto:\s*([a-z][\w-]{0,14})\s*[—-]/i.exec(str(notes))?.[1]?.toLowerCase();
  if (gate === "icp") return "wrong_audience";
  if (gate === "role") return "wrong_person";
  if (gate === "dedup" || gate === "dedupe") return "already_contacted";
  return null;
}

/**
 * `current` + a chip, joined with `; `; a chip already present is not
 * repeated. A sentence's closing period comes off before the joiner:
 * "owns acquisition; not the buyer", not "acquisition.; not the buyer".
 */
export function appendReason(current: string, chip: string): string {
  const base = current.trim();
  if (!base) return chip;
  const parts = base.split(/;\s*/).map((s) => s.trim().replace(/\.$/, "").toLowerCase());
  if (parts.includes(chip.toLowerCase())) return base;
  return `${base.replace(/[.;\s]+$/, "")}; ${chip}`;
}

/** What the founder has done by hand in the box so far. */
export interface RejectBoxTouched {
  /** They typed in the note or tapped a detail chip. */
  note: boolean;
  /** They tapped a category chip. */
  category: boolean;
}

/**
 * What a model reply may change in the reject box. The founder's own input
 * always wins: a hand-edited note is never replaced, and a category they
 * tapped is never moved. A reply to "write the note for the category I
 * picked" (`askedFor`) only applies while that category is still the one
 * selected.
 */
export function mergeRejectSuggestion(input: {
  current: { reason: string; decisionReason: DecisionReason | "" };
  touched: RejectBoxTouched;
  reply: { reason: string | null; decisionReason: DecisionReason | null };
  /** The category the request was made for, when it was a category tap. */
  askedFor?: DecisionReason | null;
}): { reason?: string; decisionReason?: DecisionReason } {
  const { current, touched, reply, askedFor } = input;
  if (askedFor && current.decisionReason !== askedFor) return {};
  const patch: { reason?: string; decisionReason?: DecisionReason } = {};
  if (reply.reason && !touched.note) patch.reason = reply.reason;
  if (reply.decisionReason && !touched.category && !current.decisionReason) {
    patch.decisionReason = reply.decisionReason;
  }
  return patch;
}
