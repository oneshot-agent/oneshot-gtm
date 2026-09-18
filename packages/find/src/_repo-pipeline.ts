import { safeFindEmail, safeVerifyEmail } from "./_sdk-safe.ts";
import { fetchProfileReadmeEmail, type EmailSource } from "./_github-readme.ts";
import { deepResearchPerson, enrichProfile, getLedger, logEvent } from "@oneshot-gtm/core";
import { dossierFromProviderResult, personPayloadPatch } from "./_person-research.ts";
import type { CompetitorSwitchTarget, StackConsolidationTarget } from "@oneshot-gtm/plays";
import { isDuplicate } from "./_dedupe.ts";
import { enqueueScoredTarget } from "./_priority-adapters.ts";
import { shouldSkipFindEmail } from "./_findemail-prescreen.ts";
import { icpFilter } from "./_filter.ts";
import { persistRoleRejection, qualifyPostEnrich } from "./_qualify.ts";
import {
  fetchGitHubUser,
  ownerFromRepoUrl,
  repoNameFromRepoUrl,
  type GitHubUserInfo,
} from "./_github-user.ts";
import { enrichVerifiedContact } from "./_enrich.ts";
import { extractFirstPhone, findLinkedInUrl } from "./_linkedin.ts";
import { detectRepoStack } from "./_repo-stack.ts";
import type { AgentBuilderExtract, FinderResult } from "./_types.ts";

/**
 * Shared per-candidate pipeline for repo-style finders: snippet ICP →
 * manifest scan + GitHub user fetch → minVendors gate → contact resolution
 * (3-tier) → verifyEmail → person gate → enqueue. Parameterised via ctx so
 * future repo finders can reuse it.
 */
const PLAY_NAME = "stack-consolidation";

export interface RepoCandidate {
  /** Normalized github.com/<owner>/<repo>. */
  url: string;
  title: string;
  description: string;
  /** Pre-discovery vendor hints; github-topics leaves empty (manifest scan later). */
  vendors: string[];
  /** GitHub topic tags, used as the snippet-ICP signal when present. */
  topics?: string[];
}

export interface RepoPipelineCtx {
  icp: string | null;
  /** Founder's vendor list — passed to detectRepoStack as the matching vocabulary. */
  vocab: string[];
  /**
   * Subset of `vocab` the founder competes with head-on. A candidate whose
   * detected stack includes one routes to competitor-switch; otherwise
   * stack-consolidation. Matched case-insensitively. Empty = always
   * stack-consolidation.
   */
  directCompetitors?: string[];
  yourEdge: string;
  minVendors: number;
  useDeepResearch: boolean;
  /** Mutable accumulator. Workers mutate fields on this directly. */
  result: FinderResult;
  /**
   * Boxed flag shared across the parallelMap pool. Soft halt — over-shoot up
   * to (concurrency-1) is acceptable.
   */
  halted: { value: boolean };
  limit: number;
  maxCostUsd: number | undefined;
  /** Receipt source tag, e.g. "find:github-topics". */
  sourceTag: string;
  /** Notes-line prefix, e.g. "github-topic". */
  notesPrefix: string;
  dryRun: boolean;
  /** Allow the paid fill-the-gap lookup in the person gate. Defaults to on. */
  qualifyFillGaps?: boolean;
}

/**
 * Process a single candidate through the full pipeline. Mutates ctx.result.
 * Never throws — internal exceptions become droppedEnrichment increments via
 * the surrounding try/catch blocks. Safe to call concurrently across workers.
 */
