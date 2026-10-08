import {
  fetchProfileReadmeEmail,
  type GitHubIdentity,
  type EmailSource,
} from "./_github-readme.ts";
import {
  canonicalLinkedInProfileKey,
  getLedger,
  logEvent,
  type OutreachChannel,
  type PersonResult,
  xHandleFrom,
} from "@oneshot-gtm/core";
import { finderChannels } from "./_channels-context.ts";
import { findLinkedInUrl } from "./_linkedin.ts";
import type { CallContext, FindEmailInput } from "@oneshot-gtm/core";
import { isCircuitOpen, recordResolutionOutcome } from "./_breaker.ts";
import { shouldSkipFindEmail } from "./_findemail-prescreen.ts";
import { safeFindEmail, safePeopleSearch, safeVerifyEmail } from "./_sdk-safe.ts";
import { enrichVerifiedContact } from "./_enrich.ts";
import type { PersonCandidate, PersonVerdict } from "./_filter.ts";
import { qualifyPostEnrich } from "./_qualify.ts";

/**
 * Outcome of the shared contact-resolution spine. On `ok`, the caller has a
 * verified, non-duplicate email; otherwise `reason` says which gate dropped the
 * candidate. `costUsd` is the find + verify spend accrued so far: returned on
 * EVERY path so callers never lose cost tracking on a drop.
 */
export type ContactResolution =
  | {
      ok: true;
      email: string;
      emailSource?: EmailSource;
      fullName: string | null;
      /** Job title the domain person-lookup surfaced, when that path ran. */
      title?: string | null;
      costUsd: number;
    }
  | {
      ok: false;
      reason:
        | "no-domain"
        | "prescreen"
        | "not-found"
        | "duplicate"
        | "undeliverable"
        // The backend threw/timed out: NOT a verdict about the candidate.
        // Callers should defer/persist-for-retry rather than treat as bad.
        | "platform-error";
      attemptedEmail?: string;
      costUsd: number;
    };

/**
 * Resolve and verify email with per-candidate failure isolation.
 * `knownEmail` skips prescreen and lookup; otherwise `companyDomain` is required.
 * Caller-owned `isDuplicate` runs before paid verification. `decisionContext`
 * is audit metadata for both calls. Enrichment and enqueue stay with callers.
 */
