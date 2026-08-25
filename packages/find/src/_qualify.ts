import {
  ENRICH_DEADLINE_MS,
  enrichProfile,
  getLedger,
  isTransientToolError,
  logEvent,
  withDeadline,
} from "@oneshot-gtm/core";
import { isCircuitOpen, recordResolutionOutcome } from "./_breaker.ts";
import {
  type PersonCandidate,
  type PersonVerdict,
  hasRoleText,
  qualifyPerson,
} from "./_filter.ts";

/**
 * Staged person-level ICP qualification.
 *
 * The problem this solves: 15% of everyone we emailed was off-ICP (a
 * snowboard-team coordinator, two investors, an Account Executive who was
 * pitching us) because nothing in the pipeline ever looked at a human's role.
 *
 * The gate runs in up to three stages, cheapest first, because role data
 * arrives at different points and at different prices:
 *
 *   A. pre-spend    $0      role text the finder already has (Luma attendeeBio,
 *                           extracted founderRole/guestRole/etc.)
 *   B. post-enrich  $0      `title` off the enrichProfile we ALREADY buy for
 *                           every verified email (see `_enrich.ts`)
 *   C. fill-the-gap ~$0.005 one extra enrichProfile keyed by LinkedIn URL
 *
 * `unclear` and "no role text" are the same thing to this module: both mean
 * we cannot decide, and both escalate. Guessing on ambiguity is what let the
 * bad prospects through, and guessing the other way would drop real founders
 * whose bio happens to be blank (31% of Luma candidates).
 */

/** What the caller should do next. */
export type QualifyAction =
  /** Proceed with this candidate. */
  | "proceed"
  /** Genuine ICP miss — drop AND persist a rejected row (audit trail). */
  | "reject"
  /**
   * Could not decide (classifier outage). Drop WITHOUT persisting — a
   * persisted rejection burns the dedupeKey forever, so an LLM outage would
   * permanently blacklist every candidate it touched.
   */
  | "defer";

export interface QualifyOutcome {
  action: QualifyAction;
  verdict: PersonVerdict;
  reason: string;
  /** Role text the decision was actually made on, for persistence. */
  roleText: string | null;
  costUsd: number;
  receiptId: number | null;
}

function outcome(
  verdict: PersonVerdict,
  reason: string,
  roleText: string | null,
  costUsd = 0,
  receiptId: number | null = null,
): QualifyOutcome {
  const action: QualifyAction =
    verdict === "reject" ? "reject" : verdict === "transient" ? "defer" : "proceed";
  return { action, verdict, reason, roleText, costUsd, receiptId };
}

/**
 * Stage A — before any spend.
 *
 * Only a `reject` is actionable here; that is the free win, and it fires
 * before findEmail + verify + enrich are paid for. An `unclear` deliberately
 * returns "proceed": stage B is free, so paying at A would burn ~$0.005 on
 * candidates whose email fails verification anyway.
 */
export async function qualifyPreSpend(input: {
  icp: string | null;
  person: PersonCandidate;
}): Promise<QualifyOutcome> {
  // Nothing to judge yet — that is normal for repo-interest and
  // stack-consolidation, which carry no role at discovery. Defer to stage B.
  if (!hasRoleText(input.person)) {
    return outcome("unclear", "no role text at discovery; deferred to enrichment", null);
  }
  const res = await qualifyPerson(input);
  const roleText = input.person.roleText ?? null;

  // A transient classifier failure pre-spend is NOT a reason to drop the
  // candidate: stage B gets another look for free. Downgrade to proceed so an
  // LLM blip costs us nothing but a second opinion.
  if (res.verdict === "transient") {
    return outcome("unclear", "classifier unavailable pre-spend; deferred", roleText);
  }
  return outcome(res.verdict, res.reason, roleText);
}

/**
 * Stage B (+ C) — after `enrichVerifiedContact`, before `enqueueTarget`.
 *
 * `enrichedTitle` / `enrichedSummary` come free off the enrichProfile the
 * finder already paid for. If they still do not settle it and we have a
 * LinkedIn URL, stage C buys one more lookup.
 */
