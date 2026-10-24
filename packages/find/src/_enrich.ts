import {
  ENRICH_DEADLINE_MS,
  enrichProfile,
  isCachedPaidFailure,
  logEvent,
  withDeadline,
} from "@oneshot-gtm/core";
import { extractFirstPhone, isLinkedInProfileUrl } from "./_linkedin.ts";

export interface EnrichedContact {
  phone: string | null;
  linkedinUrl: string | null;
  /**
   * The person's job title, off the same `PersonResult` that already carries
   * phone + linkedin. Feeds the person-level ICP gate in `_filter.ts`.
   */
  title: string | null;
  /** Free-text bio/headline from the same profile. Secondary role evidence. */
  summary: string | null;
  costUsd: number;
  receiptId: number | null;
}

interface RoleFields {
  title: string | null;
  summary: string | null;
}

/**
 * Read the person's role off a `PersonResult`.
 *
 * `title` is the primary field; when the SDK omits it, fall back to the
 * current (`is_primary`) experience entry, which carries the same string in a
 * different shape. Both fields ride on every enrichProfile response we already
 * pay for: reading them costs nothing extra.
 */
function readRole(profile: unknown): RoleFields {
  const p = profile as {
    title?: string | null;
    summary?: string | null;
    experience?: Array<{ title?: { name?: string | null } | null; is_primary?: boolean }> | null;
  } | null;
  if (!p) return { title: null, summary: null };

  const direct = typeof p.title === "string" ? p.title.trim() : "";
  let title = direct.length > 0 ? direct : null;
  if (!title && Array.isArray(p.experience)) {
    const primary = p.experience.find((e) => e?.is_primary) ?? p.experience[0];
    const name = primary?.title?.name;
    if (typeof name === "string" && name.trim().length > 0) title = name.trim();
  }

  const summary = typeof p.summary === "string" ? p.summary.trim() : "";
  return { title, summary: summary.length > 0 ? summary : null };
}

/** Enrichment produced nothing usable. Every field absent, no spend. */
const EMPTY_ENRICHMENT: EnrichedContact = {
  phone: null,
  linkedinUrl: null,
  title: null,
  summary: null,
  costUsd: 0,
  receiptId: null,
};

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
 * Throws are swallowed: one transient SDK blip should never kill an
 * otherwise valid enqueue. Same try/catch pattern as the existing
 * Path B' enrichProfile call in `_repo-pipeline.ts`.
 */
export async function enrichVerifiedContact(
  email: string,
  opts: { playName: string; errKindPrefix?: string },
): Promise<EnrichedContact> {
  // The paid cache under enrichProfile answers an email enriched before, by
  // any finder in any workspace, including a by-LinkedIn enrich that surfaced
  // this address: no second purchase for the same person.
  try {
    const live = enrichProfile(
      { email },
      {
        playName: opts.playName,
        decisionContext: { source: "finder.post_verify", prospectEmail: email },
      },
    );
    // A deadline-abandoned promise must not surface as an unhandled rejection;
    // the cache still stores it when it settles.
    live.catch(() => undefined);
    const enriched = await withDeadline(live, ENRICH_DEADLINE_MS, "enrichProfile");
    const profile = enriched.result.profile;
    const linkedinRaw = profile?.linkedin_url ?? null;
    const role = readRole(profile);
    return {
      phone: extractFirstPhone(profile),
      linkedinUrl: isLinkedInProfileUrl(linkedinRaw) ? linkedinRaw : null,
      title: role.title,
      summary: role.summary,
      // A cache hit costs nothing and carries no receipt of its own; the
      // original receipt is on file from whichever finder paid for it.
      costUsd: enriched.result.cost ?? 0,
      receiptId: enriched.receiptId || null,
    };
  } catch (err) {
    // A failure the cache remembers is not a new one.
    if (!isCachedPaidFailure(err)) {
      logEvent(
        "error.swallowed",
        {
          kind: `${opts.errKindPrefix ?? "enrich"}.post_verify`,
          message_120: ((err as Error).message ?? "").slice(0, 120),
        },
        "warn",
      );
    }
    return { ...EMPTY_ENRICHMENT };
  }
}