async function resolvePrimaryContact(args: {
  playName: string;
  fullName: string | null;
  knownEmail?: string | null;
  companyDomain?: string | null;
  isDuplicate?: (email: string) => boolean;
  decisionContext?: CallContext["decisionContext"];
  /**
   * Forwarded to `shouldSkipFindEmail`: opt in only when the caller has no
   * owner/operator name on the source record at all (see that function's
   * doc comment). Defaults to off.
   */
  allowMissingFullName?: boolean;
  /**
   * Skip the paid `verifyEmail` call for a `knownEmail` the caller trusts as
   * already-deliverable (e.g. a government filing's on-file contact address,
   * not a scraped/guessed one): mirrors `knownEmail` itself skipping
   * `findEmail`. Has no effect when `knownEmail` is absent (the
   * findEmail-resolved path is never trusted enough to skip verify). Default
   * off, so every existing `knownEmail` caller (github-stars, luma) keeps
   * verifying unless it explicitly opts in.
   */
  skipVerify?: boolean;
  unusableEmails?: Set<string>;
}): Promise<ContactResolution> {
  const ctx: CallContext = { playName: args.playName };
  if (args.decisionContext) ctx.decisionContext = args.decisionContext;

  let costUsd = 0;
  let email: string;
  let fullName = args.fullName;
  let title: string | null = null;

  if (args.knownEmail) {
    email = args.knownEmail;
  } else {
    if (!args.companyDomain) {
      logEvent("finder.skipped_findemail", { name: args.playName, reason: "no-domain" }, "info");
      return { ok: false, reason: "no-domain", costUsd };
    }
    const skip = shouldSkipFindEmail({
      fullName: args.fullName,
      companyDomain: args.companyDomain,
      allowMissingFullName: args.allowMissingFullName,
    });
    if (!skip.ok) {
      logEvent("finder.skipped_findemail", { name: args.playName, reason: skip.reason }, "info");
      return { ok: false, reason: "prescreen", costUsd };
    }
    // Circuit open (backend outage): skip the paid call entirely: fast-fail as
    // a platform error so the caller defers instead of burning spend + ~70s.
    if (isCircuitOpen()) return { ok: false, reason: "platform-error", costUsd };

    // findEmail requires a person: search the domain first when no name is
    // known, reusing any returned work email. No named person is a candidate
    // miss, not an outage.
    let lookedUpEmail: string | null = null;
    if (!fullName?.trim()) {
      const people = await safePeopleSearch(
        { companyDomains: [args.companyDomain], limit: 10 },
        ctx,
      );
      costUsd += people.result.cost ?? 0;
      if (people.result.status === "error") {
        recordResolutionOutcome(true);
        return { ok: false, reason: "platform-error", costUsd };
      }
      recordResolutionOutcome(false);
      const person = pickNamedPerson(people.result.results as PersonResult[]);
      if (!person) {
        logEvent(
          "finder.skipped_findemail",
          { name: args.playName, reason: "no-named-contact", domain: args.companyDomain },
          "info",
        );
        return { ok: false, reason: "not-found", costUsd };
      }
      fullName = person.fullName;
      title = person.title;
      lookedUpEmail = person.bestWorkEmail;
    }

    if (lookedUpEmail) {
      email = lookedUpEmail;
    } else {
      const findInput: FindEmailInput = { companyDomain: args.companyDomain };
      if (fullName) findInput.fullName = fullName;
      const found = await safeFindEmail(findInput, ctx);
      costUsd += found.result.cost ?? 0;
      // status:"error" = the safe wrapper caught a throw (platform/transport
      // failure), NOT a genuine "no email for this person". Don't treat as a
      // verdict; feed the breaker and defer. status:"invalid" = the SDK
      // refused our input before sending anything. A verdict, never an outage.
      if (found.result.status === "error") {
        recordResolutionOutcome(true);
        return { ok: false, reason: "platform-error", costUsd };
      }
      recordResolutionOutcome(false); // backend answered (found or genuinely not)
      if (found.result.status === "invalid" || !found.result.found || !found.result.email) {
        return { ok: false, reason: "not-found", costUsd };
      }
      email = found.result.email;
      fullName = found.result.full_name ?? fullName;
    }
  }

  if (args.unusableEmails?.has(email.toLowerCase()))
    return { ok: false, reason: "undeliverable", attemptedEmail: email, costUsd };
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
  if (!verified.result.deliverable)
    return { ok: false, reason: "undeliverable", attemptedEmail: email, costUsd };

  return { ok: true, email, fullName, ...(title ? { title } : {}), costUsd };
}

/** GitHub-only final fallback; other finders retain their existing resolution path. */
export async function resolveAndVerifyContact(
  args: Parameters<typeof resolvePrimaryContact>[0] & { githubIdentity?: GitHubIdentity },
): Promise<ContactResolution> {
  let result = await resolvePrimaryContact(args);
  if (!args.githubIdentity) {
    if (result.ok) return result;
    const { attemptedEmail: _attemptedEmail, ...failure } = result;
    return failure;
  }
  if (result.ok || result.reason === "duplicate" || result.reason === "platform-error")
    return result;
  const attempted = new Set<string>();
  if (result.attemptedEmail) attempted.add(result.attemptedEmail.toLowerCase());
  let costUsd = result.costUsd;
  if (args.knownEmail && result.reason === "undeliverable") {
    result = await resolvePrimaryContact({
      ...args,
      knownEmail: null,
      unusableEmails: attempted,
      isDuplicate: (email) => args.isDuplicate?.(email) ?? false,
    });
    costUsd += result.costUsd;
    if (result.ok || result.reason === "duplicate" || result.reason === "platform-error")
      return { ...result, costUsd };
    if (result.attemptedEmail) attempted.add(result.attemptedEmail.toLowerCase());
  }
  const readme = await fetchProfileReadmeEmail(args.githubIdentity);
  if (readme.status === "unavailable") return { ok: false, reason: "platform-error", costUsd };
  if (readme.status !== "found" || attempted.has(readme.email.toLowerCase()))
    return { ...result, costUsd };
  const recovered = await resolvePrimaryContact({
    ...args,
    knownEmail: readme.email,
    skipVerify: false,
  });
  costUsd += recovered.costUsd;
  logEvent("github.readme.verification", {
    login: args.githubIdentity.login,
    ok: recovered.ok,
    costUsd: recovered.costUsd,
  });
  return recovered.ok
    ? {
        ...recovered,
        costUsd,
        emailSource: {
          kind: "github-profile-readme",
          url: readme.url,
          resolvedAt: new Date().toISOString(),
        },
      }
    : { ...recovered, costUsd };
}