export async function qualifyPostEnrich(input: {
  icp: string | null;
  person: PersonCandidate;
  /** `title` from `enrichVerifiedContact` — free. */
  enrichedTitle?: string | null;
  /** `summary` from `enrichVerifiedContact` — free secondary evidence. */
  enrichedSummary?: string | null;
  /** Stage C target. Without it there is nothing left to buy. */
  linkedinUrl?: string | null;
  /** Per-finder switch for stage C spend. */
  fillGaps: boolean;
  /**
   * Set when the caller ALREADY ran enrichProfile keyed by this same LinkedIn
   * URL and it produced no title. Stage C would repeat that exact call, so it
   * is skipped — buying the same miss twice is pure waste.
   */
  alreadyEnrichedByLinkedin?: boolean;
  playName: string;
  errKindPrefix?: string;
}): Promise<QualifyOutcome> {
  const icp = input.icp;

  // Best role text available for free: the enriched title beats a discovery
  // headline (it is the current employer's record, not self-written), and the
  // summary is a fallback when the title is absent.
  const freeRole =
    firstNonEmpty(input.enrichedTitle, input.person.roleText, input.enrichedSummary) ?? null;

  const stageB = await qualifyPerson({ icp, person: { ...input.person, roleText: freeRole } });
  if (stageB.verdict === "pass" || stageB.verdict === "reject") {
    return outcome(stageB.verdict, stageB.reason, freeRole);
  }
  // `transient` here is a real outage (stage A already absorbed one blip).
  if (stageB.verdict === "transient") {
    return outcome("transient", stageB.reason, freeRole);
  }

  // ---- Stage C: unclear or still no role text, so go buy a real title. ----
  if (!input.fillGaps) {
    return outcome("unclear", "unclear; fill-the-gap lookup disabled for this finder", freeRole);
  }
  if (!input.linkedinUrl) {
    return outcome("unclear", "unclear and no linkedin url to enrich", freeRole);
  }
  if (input.alreadyEnrichedByLinkedin) {
    return outcome("unclear", "unclear; linkedin profile already enriched, no title", freeRole);
  }
  if (isCircuitOpen()) {
    // Platform is down — do not spend, and do not reject on missing data.
    return outcome("transient", "unclear; enrichment circuit open", freeRole);
  }

  let boughtTitle: string | null = null;
  let costUsd = 0;
  let receiptId: number | null = null;
  try {
    const enriched = await withDeadline(
      enrichProfile(
        { linkedinUrl: input.linkedinUrl },
        {
          playName: input.playName,
          decisionContext: { source: "finder.qualify_fill_gap" },
        },
      ),
      ENRICH_DEADLINE_MS,
      "enrichProfile",
    );
    costUsd = enriched.result.cost ?? 0;
    receiptId = enriched.receiptId;
    boughtTitle = readTitle(enriched.result.profile);
    recordResolutionOutcome(false);
  } catch (err) {
    recordResolutionOutcome(isTransientToolError(err));
    logEvent(
      "error.swallowed",
      {
        kind: `${input.errKindPrefix ?? "qualify"}.fill_gap`,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    // Could not buy the answer. Missing data is never a rejection.
    return outcome("transient", "fill-the-gap enrichment failed", freeRole, 0, null);
  }

  if (!boughtTitle) {
    return outcome("unclear", "fill-the-gap enrichment returned no title", freeRole, costUsd, receiptId);
  }

  const stageC = await qualifyPerson({ icp, person: { ...input.person, roleText: boughtTitle } });
  if (stageC.verdict === "transient") {
    return outcome("transient", stageC.reason, boughtTitle, costUsd, receiptId);
  }
  if (stageC.verdict === "unclear") {
    // Softened 2026-08-25 (founder: "we might be too strict"): a bought title
    // that STILL does not settle it is a genuine coin-flip, and the product is
    // self-serve pay-per-use — the cost of a false send is one email, the cost
    // of a false drop is a prospect gone forever. Proceed, log distinctly so
    // the coin-flip volume stays visible, and let the reply (or silence)
    // decide. Only a positive `reject` ever drops a candidate.
    logEvent("icp.person_unclear_after_enrich", {
      reason_120: stageC.reason.slice(0, 120),
      role_120: (boughtTitle ?? "").slice(0, 120),
    });
    return outcome("unclear", `unclear-after-enrich: ${stageC.reason}`, boughtTitle, costUsd, receiptId);
  }
  return outcome(stageC.verdict, stageC.reason, boughtTitle, costUsd, receiptId);
}

function firstNonEmpty(...vals: Array<string | null | undefined>): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/** Same title/experience fallback as `_enrich.ts`, on a raw profile object. */
function readTitle(profile: unknown): string | null {
  const p = profile as {
    title?: string | null;
    experience?: Array<{ title?: { name?: string | null } | null; is_primary?: boolean }> | null;
  } | null;
  if (!p) return null;
  const direct = typeof p.title === "string" ? p.title.trim() : "";
  if (direct.length > 0) return direct;
  if (Array.isArray(p.experience)) {
    const primary = p.experience.find((e) => e?.is_primary) ?? p.experience[0];
    const name = primary?.title?.name;
    if (typeof name === "string" && name.trim().length > 0) return name.trim();
  }
  return null;
}

/**
 * Persist an auditable rejected row for a person-level ICP miss.
 *
 * Mirrors the company-level ICP rejection pattern (`auto: ICP — …`) so both
 * kinds of auto-drop show up the same way in /queue and the founder can
 * override either. Best-effort: the drop already happened, and losing the
 * audit row must never take the run down.
 */
export function persistRoleRejection(args: {
  playName: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  source: string;
  reason: string;
  dryRun?: boolean;
}): void {
  if (args.dryRun) return;
  try {
    getLedger().enqueueTarget({
      playName: args.playName,
      dedupeKey: args.dedupeKey,
      payload: args.payload,
      source: args.source,
      initialStatus: "rejected",
      notes: `auto: role — ${args.reason}`.slice(0, 300),
    });
  } catch {
    // Audit row is best-effort.
  }
}