export async function processRepoCandidate(
  hit: RepoCandidate,
  ctx: RepoPipelineCtx,
): Promise<void> {
  const { result } = ctx;
  if (ctx.halted.value) return;
  if (result.enqueued >= ctx.limit) {
    ctx.halted.value = true;
    return;
  }
  if (ctx.maxCostUsd != null && result.costUsd >= ctx.maxCostUsd) {
    result.halted = `max-cost cap (${ctx.maxCostUsd})`;
    ctx.halted.value = true;
    return;
  }
  const ledger = getLedger();
  // The play isn't known until the stack is detected below, so check both
  // possible routes — a repo enqueued under either play is a duplicate.
  if (
    ledger.isQueueDuplicate("stack-consolidation", hit.url) ||
    ledger.isQueueDuplicate("competitor-switch", hit.url)
  ) {
    result.droppedDuplicate++;
    return;
  }

  if (ctx.dryRun) {
    result.enqueued++;
    return;
  }

  const accumCost = (c: number | undefined): void => {
    result.costUsd += c ?? 0;
  };
  const errKindPrefix = ctx.sourceTag.replace(/^find:/, "");

  // 1) ICP on the snippet — cheap pre-filter ahead of the paid chain.
  const snippetFilter = await icpFilter({
    icp: ctx.icp,
    candidate: {
      title: hit.title,
      url: hit.url,
      summary: describeForIcp(hit),
    },
  });
  if (snippetFilter.match === null) {
    // Transient classifier failure — drop without persisting. A rejection
    // would burn the dedupeKey forever (isQueueDuplicate ignores status).
    result.droppedEnrichment++;
    return;
  }
  if (!snippetFilter.match) {
    result.droppedIcp++;
    ledger.enqueueTarget({
      playName: PLAY_NAME,
      payload: { repoUrl: hit.url, title: hit.title, description: hit.description },
      dedupeKey: hit.url,
      source: ctx.sourceTag,
      initialStatus: "rejected",
      notes: `auto: ICP — ${snippetFilter.reason}`,
    });
    return;
  }

  // 2) Stack detection — deterministic manifest scan via the GitHub Contents
  // API (free, authoritative). Author/company come from the user profile.
  const owner = ownerFromRepoUrl(hit.url);
  const repoName = repoNameFromRepoUrl(hit.url);
  if (!owner || !repoName) {
    // Shouldn't happen for normalized URLs but defend against drift.
    result.droppedEnrichment++;
    return;
  }
  const [stack, ghUserInfo] = await Promise.all([
    detectRepoStack({ owner, repo: repoName, vocab: ctx.vocab }),
    fetchGitHubUser(owner),
  ]);

  if (stack.detected.length < ctx.minVendors) {
    logEvent("github-topics.dropped.min_vendors", {
      repo: `${owner}/${repoName}`,
      detected_count: stack.detected.length,
      manifests_found: stack.manifestsFound,
      min_vendors: ctx.minVendors,
    });
    result.droppedEnrichment++;
    return;
  }

  const extract: AgentBuilderExtract = {
    repoUrl: hit.url,
    githubHandle: owner,
    // Often blank on GitHub; findEmail downstream short-circuits on null.
    authorFullName: ghUserInfo?.name ?? null,
    authorRole: null, // not derivable from GitHub user API
    companyName: ghUserInfo?.company ?? null,
    // GitHub's blog field could be corporate or personal; mapped to
    // companyDomain — resolveContact reads both, so the choice is behavior-neutral.
    companyDomain: ghUserInfo?.blogDomain ?? null,
    personalDomain: null,
    stackDetected: stack.detected,
    summary: null,
  };

  // Route by direct-competitor match: head-on rival in the stack →
  // competitor-switch, else stack-consolidation. The resolved play name is
  // used for the rest of this candidate's pipeline (dedupe, receipts, enqueue).
  const directSet = new Set((ctx.directCompetitors ?? []).map((s) => s.toLowerCase()));
  const matchedCompetitor = extract.stackDetected.find((v) => directSet.has(v.toLowerCase()));
  const playName = matchedCompetitor ? "competitor-switch" : "stack-consolidation";

  // 3) Resolve and verify sources in order, with profile README last.
  // Pass the already-fetched ghUserInfo so resolveContact doesn't re-fetch.
  let contact: ResolvedContact | null;
  const attempted = new Set<string>();
  try {
    contact = await resolveContact({
      extract,
      repoUrl: hit.url,
      ghUser: ghUserInfo,
      accumCost,
      useDeepResearch: ctx.useDeepResearch,
      errKindPrefix,
      playName,
      accept: async (candidate) => {
        const email = candidate.email.toLowerCase();
        if (attempted.has(email)) return false;
        if (isDuplicate({ playName, dedupeKey: hit.url, prospectEmail: email }))
          throw new ContactStopped("duplicate");
        attempted.add(email);
        const verified = await safeVerifyEmail({ email }, { playName });
        accumCost(verified.result.cost ?? 0);
        if (candidate.emailSource)
          logEvent("github.readme.verification", {
            login: ghUserInfo?.login,
            ok: verified.result.deliverable === true,
            costUsd: verified.result.cost ?? 0,
          });
        if (verified.result.status === "error") throw new ContactStopped("platform-error");
        return verified.result.deliverable === true;
      },
    });
  } catch (error) {
    if (error instanceof ContactStopped && error.reason === "duplicate") result.droppedDuplicate++;
    else {
      logEvent("github.contact.deferred", { reason: "platform-error", playName }, "warn");
      result.droppedEnrichment++;
    }
    return;
  }
  if (!contact) {
    result.droppedEnrichment++;
    return;
  }

  // Always-on post-verify enrichment so phone + linkedin land on every queue
  // row; skipped when Path B' already populated them.
  if (!contact.phone || !contact.linkedinUrl || !contact.title) {
    const enr = await enrichVerifiedContact(contact.email, {
      playName,
      errKindPrefix,
    });
    accumCost(enr.costUsd);
    contact.phone = contact.phone ?? enr.phone;
    contact.linkedinUrl = contact.linkedinUrl ?? enr.linkedinUrl;
    contact.title = contact.title ?? enr.title;
    contact.summary = contact.summary ?? enr.summary;
  }

  // Person-level ICP gate. GitHub exposes no role, so the decision rests on
  // the (already-bought) enriched title.
  const gate = await qualifyPostEnrich({
    icp: ctx.icp,
    person: {
      name: extract.authorFullName ?? contact.fullName,
      company: extract.companyName,
      evidence: `public repo using ${extract.stackDetected.join(", ") || "an agent stack"}`,
    },
    enrichedTitle: contact.title,
    enrichedSummary: contact.summary,
    linkedinUrl: contact.linkedinUrl,
    fillGaps: ctx.qualifyFillGaps ?? true,
    alreadyEnrichedByLinkedin: contact.enrichedByLinkedin,
    playName,
    errKindPrefix,
  });
  accumCost(gate.costUsd);
  if (gate.action === "reject") {
    result.droppedRole = (result.droppedRole ?? 0) + 1;
    persistRoleRejection({
      // The resolved play, not the module constant — a competitor-routed repo
      // must audit under competitor-switch, or the override row lies.
      playName,
      dedupeKey: hit.url,
      payload: {
        repoUrl: hit.url,
        title: hit.title,
        email: contact.email,
        ...(contact.emailSource ? { emailSource: contact.emailSource } : {}),
      },
      source: ctx.sourceTag,
      reason: gate.reason,
      dryRun: ctx.dryRun,
    });
    return;
  }
  if (gate.action === "defer") {
    // Classifier/platform outage — not a verdict; retried, never blacklisted.
    result.droppedEnrichment++;
    return;
  }

  const stackLine = extract.stackDetected.join(", ");
  const vendorCount = extract.stackDetected.length;
  const companyFallback = contact.domain ?? contact.email.split("@")[1] ?? "";
  const name = extract.authorFullName ?? contact.fullName ?? extract.githubHandle ?? "there";
  const company = extract.companyName ?? extract.githubHandle ?? companyFallback;
  const gateTitle = gate.roleText ?? contact.title;
  // Path C research, when it ran, rides on the row as `personResearch` so the
  // post-finder step skips it (cache key = the owner's profile URL).
  const stashedResearch = contact.research
    ? (() => {
        const dossier = dossierFromProviderResult(
          {
            url: extract.githubHandle ? `https://github.com/${extract.githubHandle}` : null,
            email: contact.email,
            name: extract.authorFullName ?? contact.fullName,
            company: extract.companyName ?? null,
          },
          contact.research,
          { costUsd: 0, billed: false },
        );
        return dossier
          ? personPayloadPatch(
              {
                ...((extract.authorFullName ?? contact.fullName)
                  ? { name: extract.authorFullName ?? contact.fullName }
                  : {}),
                ...(extract.companyName ? { company: extract.companyName } : {}),
                ...(gateTitle ? { title: gateTitle } : {}),
              },
              dossier,
            )
          : {};
      })()
    : {};
  const contactExtras = {
    ...(contact.linkedinUrl ? { linkedinUrl: contact.linkedinUrl } : {}),
    ...(contact.phone ? { phone: contact.phone } : {}),
    ...(gateTitle ? { title: gateTitle } : {}),
    ...stashedResearch,
    // Durable re-enrichment key. When today's LinkedIn lookup misses, a later
    // backfill can work from the GitHub profile rather than a bare name.
    ...(extract.githubHandle
      ? { sourceProfileUrl: `https://github.com/${extract.githubHandle}` }
      : {}),
  };

  const target: CompetitorSwitchTarget | StackConsolidationTarget = matchedCompetitor
    ? {
        name,
        email: contact.email,
        company,
        competitor: matchedCompetitor,
        evidenceUrl: hit.url,
        // Honest, specific evidence. Setting evidenceText also makes
        // competitor-switch skip its (expensive) browser scrape.
        evidenceText: `Their public repo uses ${matchedCompetitor} (found in ${stack.manifestsFound.join(", ")}).`,
        yourEdge: ctx.yourEdge,
        ...contactExtras,
      }
    : {
        name,
        email: contact.email,
        company,
        vendorStack: stackLine,
        evidenceUrl: hit.url,
        yourEdge: ctx.yourEdge,
        ...contactExtras,
      };
  const notes = truncate(
    `${ctx.notesPrefix}: ${stackLine} (${vendorCount} vendors) — ${snippetFilter.reason}`,
    220,
  );
  const id = enqueueScoredTarget(ledger, {
    playName,
    payload: { ...target, ...(contact.emailSource ? { emailSource: contact.emailSource } : {}) },
    dedupeKey: hit.url,
    source: ctx.sourceTag,
    fitReason: snippetFilter.reason,
    notes,
  });
  if (id != null) result.enqueued++;
  else result.droppedDuplicate++;
}

