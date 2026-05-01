import { resolveIcp } from "./_filter.ts";
import { isoDateNDaysAgo, searchTopicRepos } from "./_github-search.ts";
import { parallelMap } from "./_parallel.ts";
import {
  processRepoCandidate,
  type RepoCandidate,
  type RepoPipelineCtx,
} from "./_repo-pipeline.ts";
import type { FinderResult, RunOpts } from "./_types.ts";
import { looksLikeNoiseRepo, normalizeRepoUrl } from "./_repo-utils.ts";

/**
 * GitHub-Topic-driven finder. Discovers repos via the (free) GitHub Search
 * API filtered by `topic:<slug>`, then hands each candidate to the shared
 * `_repo-pipeline.ts` (snippet-ICP → webRead → extract → resolveContact →
 * enqueue).
 *
 * Why topic search vs the retired combo-search approach: topic-tagged repos
 * are pre-curated by maintainers self-tagging — much higher signal-per-fetch
 * than `site:github.com "X" "Y"` Google scraping. The Search API also
 * returns actual repo metadata (description, stars, topics) instead of
 * misleading issue/PR snippets that judged the parent repo on text it didn't
 * own. And discovery is free (no webSearch spend per query).
 */
const SOURCE = "find:github-topics";

export interface GitHubTopicsFinderOpts extends RunOpts {
  /** GitHub topic slugs, e.g. ["llm-agents", "ai-agent", "langchain"]. */
  topics: string[];
  /** Canonical vendor names handed to the LLM extract for stack detection. */
  vendors: string[];
  /** YOUR EDGE line handed to the email prompt. */
  yourEdge: string;
  /** Min stars filter. Default 5 (drops abandoned/empty repos). */
  minStars?: number;
  /** Repos pushed within this window. Default 90 days. */
  maxAgeDays?: number;
  /** Max in-flight candidate workers. Default 3. */
  concurrency?: number;
  /** Min vendors detected in README. Default 2. */
  minVendors?: number;
  /** Last-resort deepResearchPerson fallback. Default true. */
  useDeepResearch?: boolean;
}

export async function runGitHubTopicsFinder(
  opts: GitHubTopicsFinderOpts,
): Promise<FinderResult> {
  const limit = opts.limit ?? 25;
  const minStars = Math.max(0, opts.minStars ?? 5);
  const maxAgeDays = Math.max(1, opts.maxAgeDays ?? 90);
  const minVendors = Math.max(1, opts.minVendors ?? 2);
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const useDeepResearch = opts.useDeepResearch !== false;
  const icp = resolveIcp(opts.icpOverride);

  const result: FinderResult = {
    source: SOURCE,
    candidates: 0,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    enqueued: 0,
    costUsd: 0,
  };

  if (!opts.topics || opts.topics.length === 0) {
    result.halted = "unconfigured: set `topics` in /queue → github-topics → edit config";
    return result;
  }
  if (!opts.vendors || opts.vendors.length === 0) {
    result.halted = "unconfigured: set `vendors` in /queue → github-topics → edit config";
    return result;
  }
  if (!opts.yourEdge || opts.yourEdge.trim().length === 0) {
    result.halted = "unconfigured: set `yourEdge` in /queue → github-topics → edit config";
    return result;
  }

  // Discovery: one Search API call per topic. Free, but we cap at limit*2 hits
  // BETWEEN topics so an unconfigured `topics: [...]` of length 20 doesn't
  // dispatch 20 search calls when the first three already over-fill the buffer.
  // The cap is per-iteration, not per-hit — a single noisy topic returning all
  // perPage=50 results still feeds them all into the pool. That's intentional:
  // searchTopicRepos already pre-filters with `stars:>=N pushed:>=Y`, so even
  // 50 hits from one topic is healthy signal. `searchTopicRepos` swallows its
  // own errors (returns []), so no try/catch is needed here.
  const pushedSinceIso = isoDateNDaysAgo(maxAgeDays);
  const seen = new Set<string>();
  const hits: RepoCandidate[] = [];
  for (const topic of opts.topics) {
    if (hits.length >= limit * 2) break;
    const repos = await searchTopicRepos({
      topic,
      minStars,
      pushedSinceIso,
      perPage: 50,
    });
    for (const repo of repos) {
      const url = normalizeRepoUrl(repo.url);
      if (!url || seen.has(url)) continue;
      if (looksLikeNoiseRepo(url)) continue;
      seen.add(url);
      hits.push({
        url,
        title: repo.fullName,
        description: repo.description ?? "",
        vendors: [],
        topics: repo.topics,
      });
    }
  }
  result.candidates = hits.length;

  const ctx: RepoPipelineCtx = {
    icp,
    vocab: opts.vendors,
    yourEdge: opts.yourEdge,
    minVendors,
    useDeepResearch,
    result,
    halted: { value: false },
    limit,
    maxCostUsd: opts.maxCostUsd,
    sourceTag: SOURCE,
    notesPrefix: "github-topic",
    dryRun: opts.dryRun,
  };

  await parallelMap(hits, concurrency, (hit) => processRepoCandidate(hit, ctx));
  return result;
}