/**
 * Titles that own the buying decision at a small company. Checked first
 * when picking from a domain-scoped search: the person ICP gate rejects a
 * logistics hire or a recruiter and burns the candidate's dedupe key, so a
 * founder further down the list must win over a titled employee with a
 * work email on file.
 */
const DECISION_OWNER_TITLE =
  /\b(founder|co-?founder|ceo|cto|coo|cfo|cro|cmo|chief|president|owner|managing (director|partner)|general manager|head of|vp|vice president|director)\b/i;

/**
 * Placeholders a people index hands back in the name fields ("None None",
 * "null", "N/A"). Not a person: picking one puts "Hey None" in a draft.
 */
const PLACEHOLDER_NAME =
  /^(none|null|undefined|unknown|n\/?a)(\s+(none|null|undefined|unknown|n\/?a))*$/i;

/** A real name out of a name field, or "" for a blank or a placeholder. */
function usableName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  return name && !PLACEHOLDER_NAME.test(name) ? name : "";
}

/**
 * The person to write to out of a domain-scoped peopleSearch: needs a usable
 * name (never a provider placeholder such as "None None"); prefers a decision owner (founder, chief, head, VP: see
 * `DECISION_OWNER_TITLE`), among those one with a work email on file (skips
 * a paid findEmail); then anyone with a work email, then anyone with a title
 * (feeds the role gate). Exported for the unit test.
 */
