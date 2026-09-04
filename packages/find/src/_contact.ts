import { logEvent } from "@oneshot-gtm/core";
import type { CallContext, FindEmailInput } from "@oneshot-gtm/core";
import { isCircuitOpen, recordResolutionOutcome } from "./_breaker.ts";
import { shouldSkipFindEmail } from "./_findemail-prescreen.ts";
import { safeFindEmail, safeVerifyEmail } from "./_sdk-safe.ts";
import { enrichVerifiedContact } from "./_enrich.ts";
import type { PersonCandidate, PersonVerdict } from "./_filter.ts";
import { qualifyPostEnrich } from "./_qualify.ts";

/**
 * Outcome of the shared contact-resolution spine. On `ok`, the caller has a
 * verified, non-duplicate email; otherwise `reason` says which gate dropped the
 * candidate. `costUsd` is the find + verify spend accrued so far — returned on
 * EVERY path so callers never lose cost tracking on a drop.
 */
export type ContactResolution =
  | { ok: true; email: string; fullName: string | null; costUsd: number }
  | {
      ok: false;
      reason:
        | "no-domain"
        | "prescreen"
        | "not-found"
        | "duplicate"
        | "undeliverable"
        // The backend threw/timed out — NOT a verdict about the candidate.
        // Callers should defer/persist-for-retry rather than treat as bad.
        | "platform-error";
      costUsd: number;
    };

/**
 * The prescreen → findEmail → dedupe → verify spine shared by every enqueueing
 * finder. Extracted so the per-candidate isolation (safeFindEmail/safeVerifyEmail
 * never throw) and the dedupe-before-verify ordering live in one place instead
 * of being re-implemented (and drifting) in each finder.
 *
 * Boundary: this owns email resolution + verification only. Downstream steps
 * (enrichVerifiedContact, findLinkedInUrl, webRead, enqueue) stay in the caller
 * because they vary too much between finders.
 *
 * - `knownEmail`: when the caller already has a usable email (a public profile
 *   email, or one surfaced by LinkedIn enrichment), pass it to skip the
 *   prescreen + findEmail entirely.
 * - `companyDomain`: required when `knownEmail` is absent (the findEmail input).
 * - `isDuplicate`: called with the resolved email BEFORE verify, so a
 *   cross-table duplicate is dropped without paying for a verify call. Dedupe
 *   stays caller-owned (each finder has its own `dedupeKey`).
 * - `decisionContext`: threaded to both findEmail and verify as audit metadata.
 */
export async function resolveAndVerifyContact(args: {
  playName: string;
  fullName: string | null;
  knownEmail?: string | null;
  companyDomain?: string | null;
  isDuplicate?: (email: string) => boolean;
  decisionContext?: CallContext["decisionContext"];
  /**
   * Forwarded to `shouldSkipFindEmail` — opt in only when the caller has no
   * owner/operator name on the source record at all (see that function's
   * doc comment). Defaults to off.
   */
  allowMissingFullName?: boolean;
  /**
   * Skip the paid `verifyEmail` call for a `knownEmail` the caller trusts as
   * already-deliverable (e.g. a government filing's on-file contact address,
   * not a scraped/guessed one) — mirrors `knownEmail` itself skipping
   * `findEmail`. Has no effect when `knownEmail` is absent (the
   * findEmail-resolved path is never trusted enough to skip verify). Default
   * off, so every existing `knownEmail` caller (github-stars, luma) keeps
   * verifying unless it explicitly opts in.
   */
  skipVerify?: boolean;
}): Promise<ContactResolution> {
  const ctx: CallContext = { playName: args.playName };
  if (args.decisionContext) ctx.decisionContext = args.decisionContext;

  let costUsd = 0;
  let email: string;
  let fullName = args.fullName;

  if (args.knownEmail) {
    email = args.knownEmail;
  } else {
    if (!args.companyDomain) return { ok: false, reason: "no-domain", costUsd };
    const skip = shouldSkipFindEmail({
      fullName: args.fullName,
      companyDomain: args.companyDomain,
      allowMissingFullName: args.allowMissingFullName,
    });
    if (!skip.ok) {
      logEvent("finder.skipped_findemail", { name: args.playName, reason: skip.reason }, "info");
      return { ok: false, reason: "prescreen", costUsd };
    }
    // Circuit open (backend outage): skip the paid call entirely — fast-fail as
    // a platform error so the caller defers instead of burning spend + ~70s.
    if (isCircuitOpen()) return { ok: false, reason: "platform-error", costUsd };
    const findInput: FindEmailInput = { companyDomain: args.companyDomain };
    if (args.fullName) findInput.fullName = args.fullName;
    const found = await safeFindEmail(findInput, ctx);
    costUsd += found.result.cost ?? 0;
    // status:"error" = the safe wrapper caught a throw (platform/transport
    // failure), NOT a genuine "no email for this person". Don't treat as a
    // verdict; feed the breaker and defer.
    if (found.result.status === "error") {
      recordResolutionOutcome(true);
      return { ok: false, reason: "platform-error", costUsd };
    }
    recordResolutionOutcome(false); // backend answered (found or genuinely not)
    if (!found.result.found || !found.result.email) {
      return { ok: false, reason: "not-found", costUsd };
    }
    email = found.result.email;
    fullName = found.result.full_name ?? args.fullName;
  }

  if (args.isDuplicate?.(email)) return { ok: false, reason: "duplicate", costUsd };

  if (args.knownEmail && args.skipVerify) {
    return { ok: true, email, fullName, costUsd };
  }

  if (isCircuitOpen()) return { ok: false, reason: "platform-error", costUsd };
  const verified = await safeVerifyEmail({ email }, ctx);
  costUsd += verified.result.cost ?? 0;
  if (verified.result.status === "error") {
    recordResolutionOutcome(true);
    return { ok: false, reason: "platform-error", costUsd };
  }
  recordResolutionOutcome(false);
  if (!verified.result.deliverable) return { ok: false, reason: "undeliverable", costUsd };

  return { ok: true, email, fullName, costUsd };
}