/** Job title off a PersonResult, with the same is_primary fallback as _enrich. */
function profileTitle(profile: unknown): string | null {
  const p = profile as {
    title?: string | null;
    experience?: Array<{ title?: { name?: string | null } | null; is_primary?: boolean }> | null;
  } | null;
  const direct = typeof p?.title === "string" ? p.title.trim() : "";
  if (direct.length > 0) return direct;
  if (Array.isArray(p?.experience)) {
    const primary = p.experience.find((e) => e?.is_primary) ?? p.experience[0];
    const name = primary?.title?.name;
    if (typeof name === "string" && name.trim().length > 0) return name.trim();
  }
  return null;
}

class ContactStopped extends Error {
  constructor(readonly reason: "duplicate" | "platform-error") {
    super(reason);
    this.name = "ContactStopped";
  }
}

interface ResolvedContact {
  emailSource?: EmailSource;
  email: string;
  /** From findEmail; null when GitHub gave us the email directly. */
  fullName: string | null;
  /** The domain we used; null only on a direct GitHub email with no blog/extract domain. */
  domain: string | null;
  /** Surfaced via Path B' webSearch / enrichProfile. */
  linkedinUrl: string | null;
  /** Surfaced via Path C deepResearch enrichment. */
  phone: string | null;
  /** Job title, when any enrichment path surfaced one. Feeds the ICP gate. */
  title: string | null;
  /** The raw deepResearchPerson result when Path C ran — stashed on the row as `personResearch`. */
  research?: unknown;
  /** Free-text bio/headline from post-verify enrichment. Secondary gate evidence. */
  summary: string | null;
  /**
   * True when Path B' already ran enrichProfile against `linkedinUrl` — lets
   * the ICP gate skip a duplicate fill-the-gap lookup.
   */
  enrichedByLinkedin: boolean;
}

