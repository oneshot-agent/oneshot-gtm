import { findEmail, getLedger, logEvent, parallelMap, verifyEmail } from "@oneshot-gtm/core";
import type { FindEmailInput } from "@oneshot-gtm/core";
import type { CompetitorSwitchTarget, RepoInterestTarget } from "@oneshot-gtm/plays";
import { isDuplicate } from "./_dedupe.ts";
import { enrichVerifiedContact } from "./_enrich.ts";
import { shouldSkipFindEmail } from "./_findemail-prescreen.ts";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { fetchGitHubUser } from "./_github-user.ts";
import { recentStargazers, type Stargazer } from "./_stargazers.ts";
import type { FinderResult, RunOpts } from "./_types.ts";

const PLAY_NAME = "github-stars";

/** A repo the founder watches, tagged with how it relates to their product. */
export interface RepoWatch {
  /** "owner/name". */
  repo: string;
  /** `competitor` → competitor-switch pitch; `adjacent` → repo-interest pitch. */
  rel: "competitor" | "adjacent";
  /** Display label (e.g. "Apollo"); falls back to the repo's name segment. */
  label?: string;
  /**
   * Optional, per-repo: one true line about why THIS repo is notable plus how
   * your offer bridges to it respectfully. Surfaced to the email as a
   * shared-taste nod (never flattery) that also shapes the offer's framing —
   * e.g. a privacy-first repo's edge leads the pitch with control/auditability
   * rather than "we do it for you". Adjacent repos only (→ repo-interest).
   */
  repoEdge?: string;
}

export interface GitHubStarsFinderOpts extends RunOpts {
  repos: RepoWatch[];
  /** Fed to whichever play a candidate routes to. */
  yourEdge: string;
  /** Only consider stars within the last N days. Default 30. */
  sinceDays?: number;
  /** Per-candidate pipelines in flight at once. Default 3. */
  concurrency?: number;
}

type Candidate = Stargazer & {
  repo: string;
  rel: RepoWatch["rel"];
  label: string;
  repoEdge?: string;
};

function deriveLabel(repo: string): string {
  return repo.split("/")[1]?.trim() || repo;
}

function sourceFor(repo: string): string {
  return `find:${PLAY_NAME}:${repo}`;
}

/**
 * github-stars finder: recent stargazers of watched repos → prospects, routed
 * by each repo's founder-tagged `rel`. A `competitor` repo's stargazers become
 * `competitor-switch` rows ("why teams switch from X"); an `adjacent` repo's
 * become `repo-interest` rows ("you're into X — my product helps"). Reuses the
 * shared finder stack (ICP filter, findEmail/verify/enrich, dedupe, prescreen)
 * and the soft-cap loop pattern from show-hn / accelerator-batch.
 */