export function pickNamedPerson(
  results: PersonResult[] | null | undefined,
): { fullName: string; title: string | null; bestWorkEmail: string | null } | null {
  if (!Array.isArray(results)) return null;
  const named = results.flatMap((p) => {
    if (!p || typeof p !== "object") return [];
    const full =
      usableName(p.full_name) ||
      usableName([p.first_name, p.last_name].map(usableName).filter(Boolean).join(" "));
    if (!full) return [];
    return [
      {
        fullName: full,
        title: typeof p.title === "string" && p.title.trim() ? p.title.trim() : null,
        bestWorkEmail:
          typeof p.best_work_email === "string" && p.best_work_email.trim()
            ? p.best_work_email.trim()
            : null,
      },
    ];
  });
  const owners = named.filter((p) => p.title && DECISION_OWNER_TITLE.test(p.title));
  return (
    owners.find((p) => p.bestWorkEmail) ??
    owners[0] ??
    named.find((p) => p.bestWorkEmail) ??
    named.find((p) => p.title) ??
    named[0] ??
    null
  );
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
      /**
       * The channel this person is queued on: the first in the run's channel
       * order (`finderChannels`) they have an address for. `linkedin` means
       * no email was needed or found and `linkedinUrl` is the address.
       */
      channel: "email" | "linkedin" | "x";
      /** The verified email; null on the LinkedIn and X channels. */
      email: string | null;
      /** X handle (no @) when the person is queued on X. */
      xHandle?: string | null;
      emailSource?: EmailSource;
      /** Name as resolved by findEmail: some finders prefer it over their extract. */
      fullName: string | null;
      phone: string | null;
      /** LinkedIn surfaced by enrichment. Finders may prefer their own source. */
      linkedinUrl: string | null;
      /** Job title the gate judged on: persist it so the next run is free. */
      title: string | null;
      /**
       * Persist the person-level verdict onto `prospects.icp_verdict` for enqueue
       * and send. Store `unclear` too: it fails open like NULL because cadence
       * only blocks `reject`, but retaining it avoids another paid judgment.
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
      /** Verified contact retained when a later role gate rejects the candidate. */
      email?: string;
      emailSource?: EmailSource;
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
 * separately would have made that nine copies of a rule that must not drift:
 * the gate decides who gets emailed, so a finder that quietly skips it
 * reintroduces the exact problem this was built to fix.
 *
 * Deliberately NOT absorbed: `findLinkedInUrl` and the per-finder phone /
 * LinkedIn priority chains. Those genuinely differ (post-funding prefers the
 * page extract, github-stars disambiguates on the GitHub login), so they stay
 * with the caller.
 *
 * Stage A (judging role text the finder already holds, before any spend) also
 * stays with the caller. The field differs per finder (`attendeeBio`,
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
  githubIdentity?: GitHubIdentity;
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
   * Forwarded to `resolveAndVerifyContact` / `shouldSkipFindEmail`: opt in
   * only when the caller has no owner/operator name on the source record at
   * all. Defaults to off.
   */
  allowMissingFullName?: boolean;
  /** Forwarded to `resolveAndVerifyContact`: see its doc comment. Default off. */
  skipVerify?: boolean;
  /**
   * The person's X handle or profile URL, when the finder has one. The X
   * channel's only address source: the contact step never searches X.
   */
  xHandleHint?: string | null;
  /**
   * Channel order for this candidate. Defaults to the run's (`finderChannels`):
   * the trigger's `channels`, else the workspace's, else email only.
   */
  channels?: OutreachChannel[];
}): Promise<QualifiedContact> {
  let costUsd = 0;
  // Why email was ruled out, reported if no later channel works either.
  let emailMiss: Extract<ContactResolution, { ok: false }>["reason"] | null = null;
  for (const channel of args.channels ?? finderChannels()) {
    if (channel === "email") {
      const viaEmail = await qualifyViaEmail(args);
      costUsd += viaEmail.costUsd;
      if (viaEmail.ok || !isNoAddress(viaEmail.reason)) return { ...viaEmail, costUsd };
      emailMiss = viaEmail.reason as Extract<ContactResolution, { ok: false }>["reason"];
    } else if (channel === "linkedin") {
      const viaLinkedIn = await qualifyViaLinkedIn(args);
      costUsd += viaLinkedIn.costUsd;
      // A found profile ends the walk either way (queued, or rejected by the
      // person gate); only "no LinkedIn profile" moves on to the next channel.
      if (viaLinkedIn.ok || viaLinkedIn.reason !== "not-found") return { ...viaLinkedIn, costUsd };
    } else if (channel === "x") {
      const viaX = await qualifyViaX(args);
      if (viaX) {
        costUsd += viaX.costUsd;
        return { ...viaX, costUsd };
      }
    }
  }
  return { ok: false, reason: emailMiss ?? "not-found", costUsd };
}

/** A contact miss that only means "no address on this channel": try the next one. */
function isNoAddress(reason: string): boolean {
  return (
    reason === "no-domain" ||
    reason === "prescreen" ||
    reason === "not-found" ||
    reason === "undeliverable"
  );
}

/**
 * LinkedIn channel: the address is the person's profile URL. The finder's
 * own, else one search by name (and company). Gated like the email path, on
 * the role text the finder holds plus a paid profile lookup when unclear.
 */
async function qualifyViaLinkedIn(
  args: Parameters<typeof resolveVerifyEnrichQualify>[0],
): Promise<QualifiedContact> {
  let costUsd = 0;
  let linkedinUrl = args.linkedinUrlHint?.trim() || null;
  let unavailable = false;
  if (!linkedinUrl && args.fullName) {
    linkedinUrl = await findLinkedInUrl({
      onUnavailable: () => {
        unavailable = true;
      },
      fullName: args.fullName,
      disambiguators: args.person.company ? [args.person.company] : [],
      accumCost: (c) => {
        costUsd += c ?? 0;
      },
      errKindPrefix: args.errKindPrefix ?? args.playName,
    });
  }
  // A lookup that could not run is an outage, not a miss: the walk must not
  // fall through to another channel or drop the person as unreachable.
  if (unavailable) return { ok: false, reason: "platform-error", costUsd };
  if (!linkedinUrl || !canonicalLinkedInProfileKey(linkedinUrl)) {
    return { ok: false, reason: "not-found", costUsd };
  }
  // Cross-play dedupe on the profile, as the email path does on the address:
  // someone already known or queued is not queued again on LinkedIn.
  if (getLedger().isLinkedInProfileKnown(linkedinUrl)) {
    return { ok: false, reason: "duplicate", costUsd };
  }
  const gate = await qualifyPostEnrich({
    icp: args.icp,
    person: args.person,
    enrichedTitle: args.titleHint ?? null,
    linkedinUrl,
    fillGaps: args.fillGaps ?? true,
    playName: args.playName,
    errKindPrefix: args.errKindPrefix ?? args.playName,
  });
  costUsd += gate.costUsd;
  if (gate.action === "reject") return { ok: false, reason: "role", detail: gate.reason, costUsd };
  if (gate.action === "defer") return { ok: false, reason: "platform-error", costUsd };
  return {
    ok: true,
    channel: "linkedin",
    email: null,
    fullName: args.fullName,
    phone: null,
    linkedinUrl,
    title: gate.roleText ?? args.titleHint ?? null,
    verdict: gate.verdict === "transient" ? "unclear" : gate.verdict,
    verdictReason: gate.reason,
    costUsd,
  };
}