/**
 * Outcome of the full per-candidate spine: contact resolution + enrichment +
 * person-level ICP qualification.
 *
 * `costUsd` is the TOTAL accrued (find + verify + enrich + any fill-the-gap
 * lookup) and is returned on every path, so a caller that drops a candidate
 * still books the spend.
 */
export type QualifiedContact =
  | {
      ok: true;
      email: string;
      /** Name as resolved by findEmail — some finders prefer it over their extract. */
      fullName: string | null;
      phone: string | null;
      /** LinkedIn surfaced by enrichment. Finders may prefer their own source. */
      linkedinUrl: string | null;
      /** Job title the gate judged on — persist it so the next run is free. */
      title: string | null;
      /**
       * What the person-level ICP gate decided. Carried out of here so the
       * enqueue/send path can persist it onto `prospects.icp_verdict`.
       *
       * It used to be collapsed to `ok: true` and dropped, which meant the
       * only production writer of that column was the manual `ops/audit-icp.ts`
       * — so a verdict the gate had already paid to compute was recomputed by
       * hand later, or never. `unclear` is a real value here and must be
       * persisted as such: the cadence gate tests `=== "reject"`, so `unclear`
       * fails open exactly as NULL does, but recording it stops the audit
       * re-judging a row it has already settled.
       */
      verdict: Exclude<PersonVerdict, "transient">;
      /** One-sentence reason from the classifier, for `icp_verdict_reason`. */
      verdictReason: string;
      costUsd: number;
    }
  | {
      ok: false;
      reason:
        | Exclude<Extract<ContactResolution, { ok: false }>["reason"], never>
        /** Person-level ICP miss. Caller should count `droppedRole` + persist a rejected row. */
        | "role";
      /** Classifier's reason, present when `reason === "role"`. */
      detail?: string;
      costUsd: number;
    };

/**
 * The whole per-candidate spine in one call: prescreen → findEmail → dedupe →
 * verify → enrich → person-level ICP gate.
 *
 * Why this exists: `resolveAndVerifyContact` + `enrichVerifiedContact` +
 * cost-accumulation were re-implemented identically in eight finders
 * (github-stars, post-funding, job-change, hiring-signal, podcast-guest,
 * accelerator-batch, show-hn, luma). Adding the role gate to each of them
 * separately would have made that nine copies of a rule that must not drift —
 * the gate decides who gets emailed, so a finder that quietly skips it
 * reintroduces the exact problem this was built to fix.
 *
 * Deliberately NOT absorbed: `findLinkedInUrl` and the per-finder phone /
 * LinkedIn priority chains. Those genuinely differ (post-funding prefers the
 * page extract, github-stars disambiguates on the GitHub login), so they stay
 * with the caller.
 *
 * Stage A (judging role text the finder already holds, before any spend) also
 * stays with the caller — the field differs per finder (`attendeeBio`,
 * `founderRole`, `guestRole`, `hiringManagerRole`, `newRole`).
 */
