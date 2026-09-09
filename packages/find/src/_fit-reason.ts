/**
 * Enqueue-time `fitReason` (issue #592): the pure ladder every finder's row
 * goes through in `enqueueScoredTarget`, and the per-play parser the backfill
 * uses to recover a reason from the `notes` templates finders wrote before
 * the field existed.
 *
 * Nothing here calls the LLM or the ledger — the chokepoint is synchronous and
 * hot, and every finder test hands it a ledger double that implements only
 * `enqueueTarget`. Generation (`generateFitReason`) happens in the finders that
 * have no gate reason, before they enqueue, where they are already async.
 */
import { logEvent } from "@oneshot-gtm/core";
import {
  FIT_REASON_COST_ESTIMATE_USD,
  type FitReasonSource,
  generateFitReason,
  normalizeFitReason,
} from "@oneshot-gtm/plays";

export { FIT_REASON_COST_ESTIMATE_USD, generateFitReason, normalizeFitReason };
export type { FitReasonSource };

function str(p: Record<string, unknown>, key: string): string | null {
  const v = p[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Stamp `fitReason`/`fitReasonSource` onto a payload about to be enqueued.
 * Order: the finder's explicit reason → a reason already on the payload
 * (manual adds, re-enqueues, backfilled rows) → the person gate's reason when
 * its verdict is not `reject` (a reject reason says why they DON'T fit) →
 * nothing, with an event so the gap is visible in telemetry.
 *
 * Total and pure: a non-object payload comes back untouched.
 */
export function stampFitReason(
  playName: string,
  payload: unknown,
  explicit?: string | null,
  source?: FitReasonSource,
): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;

  const given = normalizeFitReason(explicit);
  if (given) return { ...p, fitReason: given, fitReasonSource: source ?? "company-gate" };

  if (str(p, "fitReason")) return payload;

  const personReason = normalizeFitReason(p["icpVerdictReason"]);
  if (personReason && p["icpVerdict"] !== "reject") {
    return { ...p, fitReason: personReason, fitReasonSource: "person-gate" };
  }

  logEvent("fit_reason.missing", { play: playName });
  return payload;
}

/** A recovered sentence must look like one: not a label, not a paragraph. */
const MIN_WORDS = 3;
const MAX_WORDS = 40;

function plausibleSentence(s: string | null): string | null {
  if (!s) return null;
  const words = s.split(/\s+/).length;
  return words >= MIN_WORDS && words <= MAX_WORDS ? s : null;
}

/** Plays whose finders wrote `… — ${filter.reason}` (the reason is the tail after the LAST " — "). */
const TAIL_AFTER_DASH = new Set([
  "accelerator-batch",
  "job-change",
  "post-funding",
  "podcast-guest",
  "hiring-signal",
]);
/** Plays whose finders wrote the bare `filter.reason` as the whole note. */
const WHOLE_NOTE = new Set(["show-hn", "repo-interest"]);

/**
 * Recover the company-gate reason from a row's `notes`, per play, using only
 * the templates the finders actually wrote. Deliberately an allowlist — a
 * generic "text after the dash" rule would read breakup-revive's
 * `47d cold — Acme` and gov-solicitation's `type — agency — title` as reasons.
 * Anything machine-labelled (`auto:`), any CSV-import status, luma's
 * `<name> going to <event>`, and every play not listed returns null.
 */
export function parseReasonFromNotes(
  playName: string,
  notes: string | null | undefined,
): string | null {
  const n = notes?.trim();
  if (!n) return null;
  if (/^auto:/i.test(n) || /^CSV import:/i.test(n)) return null;

  if (TAIL_AFTER_DASH.has(playName)) {
    const idx = n.lastIndexOf(" — ");
    if (idx === -1) return null;
    return plausibleSentence(normalizeFitReason(n.slice(idx + 3)));
  }

  if (WHOLE_NOTE.has(playName)) return plausibleSentence(normalizeFitReason(n));

  // competitor-switch and stack-consolidation come from two finders: github-stars
  // writes the bare reason; github-topics writes `<prefix>: <stack> (N vendors) — <reason>`
  // truncated at 220 chars (a truncated note may have lost the reason itself).
  if (playName === "competitor-switch" || playName === "stack-consolidation") {
    const m = /\(\d+ vendors?\) — (.+)$/.exec(n);
    if (m) return n.length >= 220 ? null : plausibleSentence(normalizeFitReason(m[1]));
    return playName === "competitor-switch" ? plausibleSentence(normalizeFitReason(n)) : null;
  }

  // free-pilot / new-business: local-registry writes `<sourceLabel> — <reason>`;
  // local-business writes the bare reason. A note with a dash is the registry shape.
  if (playName === "free-pilot" || playName === "new-business") {
    const idx = n.lastIndexOf(" — ");
    return plausibleSentence(normalizeFitReason(idx === -1 ? n : n.slice(idx + 3)));
  }

  return null;
}
