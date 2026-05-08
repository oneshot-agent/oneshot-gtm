import {
  deepResearchPerson,
  enrichProfile,
  findEmail,
  getLedger,
  logEvent,
  verifyEmail,
} from "@oneshot-gtm/core";
import type { CompetitorSwitchTarget } from "@oneshot-gtm/plays";
import { isDuplicate } from "./_dedupe.ts";
import { icpFilter } from "./_filter.ts";
import {
  fetchGitHubUser,
  ownerFromRepoUrl,
  repoNameFromRepoUrl,
  type GitHubUserInfo,
} from "./_github-user.ts";
import { extractFirstPhone, findLinkedInUrl } from "./_linkedin.ts";
import { detectRepoStack } from "./_repo-stack.ts";
import type { AgentBuilderExtract, FinderResult } from "./_types.ts";

/**
 * Shared per-candidate pipeline for repo-style finders. Today it has one
 * caller (`github-topics`); kept as its own module because the per-candidate
 * body — snippet ICP → GitHub manifest scan + user fetch → minVendors gate →
 * resolveContact (3-tier: extract domain → GitHub user → deepResearchPerson) →
 * verifyEmail → enqueue — is large enough that inlining it back would obscure
 * the finder, and ctx-based parameterisation keeps the door open for future
 * repo finders without re-extracting later.
 *
 * Stack detection used to be a webRead + LLM extract on the README, which
 * (a) timed out ~44% of the time on JS-rendered GitHub pages and (b) read
 * marketing copy that didn't reflect actual code. We now pull the truth
 * directly from package.json / pyproject.toml / requirements.txt /
 * .env.example via the GitHub Contents API. Free, fast, deterministic.
 */
const PLAY_NAME = "competitor-switch";

export interface RepoCandidate {
  /** Normalized github.com/<owner>/<repo>. */
  url: string;
  title: string;
  description: string;
  /**
   * Pre-discovery vendor hints. github-topics leaves this empty — vendors are
   * detected later via `detectRepoStack` against the repo's manifests.
   * Reserved for future repo-finders that arrive with a known vendor signal
   * at discovery time (would short-circuit the manifest scan).
   */
  vendors: string[];
  /**
   * GitHub topic tags (self-tagged by maintainers). github-topics fills these
   * for the snippet ICP signal.
   */
  topics?: string[];
}

export interface RepoPipelineCtx {
  icp: string | null;
  /** Founder's vendor list — passed to detectRepoStack as the matching vocabulary. */
  vocab: string[];
  yourEdge: string;
  minVendors: number;
  useDeepResearch: boolean;
  /** Mutable accumulator. Workers mutate fields on this directly. */
  result: FinderResult;
  /**
   * Boxed flag so workers share the same reference across the parallelMap
   * pool. Soft halt: workers check at the top of each iteration but several
   * may pass before any flips it — over-shoot up to (concurrency-1) is
   * acceptable for the scales we operate at.
   */
  halted: { value: boolean };
  limit: number;
  maxCostUsd: number | undefined;
  /** Receipt source tag, e.g. "find:github-topics". */
  sourceTag: string;
  /** Notes-line prefix, e.g. "github-topic". */
  notesPrefix: string;
  dryRun: boolean;
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
  if (ledger.isQueueDuplicate(PLAY_NAME, hit.url)) {
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

  // 1) ICP on the snippet — cheap pre-filter. Skips the manifest scan +
  //    user-fetch + contact-resolution chain on candidates the classifier
  //    rejects, which is most of them in practice.
  const snippetFilter = await icpFilter({
    icp: ctx.icp,
    candidate: {
      title: hit.title,
      url: hit.url,
      summary: describeForIcp(hit),
    },
  });
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

  // 2) Stack detection — deterministic GitHub-API scan of manifest files
  // (package.json, pyproject.toml, requirements.txt, .env.example) instead
  // of webRead + LLM extract. Three reasons:
  //   - webRead timed out on ~44% of GitHub repo pages (JS-rendered)
  //   - READMEs are marketing copy that don't always match what code imports
  //   - Manifest scanning is free (counts against GITHUB_TOKEN's 5k/hr) and
  //     authoritative — if `openai` is in package.json the repo uses OpenAI
  //
  // Author / company come from the GitHub user profile (also free).
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
    // Prefer the human-friendly name; many GitHub users leave it blank.
    // findEmail downstream short-circuits gracefully when this is null.
    authorFullName: ghUserInfo?.name ?? null,
    authorRole: null, // not derivable from GitHub user API
    companyName: ghUserInfo?.company ?? null,
    // The GitHub blog field is a single bare hostname — we don't have enough
    // signal to know if it's corporate or personal, so map it to companyDomain
    // and leave personalDomain null. The resolveContact fallback chain reads
    // both via `?? null`, so the choice doesn't change behavior.
    companyDomain: ghUserInfo?.blogDomain ?? null,
    personalDomain: null,
    stackDetected: stack.detected,
    summary: null,
  };