export async function resolveVerifyEnrichQualify(args: {
  playName: string;
  fullName: string | null;
  knownEmail?: string | null;
  companyDomain?: string | null;
  isDuplicate?: (email: string) => boolean;
  decisionContext?: CallContext["decisionContext"];
  errKindPrefix?: string;
  /** Person-level gate context. */
  icp: string | null;
  person: PersonCandidate;
  /**
   * Finder-specific LinkedIn URL (e.g. from a page extract), used as the
   * stage-C lookup target when enrichment didn't surface one.
   */
  linkedinUrlHint?: string | null;
  /** Allow the paid fill-the-gap lookup. Defaults to on. */
  fillGaps?: boolean;
  /**
   * A job title the finder ALREADY obtained for free (e.g. luma resolves the
   * profile by LinkedIn URL before contact resolution). Preferred over the
   * post-verify enrichment title, since it came from the richer lookup.
   */
  titleHint?: string | null;
  /**
   * Forwarded to `resolveAndVerifyContact` / `shouldSkipFindEmail` — opt in
   * only when the caller has no owner/operator name on the source record at
   * all. Defaults to off.
   */
  allowMissingFullName?: boolean;
  /** Forwarded to `resolveAndVerifyContact` — see its doc comment. Default off. */
  skipVerify?: boolean;
}): Promise<QualifiedContact> {
  const contact = await resolveAndVerifyContact({
    playName: args.playName,
    fullName: args.fullName,
    knownEmail: args.knownEmail,
    companyDomain: args.companyDomain,
    isDuplicate: args.isDuplicate,
    decisionContext: args.decisionContext,
    allowMissingFullName: args.allowMissingFullName,
    skipVerify: args.skipVerify,
  });
  let costUsd = contact.costUsd;
  if (!contact.ok) return { ok: false, reason: contact.reason, costUsd };

  const enr = await enrichVerifiedContact(contact.email, {
    playName: args.playName,
    errKindPrefix: args.errKindPrefix ?? args.playName,
  });
  costUsd += enr.costUsd;

  const gate = await qualifyPostEnrich({
    icp: args.icp,
    person: args.person,
    enrichedTitle: args.titleHint ?? enr.title,
    enrichedSummary: enr.summary,
    linkedinUrl: enr.linkedinUrl ?? args.linkedinUrlHint ?? null,
    fillGaps: args.fillGaps ?? true,
    playName: args.playName,
    errKindPrefix: args.errKindPrefix ?? args.playName,
  });
  costUsd += gate.costUsd;

  if (gate.action === "reject") {
    return { ok: false, reason: "role", detail: gate.reason, costUsd };
  }
  // A classifier/platform outage is not a verdict — surface it as the same
  // platform-error the callers already know how to defer and retry.
  if (gate.action === "defer") {
    return { ok: false, reason: "platform-error", costUsd };
  }

  return {
    ok: true,
    email: contact.email,
    fullName: contact.fullName,
    phone: enr.phone,
    linkedinUrl: enr.linkedinUrl,
    title: gate.roleText ?? enr.title,
    // `reject` and `transient` returned above, so what reaches here is a
    // settled pass or an unresolved unclear — both worth persisting.
    verdict: gate.verdict === "transient" ? "unclear" : gate.verdict,
    verdictReason: gate.reason,
    costUsd,
  };
}

/**
 * The ICP fields to spread onto a finder's target payload, next to `title`.
 *
 * Finders stamp `...(contact.title ? { title: contact.title } : {})`; this is
 * the sibling for the verdict, so `_run-play.ts` and the /queue send route can
 * persist it onto the prospect row the same generic way they already persist
 * `title`. Spread-safe: returns an empty object when there is nothing to say.
 */
export function icpFields(contact: Extract<QualifiedContact, { ok: true }>): {
  icpVerdict?: string;
  icpVerdictReason?: string;
} {
  if (!contact.verdict) return {};
  return {
    icpVerdict: contact.verdict,
    ...(contact.verdictReason ? { icpVerdictReason: contact.verdictReason } : {}),
  };
}
