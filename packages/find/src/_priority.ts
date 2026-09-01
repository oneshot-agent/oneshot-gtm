import type { ProspectPriority, ProspectPriorityComponents } from "@oneshot-gtm/core";

/**
 * Pure heuristic-v1 priority engine (issue #410, Phase 1 — shadow mode).
 *
 * Turns the evidence a finder already holds at enqueue time into the
 * explainable `ProspectPriority` artifact. No LLM calls, no paid SDK calls,
 * no I/O: identical (evidence, now) always produces the identical artifact,
 * reasons included. Hard eligibility gates run BEFORE this — a score never
 * rescues an off-ICP, duplicate, undeliverable, or role-rejected candidate.
 */

export const PRIORITY_VERSION = "heuristic-v1" as const;

/** v1 component weights, percent. Sum is 100 by construction. */
export const PRIORITY_WEIGHTS: Record<keyof ProspectPriorityComponents, number> = {
  personFit: 30,
  accountFit: 20,
  intentStrength: 20,
  timingFreshness: 15,
  signalConfidence: 10,
  contactability: 5,
};

/** Missing evidence is unknown, not bad: it scores neutral, never zero. */
export const NEUTRAL = 50;

/** One piece of positive evidence feeding a component. */
export interface PrioritySignal {
  /** Short slug for tests/debugging, e.g. "funding", "competitor". */
  kind: string;
  /** Component score this signal argues for, 0..100. */
  strength: number;
  /** Concise human-readable evidence, e.g. "raised Seed $2.0M". */
  reason: string;
}

/**
 * Normalized evidence an adapter extracts from a finder payload. Every field
 * is optional — an absent field reads as unknown and scores neutral.
 */
export interface PriorityEvidence {
  /** Job title from the person-level ICP gate. */
  title?: string | null;
  /** Stronger seniority evidence than `title` (e.g. job-change newRole, a Luma bio). */
  seniorityHint?: string | null;
  /** True when the payload names the account/company. */
  companyKnown?: boolean;
  /** Company-level signals: funding, cohort, hiring, audience size… */
  accountSignals?: PrioritySignal[];
  /** Behavior signals: launched, starred, reposted, attending, hiring need… */
  intentSignals?: PrioritySignal[];
  /** ISO timestamp of the triggering event, for freshness banding vs `now`. */
  eventAt?: string | null;
  /** Direct age in days when the finder already knows it (breakup-revive daysCold). Wins over eventAt. */
  ageDays?: number | null;
  /** How many verifiable evidence URLs the payload carries. */
  evidenceUrlCount?: number;
  /** True when the payload quotes concrete evidence text (bio, tweet, hook…). */
  hasEvidenceText?: boolean;
  hasEmail?: boolean;
  hasLinkedin?: boolean;
  hasPhone?: boolean;
  /** X DM lane: reachable via open DMs even without an email. */
  dmOpen?: boolean;
}

interface ComponentResult {
  score: number;
  reasons: string[];
}