  // 3) Resolve a contact (3-tier: extract domain → GitHub user → deepResearch).
  // Pass the already-fetched ghUserInfo so resolveContact doesn't re-fetch.
  const contact = await resolveContact({
    extract,
    repoUrl: hit.url,
    ghUser: ghUserInfo,
    accumCost,
    useDeepResearch: ctx.useDeepResearch,
    errKindPrefix,
  });
  if (!contact) {
    result.droppedEnrichment++;
    return;
  }

  if (isDuplicate({ playName: PLAY_NAME, dedupeKey: hit.url, prospectEmail: contact.email })) {
    result.droppedDuplicate++;
    return;
  }

  // verifyEmail can throw on transient SDK / network errors. Catch and drop
  // the candidate rather than letting one bad call tear down the pool —
  // identical reasoning to the findEmail wrap in resolveContact.tryFindEmail.
  let verified: Awaited<ReturnType<typeof verifyEmail>>;
  try {
    verified = await verifyEmail({ email: contact.email }, { playName: PLAY_NAME });
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: `${errKindPrefix}.verify_email`,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    result.droppedEnrichment++;
    return;
  }
  accumCost(verified.result.cost ?? 0);
  if (!verified.result.deliverable) {
    result.droppedEnrichment++;
    return;
  }

  const stackLine = extract.stackDetected.join(", ");
  const vendorCount = extract.stackDetected.length;
  const evidenceText =
    `Their repo stitches together ${stackLine} — ${vendorCount} separate auth ` +
    `surfaces and ${vendorCount} bills to manage.`;
  const competitorLabel = extract.stackDetected[0] as string;
  const companyFallback = contact.domain ?? contact.email.split("@")[1] ?? "";

  const target: CompetitorSwitchTarget = {
    name: extract.authorFullName ?? contact.fullName ?? extract.githubHandle ?? "there",
    email: contact.email,
    company: extract.companyName ?? extract.githubHandle ?? companyFallback,
    competitor: competitorLabel,
    evidenceUrl: hit.url,
    evidenceText,
    yourEdge: ctx.yourEdge,
    ...(contact.linkedinUrl ? { linkedinUrl: contact.linkedinUrl } : {}),
    ...(contact.phone ? { phone: contact.phone } : {}),
  };
  const notes = truncate(
    `${ctx.notesPrefix}: ${stackLine} (${vendorCount} vendors) — ${snippetFilter.reason}`,
    220,
  );
  const id = ledger.enqueueTarget({
    playName: PLAY_NAME,
    payload: target,
    dedupeKey: hit.url,
    source: ctx.sourceTag,
    notes,
  });
  if (id != null) result.enqueued++;
  else result.droppedDuplicate++;
}

interface ResolvedContact {
  email: string;
  /** Best-effort full name from findEmail; null when GitHub provided the email directly. */
  fullName: string | null;
  /** The domain we ultimately used. Null only when we got a direct GitHub email and no blog/extract domain. */
  domain: string | null;
  /** LinkedIn URL surfaced during contact resolution (Path B' webSearch or enrichProfile). Null when none found. */
  linkedinUrl: string | null;
  /** Phone number surfaced during contact resolution (Path C deepResearch enrichment). Null when none found. */
  phone: string | null;
}