/**
 * Resolve a deliverable contact for a repo candidate, cheapest path first:
 * GitHub user email, domain lookup, optional enrichment/research, then profile README. `ghUser` is passed pre-fetched to avoid a duplicate
 * lookup; null if the candidate isn't a GitHub repo.
 */
export async function resolveContact(args: {
  extract: AgentBuilderExtract;
  repoUrl: string;
  /** Pre-fetched GitHub user info from the pipeline. Null when unavailable. */
  ghUser: GitHubUserInfo | null;
  accumCost: (c: number | undefined) => void;
  useDeepResearch: boolean;
  /** Used in the deep-research error event kind, e.g. "github-topics". */
  errKindPrefix?: string;
  /** Resolved motion play, used to tag the receipts this resolution spends on. */
  playName?: string;
  /** Called before accepting a source; false continues to the next source. */
  accept?: (contact: ResolvedContact) => Promise<boolean>;
}): Promise<ResolvedContact | null> {
  const { extract, repoUrl, ghUser, accumCost, useDeepResearch } = args;
  const accept = args.accept ?? (async () => true);
  const errKindPrefix = args.errKindPrefix ?? "repo-pipeline";
  const playName = args.playName ?? PLAY_NAME;
  const extractDomain = extract.companyDomain ?? extract.personalDomain ?? null;
  let discoveredLinkedinUrl: string | null = null;
  // True once Path B' has paid for an enrichProfile keyed by that URL, so the
  // ICP gate never buys the same lookup a second time.
  let didEnrichByLinkedin = false;

  // LinkedIn capture runs for EVERY candidate, ahead of the email paths — it
  // is a first-class output read by all return paths, not a side effect of
  // company recovery. Cached inside findLinkedInUrl.
  if (extract.authorFullName || extract.githubHandle) {
    const nameTokens = [extract.authorFullName, extract.githubHandle].filter((t): t is string =>
      Boolean(t),
    );
    discoveredLinkedinUrl = await findLinkedInUrl({
      fullName: nameTokens[0] ?? "",
      disambiguators: [...nameTokens.slice(1), extract.companyName ?? ""].filter(
        (s) => s.length > 0,
      ),
      accumCost,
      errKindPrefix,
    });
  }

  // Public profile email precedes paid discovery.
  if (ghUser?.email) {
    const candidate: ResolvedContact = {
      title: null,
      summary: null,
      enrichedByLinkedin: didEnrichByLinkedin,
      email: ghUser.email,
      fullName: ghUser.name,
      domain: ghUser.blogDomain ?? extractDomain,
      linkedinUrl: discoveredLinkedinUrl,
      phone: null,
    };
    if (await accept(candidate)) return candidate;
  }
  if (extractDomain) {
    const direct = await tryFindEmail(extractDomain, extract, accumCost, errKindPrefix, playName);
    if (direct) {
      const candidate: ResolvedContact = {
        title: null,
        summary: null,
        enrichedByLinkedin: didEnrichByLinkedin,
        ...direct,
        domain: extractDomain,
        linkedinUrl: discoveredLinkedinUrl,
        phone: null,
      };
      if (await accept(candidate)) return candidate;
    }
  }

  // Path B': enrichProfile off the LinkedIn URL, to recover company /
  // company_domain / sometimes email — without it, Path C fails its
  // required-identifier gate. The paid enrichProfile only fires when a
  // company is still missing.
  let companyForGate: string | null = extract.companyName ?? null;
  let domainForGate: string | null = extractDomain;
  if (!companyForGate && discoveredLinkedinUrl) {
    const linkedinUrl = discoveredLinkedinUrl;
    try {
      const enriched = await enrichProfile({ linkedinUrl }, { playName });
      didEnrichByLinkedin = true;
      accumCost(enriched.result.cost ?? 0);
      if (enriched.result.status === "error") throw new ContactStopped("platform-error");
      const profile = enriched.result.profile;
      // Captured once and reused on every return path.
      const enrichedPhone = extractFirstPhone(profile);
      // Cache the linkedin-keyed enrich by the SURFACED email so the later
      // by-email enrichVerifiedContact becomes a cache hit. Only when
      // profile.email is directly surfaced — a findEmail-derived email may be
      // a different person, and caching it would poison.
      if (profile?.email) {
        try {
          getLedger().setCachedEnrichment(
            profile.email.trim().toLowerCase(),
            JSON.stringify(enriched.result),
          );
        } catch {
          // cache write is best-effort.
        }
      }
      // 1) enrichProfile gave us a direct email — use it.
      if (profile?.email) {
        const candidate: ResolvedContact = {
          title: profileTitle(profile),
          summary: null,
          enrichedByLinkedin: didEnrichByLinkedin,
          email: profile.email,
          fullName: profile.full_name ?? extract.authorFullName,
          domain: profile.company_domain ?? extractDomain,
          linkedinUrl: discoveredLinkedinUrl,
          phone: enrichedPhone,
        };
        if (await accept(candidate)) return candidate;
      }
      // 2) Got a company_domain — try findEmail with it.
      if (profile?.company_domain) {
        const viaEnriched = await tryFindEmail(
          profile.company_domain,
          { ...extract, authorFullName: profile.full_name ?? extract.authorFullName },
          accumCost,
          errKindPrefix,
          playName,
        );
        if (viaEnriched) {
          const candidate: ResolvedContact = {
            title: profileTitle(profile),
            summary: null,
            enrichedByLinkedin: didEnrichByLinkedin,
            ...viaEnriched,
            domain: profile.company_domain,
            linkedinUrl: discoveredLinkedinUrl,
            phone: enrichedPhone,
          };
          if (await accept(candidate)) return candidate;
        }
        domainForGate = profile.company_domain;
      }
      // 3) At minimum we may have learned a company name — feeds Path C's gate.
      if (profile?.company) companyForGate = profile.company;
    } catch (err) {
      if (err instanceof ContactStopped) throw err;
      logEvent(
        "error.swallowed",
        {
          kind: `${errKindPrefix}.enrich_profile`,
          message_120: ((err as Error).message ?? "").slice(0, 120),
        },
        "warn",
      );
      throw new ContactStopped("platform-error");
    }
  }

  async function researchContact(): Promise<ResolvedContact | null> {
    // Last existing paid stage, ahead of the README. The API needs strong
    // identifiers — a repo URL alone is empirically not enough, so require a
    // known email OR full name AND company; the repoUrl still rides along as
    // `socialMediaUrl` for bonus signal.
    if (!useDeepResearch) return null;
    const hasName = Boolean(extract.authorFullName && extract.authorFullName.length > 0);
    const hasCompany = Boolean(companyForGate && companyForGate.length > 0);
    // Never true here by definition (earlier paths short-circuit on a found
    // contact); kept as a placeholder for a future tentative-email source.
    const hasEmail = false;
    if (!hasEmail && !(hasName && hasCompany)) return null;
    try {
      const dr = await deepResearchPerson(
        {
          // The owner's profile, not the repo: that is the URL the person-research
          // cache is keyed on, so a later backfill is a hit instead of a re-buy.
          socialMediaUrl: ghUser ? `https://github.com/${ghUser.login}` : repoUrl,
          ...(hasName ? { name: extract.authorFullName as string } : {}),
          ...(hasCompany ? { company: companyForGate as string } : {}),
        },
        { playName },
      );
      accumCost(dr.result.cost ?? 0);
      if (dr.result.status === "error") throw new ContactStopped("platform-error");
      const enr = dr.result.result?.enrichment;
      const drEmail =
        enr?.best_work_email ?? enr?.best_personal_email ?? enr?.altemails?.[0] ?? null;
      if (!drEmail) return null;
      const drFullName =
        [enr?.firstname, enr?.lastname]
          .filter((p): p is string => Boolean(p))
          .join(" ")
          .trim() ||
        enr?.displayname ||
        null;
      const drPhone = extractFirstPhone(enr);
      return {
        title: null,
        summary: null,
        enrichedByLinkedin: didEnrichByLinkedin,
        research: dr.result,
        email: drEmail,
        fullName: drFullName,
        domain: domainForGate ?? ghUser?.blogDomain ?? drEmail.split("@")[1] ?? null,
        linkedinUrl: discoveredLinkedinUrl,
        phone: drPhone,
      };
    } catch (err) {
      if (err instanceof ContactStopped) throw err;
      logEvent(
        "error.swallowed",
        {
          kind: `${errKindPrefix}.deep_research`,
          message_120: ((err as Error).message ?? "").slice(0, 120),
        },
        "warn",
      );
      throw new ContactStopped("platform-error");
    }
  }
  const researched = await researchContact();
  if (researched && (await accept(researched))) return researched;

  // README is last, including when optional research is disabled or ineligible.
  if (!ghUser) return null;
  const readme = await fetchProfileReadmeEmail(ghUser);
  if (readme.status === "unavailable") throw new ContactStopped("platform-error");
  if (readme.status !== "found") return null;
  const candidate: ResolvedContact = {
    email: readme.email,
    fullName: ghUser.name,
    domain: ghUser.blogDomain,
    linkedinUrl: discoveredLinkedinUrl,
    phone: null,
    title: null,
    summary: null,
    enrichedByLinkedin: didEnrichByLinkedin,
    emailSource: {
      kind: "github-profile-readme",
      url: readme.url,
      resolvedAt: new Date().toISOString(),
    },
  };
  const accepted = await accept(candidate);
  return accepted ? candidate : null;
}

