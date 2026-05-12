import { enrichProfile, logEvent } from "@oneshot-gtm/core";
import { extractFirstPhone, isLinkedInProfileUrl } from "./_linkedin.ts";

export interface EnrichedContact {
  phone: string | null;
  linkedinUrl: string | null;
  costUsd: number;
  receiptId: number | null;
}

/**
 * Always-on post-verify enrichment. Called by every enqueueing finder
 * AFTER verifyEmail succeeds + BEFORE enqueueTarget. Reads phone +
 * linkedin off PersonResult and returns them; finder merges into target.
 *
 * Why this exists: phone capture used to fire only on the narrow Path B'
 * + Path C branches in `_repo-pipeline.ts` (~10% of candidates), and the
 * other 6 finders never enriched at all. Empirical audit found 0/514
 * queue rows had a phone despite the SDK clearly returning some on
 * separate enrichProfile calls. Adding one $0.005 call per verified
 * email closes the gap uniformly across every play.
 *
 * Throws are swallowed — one transient SDK blip should never kill an
 * otherwise valid enqueue. Same try/catch pattern as the existing
 * Path B' enrichProfile call in `_repo-pipeline.ts`.
 */
export async function enrichVerifiedContact(
  email: string,
  opts: { playName: string; errKindPrefix?: string },
): Promise<EnrichedContact> {
  try {
    const enriched = await enrichProfile({ email }, { playName: opts.playName });
    const profile = enriched.result.profile;
    const linkedinRaw = profile?.linkedin_url ?? null;
    return {
      phone: extractFirstPhone(profile),
      linkedinUrl: isLinkedInProfileUrl(linkedinRaw) ? linkedinRaw : null,
      costUsd: enriched.result.cost ?? 0,
      receiptId: enriched.receiptId,
    };
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: `${opts.errKindPrefix ?? "enrich"}.post_verify`,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return { phone: null, linkedinUrl: null, costUsd: 0, receiptId: null };
  }
}
