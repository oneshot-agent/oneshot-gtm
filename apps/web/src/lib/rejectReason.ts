/**
 * What the reject box opens with.
 *
 * A row already carries the best first draft of a rejection reason, in one
 * of two places, and until this the box was always empty:
 *
 *  - the person gate's verdict reason, when the verdict was `reject` or
 *    `unclear` — that sentence is literally "why they don't fit", which is
 *    exactly why `stampFitReason` refuses to promote it to the fit line;
 *  - the finder's own note, once the machine prefix is gone — but only a
 *    machine negative (`auto: …`). A finder note without the prefix is
 *    provenance ("Bruno going to Corgi Founders Breakfast Club"), not a
 *    reason, and prefilling it hid the one tier that reads the dossier:
 *    the box opened with the event name and the LLM fallback never ran.
 *
 * The prefix matters: `auto:` is how `isAutoRejected` in score-prospects and
 * the pre-v26 `isHumanDecision` arm tell a machine negative from a human one,
 * and they read `notes` unconditionally. A human who re-saves an `auto: …`
 * note verbatim has just mislabeled their own decision, so the prefix never
 * survives into the box — and the server refuses it on the way back.
 */

export type RejectReasonSource = "person-gate" | "notes" | null;

export interface RejectReasonSuggestion {
  text: string;
  source: RejectReasonSource;
}

/** One-tap reasons; each appends to whatever is already in the box. */
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

/** The gates' pass-through strings — never a reason. Mirrors `_fit-reason.ts`. */
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
      return { text: reason, source: "person-gate" };
    }
  }
  const fromNotes = reasonFromNotes(input.notes);
  if (fromNotes) return { text: fromNotes, source: "notes" };
  return { text: "", source: null };
}

/**
 * `current` + a chip, joined with `; `; a chip already present is not
 * repeated. A sentence's closing period comes off before the joiner —
 * "owns acquisition; not the buyer", not "acquisition.; not the buyer".
 */
export function appendReason(current: string, chip: string): string {
  const base = current.trim();
  if (!base) return chip;
  const parts = base.split(/;\s*/).map((s) => s.trim().replace(/\.$/, "").toLowerCase());
  if (parts.includes(chip.toLowerCase())) return base;
  return `${base.replace(/[.;\s]+$/, "")}; ${chip}`;
}