export async function runGitHubStarsFinder(opts: GitHubStarsFinderOpts): Promise<FinderResult> {
  const limit = opts.limit ?? 25;
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const sinceDays = opts.sinceDays ?? 30;
  const sinceIso = new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString();
  const icp = resolveIcp(opts.icpOverride);
  const ledger = getLedger();

  const result: FinderResult = {
    source: `find:${PLAY_NAME}`,
    candidates: 0,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    enqueued: 0,
    costUsd: 0,
  };

  logEvent("finder.start", {
    name: PLAY_NAME,
    repos: opts.repos.length,
    since_days: sinceDays,
    limit,
  });

  // Step 1: gather recent stargazers across all watched repos, tagged with the
  // repo's rel/label. Per-repo errors log + continue (handled in _stargazers).
  const tagged: Candidate[] = [];
  let firstError: string | null = null;
  let newestSeen: string | null = null; // newest star across all repos, ignoring the window
  for (const w of opts.repos) {
    const { stargazers, error, newestSeen: repoNewest } = await recentStargazers(w.repo, {
      sinceIso,
    });
    if (error && !firstError) firstError = `${w.repo}: ${error}`;
    if (repoNewest && (!newestSeen || repoNewest > newestSeen)) newestSeen = repoNewest;
    const label = w.label?.trim() || deriveLabel(w.repo);
    const repoEdge = w.repoEdge?.trim();
    for (const s of stargazers) {
      tagged.push({ ...s, repo: w.repo, rel: w.rel, label, ...(repoEdge ? { repoEdge } : {}) });
    }
  }

  // Cross-repo dedupe by login (someone starring two watched repos surfaces once).
  const seen = new Set<string>();
  const candidates = tagged.filter((c) => {
    const k = c.login.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  result.candidates = candidates.length;

  if (candidates.length === 0) {
    // Distinguish a fetch failure (usually the unauth rate limit) from an honest
    // empty window, and when empty, say how stale the newest star is so the
    // founder knows to widen `sinceDays` rather than wonder what broke.
    if (firstError) {
      result.halted = `github fetch failed (${firstError}) — set GITHUB_TOKEN for higher rate limits`;
    } else if (newestSeen) {
      const ageDays = Math.floor((Date.now() - new Date(newestSeen).getTime()) / 86_400_000);
      result.halted = `no stars in last ${sinceDays}d — newest was ${ageDays}d ago; widen sinceDays`;
    } else {
      result.halted = "no stargazers found (check repo names / GITHUB_TOKEN)";
    }
    logEvent("finder.done", { name: PLAY_NAME, candidates: 0, halted: result.halted });
    return result;
  }

  // Step 2: per-candidate pipeline (parallel, soft-capped on limit + cost).
  let halted = false;
  await parallelMap(candidates, concurrency, async (c) => {
    if (halted) return;
    if (result.enqueued >= limit) {
      halted = true;
      return;
    }
    if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      halted = true;
      return;
    }

    const playName = c.rel === "competitor" ? "competitor-switch" : "repo-interest";
    const dedupeKey = `${PLAY_NAME}:${c.repo}:${c.login}`;
    if (ledger.isQueueDuplicate(playName, dedupeKey)) {
      result.droppedDuplicate++;
      return;
    }

    const user = await fetchGitHubUser(c.login);
    if (!user) {
      result.droppedEnrichment++;
      return;
    }
    const fullName = user.name ?? c.login;

    // ICP filter on the resolved profile + the repo they starred.
    const filter = await icpFilter({
      icp,
      candidate: {
        title: fullName,
        url: c.userUrl,
        summary: [user.company, `starred ${c.repo}`].filter(Boolean).join(" · "),
      },
    });
    if (!filter.match) {
      result.droppedIcp++;
      // Persist the auto-rejection for review (skipped on dry-run previews).
      if (!opts.dryRun) {
        ledger.enqueueTarget({
          playName,
          payload: { name: fullName, company: user.company ?? "", repo: c.repo },
          dedupeKey,
          source: sourceFor(c.repo),
          initialStatus: "rejected",
          notes: `auto: ICP — ${filter.reason}`,
        });
      }
      return;
    }

    // Dry-run preview: count ICP-passers, skip the paid enrich + enqueue.
    if (opts.dryRun) {
      result.enqueued++;
      return;
    }

    // Resolve an email: public profile email first, else findEmail via the
    // blog domain (gated by the prescreen). No domain + no public email → drop.
    let email = user.email;
    if (!email) {
      const domain = user.blogDomain;
      if (!domain) {
        result.droppedEnrichment++;
        return;
      }
      const skip = shouldSkipFindEmail({ fullName, companyDomain: domain });
      if (!skip.ok) {
        result.droppedEnrichment++;
        logEvent("finder.skipped_findemail", { name: PLAY_NAME, reason: skip.reason }, "info");
        return;
      }
      const findInput: FindEmailInput = { companyDomain: domain, fullName };
      const found = await findEmail(findInput, { playName: PLAY_NAME });
      result.costUsd += found.result.cost ?? 0;
      if (!found.result.found || !found.result.email) {
        result.droppedEnrichment++;
        return;
      }
      email = found.result.email;
    }

    const verified = await verifyEmail({ email }, { playName: PLAY_NAME });
    result.costUsd += verified.result.cost ?? 0;
    if (!verified.result.deliverable) {
      result.droppedEnrichment++;
      return;
    }

    if (isDuplicate({ playName, dedupeKey, prospectEmail: email })) {
      result.droppedDuplicate++;
      return;
    }

    const enr = await enrichVerifiedContact(email, {
      playName: PLAY_NAME,
      errKindPrefix: PLAY_NAME,
    });
    result.costUsd += enr.costUsd;

    const company = user.company?.trim() || "(unknown)";
    const repoUrl = `https://github.com/${c.repo}`;
    const contactExtras = {
      ...(enr.linkedinUrl ? { linkedinUrl: enr.linkedinUrl } : {}),
      ...(enr.phone ? { phone: enr.phone } : {}),
    };

    const target: CompetitorSwitchTarget | RepoInterestTarget =
      c.rel === "competitor"
        ? {
            name: fullName,
            email,
            company,
            competitor: c.label,
            evidenceUrl: repoUrl,
            // Pre-supplied evidence → competitor-switch skips its browser scrape
            // (a code page has no "pain points" to extract).
            evidenceText: `Starred ${c.label}'s repo (${c.repo}) on ${c.starredAt.slice(0, 10)} — actively evaluating tools in this space.`,
            yourEdge: opts.yourEdge,
            ...contactExtras,
          }
        : {
            name: fullName,
            email,
            company,
            repo: c.repo,
            repoLabel: c.label,
            yourEdge: opts.yourEdge,
            ...(c.repoEdge ? { repoEdge: c.repoEdge } : {}),
            evidenceUrl: repoUrl,
            ...contactExtras,
          };

    const id = ledger.enqueueTarget({
      playName,
      payload: target,
      dedupeKey,
      source: sourceFor(c.repo),
      notes: filter.reason,
    });
    if (id != null) result.enqueued++;
    else result.droppedDuplicate++;
  });

  logEvent("finder.done", {
    name: PLAY_NAME,
    candidates: result.candidates,
    enqueued: result.enqueued,
    dropped_icp: result.droppedIcp,
    dropped_dup: result.droppedDuplicate,
    dropped_enrich: result.droppedEnrichment,
    cost_usd: result.costUsd,
    halted: result.halted ?? null,
  });
  return result;
}
