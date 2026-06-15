import {
  ENRICH_CACHE_TTL_MS,
  ENRICH_DEADLINE_MS,
  ENRICH_FAILURE_TTL_MS,
  enrichProfile,
  getLedger,
  isTransientToolError,
  logEvent,
  withDeadline,
} from "@oneshot-gtm/core";
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
  const ledger = getLedger();
  const key = email.trim().toLowerCase();

  // Cache-read short-circuit. If a prior find pass already enriched this email
  // (either via this function OR via the linkedin-keyed sites in luma.ts /
  // _repo-pipeline.ts that ALSO populate the same cache by surfaced email),
  // skip the SDK call entirely — phone + linkedin can be derived from the
  // cached profile. This eliminates the double-enrich on linkedin-bearing
  // candidates (find used to pay $0.005 twice + ~70s twice per such person).
  // Mirrors the read pattern in safeEnrich at packages/plays/src/_lib.ts:31.
  try {
    const cached = ledger.getCachedEnrichment(key);
    // Fresh negative entry: the SDK job failed recently for this email —
    // skip the retry, the finder proceeds without phone/linkedin.
    if (
      cached?.status === "failed" &&
      Date.now() - new Date(cached.fetched_at).getTime() < ENRICH_FAILURE_TTL_MS
    ) {
      return { phone: null, linkedinUrl: null, costUsd: 0, receiptId: null };
    }
    if (
      cached &&
      cached.status !== "failed" &&
      Date.now() - new Date(cached.fetched_at).getTime() < ENRICH_CACHE_TTL_MS
    ) {
      try {
        const cachedResult = JSON.parse(cached.result_json) as {
          profile?: Parameters<typeof extractFirstPhone>[0];
        };
        const profile = cachedResult.profile ?? null;
        const linkedinRaw =
          (profile as { linkedin_url?: string | null } | null)?.linkedin_url ?? null;
        return {
          phone: extractFirstPhone(profile),
          linkedinUrl: isLinkedInProfileUrl(linkedinRaw) ? linkedinRaw : null,
          // Cache hit: no new SDK call, so no new spend and no new receipt
          // attributed to this call. The original receipt is still on file
          // from whatever finder first paid for the enrichment.
          costUsd: 0,
          receiptId: null,
        };
      } catch {
        // Corrupt cache row — fall through to a fresh SDK call.
      }
    }
  } catch {
    // Ledger read failed — fall through to the SDK path.
  }

  try {
    const live = enrichProfile(
      { email },
      {
        playName: opts.playName,
        decisionContext: { source: "finder.post_verify", prospectEmail: email },
      },
    );
    // Populate the same per-email enrichment cache that `safeEnrich` reads on
    // /run dispatch. Rides on the LIVE promise (not the deadline race) so a
    // call that outlives the deadline still records its outcome — a late
    // success overwrites the failure marker the catch below writes.
    live.then(
      (out) => {
        try {
          ledger.setCachedEnrichment(key, JSON.stringify(out.result));
        } catch {
          // cache write is best-effort — find's contract is phone + linkedin,
          // not populating a cache. A SQLite hiccup shouldn't break the enqueue.
        }
      },
      () => {
        // Rejections surface through the race below; this only silences the
        // abandoned promise's unhandled-rejection noise.
      },
    );
    const enriched = await withDeadline(live, ENRICH_DEADLINE_MS, "enrichProfile");
    const profile = enriched.result.profile;
    const linkedinRaw = profile?.linkedin_url ?? null;
    return {
      phone: extractFirstPhone(profile),
      linkedinUrl: isLinkedInProfileUrl(linkedinRaw) ? linkedinRaw : null,
      costUsd: enriched.result.cost ?? 0,
      receiptId: enriched.receiptId,
    };
  } catch (err) {
    const message = (err as Error).message ?? "";
    logEvent(
      "error.swallowed",
      {
        kind: `${opts.errKindPrefix ?? "enrich"}.post_verify`,
        message_120: message.slice(0, 120),
      },
      "warn",
    );
    // Negative-cache only a GENUINE no-data failure. A transient platform error
    // (worker crash / timeout / 5xx — the 2026-06 outage) must NOT be cached, or
    // the email stays un-enrichable for ENRICH_FAILURE_TTL_MS after recovery.
    if (!isTransientToolError(err)) {
      try {
        ledger.setCachedEnrichmentFailure(key, message);
      } catch {
        // cache write is best-effort
      }
    }
    return { phone: null, linkedinUrl: null, costUsd: 0, receiptId: null };
  }
}