/** Round then clamp to the 0..100 integer contract. Applied once per component and once on the total. */
export function clamp100(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** Exported for the ops feature gauge, so title banding matches the engine. */
export const SENIORITY_BANDS: Array<{ score: number; pattern: RegExp }> = [
  { score: 90, pattern: /founder|co-?founder|\bceo\b|\bcto\b|\bcoo\b|chief|owner|president/i },
  { score: 75, pattern: /\bvp\b|vice president|head of|director/i },
  { score: 60, pattern: /senior|staff|principal|\blead\b/i },
];

function scorePersonFit(ev: PriorityEvidence): ComponentResult {
  // Hint first, but a band-matching title beats a hint that matches nothing —
  // a Luma bio like "AI enthusiast" must not mask an ICP-gate title of "CTO".
  for (const text of [ev.seniorityHint?.trim(), ev.title?.trim()]) {
    if (!text) continue;
    for (const band of SENIORITY_BANDS) {
      if (band.pattern.test(text)) return { score: band.score, reasons: [`title: ${text}`] };
    }
  }
  // A known title that matches no band is real but unremarkable evidence.
  return { score: NEUTRAL, reasons: [] };
}

/**
 * Signal components take the STRONGEST signal, not a blend — one solid piece
 * of evidence ("raised Seed") shouldn't be dragged down by a weak second one,
 * and max keeps the arithmetic trivially explainable. Reasons come out
 * strongest-first; ties break on input order, so output stays deterministic.
 */
function scoreSignals(signals: PrioritySignal[] | undefined, base: number): ComponentResult {
  if (!signals || signals.length === 0) return { score: base, reasons: [] };
  const ordered = [...signals].toSorted((a, b) => b.strength - a.strength);
  const top = ordered[0]!;
  return { score: Math.max(base, top.strength), reasons: ordered.map((s) => s.reason) };
}

function scoreAccountFit(ev: PriorityEvidence): ComponentResult {
  const base = ev.companyKnown ? 55 : NEUTRAL;
  return scoreSignals(ev.accountSignals, base);
}

function scoreIntentStrength(ev: PriorityEvidence): ComponentResult {
  return scoreSignals(ev.intentSignals, NEUTRAL);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Freshness in coarse bands rather than a continuous decay so the score is
 * stable across small clock drift and re-scores.
 */
function scoreTimingFreshness(ev: PriorityEvidence, now: Date): ComponentResult {
  let days: number | null = null;
  if (typeof ev.ageDays === "number" && Number.isFinite(ev.ageDays)) {
    days = ev.ageDays;
  } else if (ev.eventAt) {
    const t = Date.parse(ev.eventAt);
    if (Number.isFinite(t)) days = (now.getTime() - t) / DAY_MS;
  }
  if (days === null) return { score: NEUTRAL, reasons: [] };
  // Future = an upcoming event: maximally timely.
  if (days < 0) return { score: 90, reasons: ["upcoming event"] };
  const d = Math.floor(days);
  if (days <= 3) return { score: 90, reasons: [`signal ${d}d old`] };
  if (days <= 7) return { score: 80, reasons: [`signal ${d}d old`] };
  if (days <= 30) return { score: 60, reasons: [`signal ${d}d old`] };
  if (days <= 90) return { score: 40, reasons: [`signal ${d}d old`] };
  return { score: 25, reasons: [`signal ${d}d old`] };
}

function scoreSignalConfidence(ev: PriorityEvidence): ComponentResult {
  const urls = Math.min(ev.evidenceUrlCount ?? 0, 2);
  const quoted = ev.hasEvidenceText === true;
  if (urls === 0 && !quoted) return { score: NEUTRAL, reasons: [] };
  const reasons: string[] = [];
  if (urls > 0) reasons.push(`${urls} evidence link${urls > 1 ? "s" : ""}`);
  if (quoted) reasons.push("quoted evidence on file");
  return { score: NEUTRAL + urls * 15 + (quoted ? 20 : 0), reasons };
}

function scoreContactability(ev: PriorityEvidence): ComponentResult {
  if (
    ev.hasEmail === undefined &&
    ev.hasLinkedin === undefined &&
    ev.hasPhone === undefined &&
    ev.dmOpen === undefined
  ) {
    return { score: NEUTRAL, reasons: [] };
  }
  const score =
    30 +
    (ev.hasEmail ? 35 : 0) +
    (ev.hasLinkedin ? 20 : 0) +
    (ev.hasPhone ? 5 : 0) +
    (ev.dmOpen ? 15 : 0);
  const reasons: string[] = [];
  if (!ev.hasEmail) reasons.push(ev.dmOpen ? "no email — DM open" : "no email on file");
  return { score, reasons };
}

/** How many reasons survive onto the persisted artifact. */
const MAX_REASONS = 4;

export function computePriority(finder: string, ev: PriorityEvidence, now: Date): ProspectPriority {
  const parts: Record<keyof ProspectPriorityComponents, ComponentResult> = {
    personFit: scorePersonFit(ev),
    accountFit: scoreAccountFit(ev),
    intentStrength: scoreIntentStrength(ev),
    timingFreshness: scoreTimingFreshness(ev, now),
    signalConfidence: scoreSignalConfidence(ev),
    contactability: scoreContactability(ev),
  };
  const components: ProspectPriorityComponents = {
    personFit: clamp100(parts.personFit.score),
    accountFit: clamp100(parts.accountFit.score),
    intentStrength: clamp100(parts.intentStrength.score),
    timingFreshness: clamp100(parts.timingFreshness.score),
    signalConfidence: clamp100(parts.signalConfidence.score),
    contactability: clamp100(parts.contactability.score),
  };
  let weighted = 0;
  const reasons: string[] = [];
  // Fixed weight-descending order: components and reasons always come out in
  // the same sequence for the same evidence.
  for (const key of Object.keys(PRIORITY_WEIGHTS) as Array<keyof ProspectPriorityComponents>) {
    weighted += components[key] * PRIORITY_WEIGHTS[key];
    reasons.push(...parts[key].reasons);
  }
  return {
    version: PRIORITY_VERSION,
    total: clamp100(weighted / 100),
    components,
    reasons: reasons.slice(0, MAX_REASONS),
    finder,
    scoredAt: now.toISOString(),
  };
}