/**
 * Resolve a deliverable contact for a repo candidate.
 *
 * Decision tree (cheapest path first; one paid call per tier):
 *   1. extract has a domain → findEmail($0.005). Done if found.
 *   2. GitHub user provides an email directly → use it (no findEmail spend).
 *   3. (opt-in) deepResearchPerson($0.05, 2-5 min async) with the repo URL +
 *      author name — recovers the bucket where nobody has a resolvable
 *      companyDomain anywhere.
 *
 * The pre-fetched `ghUser` is required from the pipeline (we already fetch
 * it for the extract construction); accepting it here avoids a duplicate
 * lookup. Pass null if the candidate isn't a GitHub repo.
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
}): Promise<ResolvedContact | null> {
  const { extract, repoUrl, ghUser, accumCost, useDeepResearch } = args;
  const errKindPrefix = args.errKindPrefix ?? "repo-pipeline";
  const extractDomain = extract.companyDomain ?? extract.personalDomain ?? null;
  let discoveredLinkedinUrl: string | null = null;

  // Path A: extract has a domain. Try findEmail with it.
  if (extractDomain) {
    const direct = await tryFindEmail(extractDomain, extract, accumCost, errKindPrefix);
    if (direct)
      return {
        ...direct,
        domain: extractDomain,
        linkedinUrl: discoveredLinkedinUrl,
        phone: null,
      };
    // Fall through.
  }

  // Path B: GitHub user provides an email directly.
  if (ghUser?.email) {
    return {
      email: ghUser.email,
      fullName: null,
      domain: ghUser.blogDomain ?? extractDomain,
      linkedinUrl: discoveredLinkedinUrl,
      phone: null,
    };
  }

  // Path B': webSearch for the author's LinkedIn URL → enrichProfile to recover
  // company / company_domain / sometimes email. Bridges the common case where
  // GitHub gives us a name but no company/blog — without this, deep-research
  // (Path C) fails its required-identifier gate and the candidate drops.
  //
  // Cost when triggered: $0.01 webSearch + $0.005 enrichProfile = ~$0.015.
  // Skipped entirely when extract.companyName already known OR neither the
  // author name nor github handle is available.
  let companyForGate: string | null = extract.companyName ?? null;
  let domainForGate: string | null = extractDomain;
  if (!companyForGate && (extract.authorFullName || extract.githubHandle)) {
    const tokens = [extract.authorFullName, extract.githubHandle].filter((t): t is string =>
      Boolean(t),
    );
    const linkedinUrl = await findLinkedInUrl({
      fullName: tokens[0] ?? "",
      disambiguators: tokens.slice(1),
      accumCost,
      errKindPrefix,
    });
    if (linkedinUrl) {
      discoveredLinkedinUrl = linkedinUrl;
      try {
        const enriched = await enrichProfile({ linkedinUrl }, { playName: PLAY_NAME });
        accumCost(enriched.result.cost ?? 0);
        const profile = enriched.result.profile;
        // PersonResult exposes phone (string) AND fullphone (array) — extractFirstPhone
        // reads either. Capture once and reuse on every return path so we don't drop
        // a phone the SDK already paid to retrieve.
        const enrichedPhone = extractFirstPhone(profile);
        // 1) enrichProfile gave us a direct email — use it.
        if (profile?.email) {
          return {
            email: profile.email,
            fullName: profile.full_name ?? extract.authorFullName,
            domain: profile.company_domain ?? extractDomain,
            linkedinUrl: discoveredLinkedinUrl,
            phone: enrichedPhone,
          };
        }
        // 2) Got a company_domain — try findEmail with it.
        if (profile?.company_domain) {
          const viaEnriched = await tryFindEmail(
            profile.company_domain,
            { ...extract, authorFullName: profile.full_name ?? extract.authorFullName },
            accumCost,
            errKindPrefix,
          );
          if (viaEnriched)
            return {
              ...viaEnriched,
              domain: profile.company_domain,
              linkedinUrl: discoveredLinkedinUrl,
              phone: enrichedPhone,
            };
          domainForGate = profile.company_domain;
        }
        // 3) At minimum we may have learned a company name — feeds Path C's gate.
        if (profile?.company) companyForGate = profile.company;
      } catch (err) {
        logEvent(
          "error.swallowed",
          {
            kind: `${errKindPrefix}.enrich_profile`,
            message_120: ((err as Error).message ?? "").slice(0, 120),
          },
          "warn",
        );
      }
    }
  }

  // Path C: deep research as the last resort. The API needs strong identifiers
  // to find a person — empirically, `socialMediaUrl: <github-repo-url>` alone
  // is NOT enough (we burned $0.15 on three "Could not find data for this
  // person" failures with just that). Require either:
  //   (a) a known email, OR
  //   (b) full name AND company  (company may have been populated by Path B')
  // Anything weaker spends $0.05 on a near-guaranteed miss. The repoUrl is
  // still passed as `socialMediaUrl` for bonus signal when present.
  if (!useDeepResearch) return null;
  const hasName = Boolean(extract.authorFullName && extract.authorFullName.length > 0);
  const hasCompany = Boolean(companyForGate && companyForGate.length > 0);
  // We never have an email here by definition — Paths A/B both bail before
  // setting one, and a contact found earlier short-circuits before this tier.
  // Kept as a placeholder for future flexibility (e.g. a discovery layer that
  // surfaces a tentative email).
  const hasEmail = false;
  if (!hasEmail && !(hasName && hasCompany)) return null;
  try {
    const dr = await deepResearchPerson(
      {
        socialMediaUrl: repoUrl,
        ...(hasName ? { name: extract.authorFullName as string } : {}),
        ...(hasCompany ? { company: companyForGate as string } : {}),
      },
      { playName: PLAY_NAME },
    );
    accumCost(dr.result.cost ?? 0);
    const enr = dr.result.result?.enrichment;
    const drEmail = enr?.best_work_email ?? enr?.best_personal_email ?? enr?.altemails?.[0] ?? null;
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
      email: drEmail,
      fullName: drFullName,
      domain: domainForGate ?? ghUser?.blogDomain ?? drEmail.split("@")[1] ?? null,
      linkedinUrl: discoveredLinkedinUrl,
      phone: drPhone,
    };
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: `${errKindPrefix}.deep_research`,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return null;
  }
}

/**
 * Single findEmail attempt with consistent fault-handling. OneShot's
 * findEmail requires `full_name` (or first+last) — without one it throws
 * synchronously, and a throw here would tear down the parallelMap pool. We
 * short-circuit cleanly when there's no name, and catch the SDK throw on
 * transient network errors. Either failure mode returns null so the caller
 * falls through to the next contact-resolution tier.
 */
async function tryFindEmail(
  domain: string,
  extract: AgentBuilderExtract,
  accumCost: (c: number | undefined) => void,
  errKindPrefix: string,
): Promise<{ email: string; fullName: string | null } | null> {
  if (!extract.authorFullName || extract.authorFullName.length === 0) {
    return null;
  }
  let found: Awaited<ReturnType<typeof findEmail>>;
  try {
    found = await findEmail(
      { fullName: extract.authorFullName, companyDomain: domain },
      { playName: PLAY_NAME },
    );
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: `${errKindPrefix}.find_email`,
        domain,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return null;
  }
  accumCost(found.result.cost ?? 0);
  if (found.result.found && found.result.email) {
    return { email: found.result.email, fullName: found.result.full_name ?? null };
  }
  return null;
}

/**
 * Compose the snippet-ICP `summary` from whichever signal we have. Topic-driven
 * candidates (github-topics) carry the repo's self-tagged GitHub topics. The
 * `vendors` branch is reserved for future finders that surface known vendor
 * names at discovery. If neither is present, return the bare description
 * rather than emitting an empty `topics: ` tail.
 *
 * Exported for direct unit testing — integration coverage of both branches
 * would require a discovery shape that doesn't exist yet.
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