/**
 * X channel: the address is the handle the finder surfaced (null when it has
 * none, so the walk moves on). Gated on the finder's role text; X has no paid
 * lookup of its own, so an unclear role stays unclear rather than bought.
 */
async function qualifyViaX(
  args: Parameters<typeof resolveVerifyEnrichQualify>[0],
): Promise<QualifiedContact | null> {
  const xHandle = xHandleFrom(args.xHandleHint);
  if (!xHandle) return null;
  const gate = await qualifyPostEnrich({
    icp: args.icp,
    person: args.person,
    enrichedTitle: args.titleHint ?? null,
    linkedinUrl: args.linkedinUrlHint ?? null,
    fillGaps: args.fillGaps ?? true,
    playName: args.playName,
    errKindPrefix: args.errKindPrefix ?? args.playName,
  });
  if (gate.action === "reject") {
    return { ok: false, reason: "role", detail: gate.reason, costUsd: gate.costUsd };
  }
  if (gate.action === "defer")
    return { ok: false, reason: "platform-error", costUsd: gate.costUsd };
  return {
    ok: true,
    channel: "x",
    email: null,
    xHandle,
    fullName: args.fullName,
    phone: null,
    linkedinUrl: args.linkedinUrlHint ?? null,
    title: gate.roleText ?? args.titleHint ?? null,
    verdict: gate.verdict === "transient" ? "unclear" : gate.verdict,
    verdictReason: gate.reason,
    costUsd: gate.costUsd,
  };
}

/** Email channel: prescreen → findEmail → dedupe → verify → enrich → person gate. */
async function qualifyViaEmail(
  args: Parameters<typeof resolveVerifyEnrichQualify>[0],
): Promise<QualifiedContact> {
  const contact = await resolveAndVerifyContact({
    playName: args.playName,
    fullName: args.fullName,
    knownEmail: args.knownEmail,
    companyDomain: args.companyDomain,
    isDuplicate: args.isDuplicate,
    decisionContext: args.decisionContext,
    allowMissingFullName: args.allowMissingFullName,
    skipVerify: args.skipVerify,
    githubIdentity: args.githubIdentity,
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
    enrichedTitle: args.titleHint ?? contact.title ?? enr.title,
    enrichedSummary: enr.summary,
    linkedinUrl: enr.linkedinUrl ?? args.linkedinUrlHint ?? null,
    fillGaps: args.fillGaps ?? true,
    playName: args.playName,
    errKindPrefix: args.errKindPrefix ?? args.playName,
  });
  costUsd += gate.costUsd;

  if (gate.action === "reject") {
    return {
      ok: false,
      reason: "role",
      detail: gate.reason,
      email: contact.email,
      emailSource: contact.emailSource,
      costUsd,
    };
  }
  // A classifier/platform outage is not a verdict: surface it as the same
  // platform-error the callers already know how to defer and retry.
  if (gate.action === "defer") {
    return { ok: false, reason: "platform-error", costUsd };
  }

  return {
    ok: true,
    channel: "email",
    email: contact.email,
    emailSource: contact.emailSource,
    fullName: contact.fullName,
    phone: enr.phone,
    linkedinUrl: enr.linkedinUrl,
    title: gate.roleText ?? enr.title,
    // `reject` and `transient` returned above, so what reaches here is a
    // settled pass or an unresolved unclear. Both worth persisting.
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