/**
 * Single findEmail attempt with consistent fault-handling. findEmail throws
 * synchronously without a `full_name`, and any throw here would tear down the
 * parallelMap pool — both failure modes return null so the caller falls
 * through to the next tier.
 */
async function tryFindEmail(
  domain: string,
  extract: AgentBuilderExtract,
  accumCost: (c: number | undefined) => void,
  errKindPrefix: string,
  playName: string,
): Promise<{ email: string; fullName: string | null } | null> {
  if (!extract.authorFullName || extract.authorFullName.length === 0) {
    return null;
  }
  const skip = shouldSkipFindEmail({
    fullName: extract.authorFullName,
    companyDomain: domain,
  });
  if (!skip.ok) {
    logEvent(
      "finder.skipped_findemail",
      { name: playName, reason: skip.reason, kind: `${errKindPrefix}.find_email` },
      "info",
    );
    return null;
  }
  const found = await safeFindEmail(
    { fullName: extract.authorFullName, companyDomain: domain },
    { playName },
  );
  accumCost(found.result.cost ?? 0);
  if (found.result.status === "error") throw new ContactStopped("platform-error");
  if (found.result.found && found.result.email) {
    return { email: found.result.email, fullName: found.result.full_name ?? null };
  }
  return null;
}

/**
 * Compose the snippet-ICP `summary` from whichever signal is present
 * (vendors, topics, or bare description — never an empty `topics:` tail).
 * Exported for direct unit testing.
 */
export function describeForIcp(hit: RepoCandidate): string {
  if (hit.vendors.length > 0) {
    return `${hit.description}  vendors: ${hit.vendors.join(", ")}`;
  }
  const topics = hit.topics ?? [];
  if (topics.length > 0) {
    return `${hit.description}  topics: ${topics.join(", ")}`;
  }
  return hit.description;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
