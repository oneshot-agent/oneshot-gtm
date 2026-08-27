import {
  deepResearchPerson,
  getLedger,
  loadConfig,
  logEvent,
  parallelMap,
} from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import type { XAmplifyDmTarget, XAmplifyTarget, XRepostIntroTarget } from "@oneshot-gtm/plays";
import { loadXHarvest, saveXHarvest } from "./_x-cache.ts";
import { CostMeter, estimateHarvestCost, type XEngineName } from "./_x-cost.ts";
import {
  DEFAULT_KNOBS,
  DEFAULT_MAX_SPEND,
  type HarvestEngine,
  type HarvestKnobs,
} from "./_x-engine.ts";
import { XApiEngine } from "./_x-api.ts";
import { TwitterApiIoEngine } from "./_x-twitterapiio.ts";
import { harvestReposters } from "./_x-harvest.ts";
import { splitSlots } from "./_x-lanes.ts";
import { dropReason, lanesFor, scoreCandidate } from "./_x-score.ts";
import type { XCandidate, XScoredCandidate, XSeed } from "./_x-types.ts";
import { resolveIcp, qualifyPerson } from "./_filter.ts";
import { persistRoleRejection, qualifyPreSpend } from "./_qualify.ts";
import type { FinderResult, RunOpts } from "./_types.ts";

const PLAY_NAME = "x-reposters";
/** The three plays this finder routes to — one shared dedupe-key namespace. */
const ROUTED_PLAYS = ["x-repost-intro", "x-amplify", "x-amplify-dm"] as const;

export interface XRepostersFinderOpts extends RunOpts {
  seeds: XSeed[];
  engine?: XEngineName;
  /**
   * Ceiling on X read spend (the CostMeter) — distinct from RunOpts.maxCostUsd,
   * which caps SDK/LLM spend. Defaults per engine (xapi $5, twitterapiio $1).
   */
  maxSpendPerRun?: number;
  /** Share of `limit` reserved for the founder lane. Default 0.5. */
  laneSplit?: number;
  /** ISO launch date, stamped onto amplifier payloads. */
  launchDate?: string;
  /** Our own handles — never contacted. */
  ownHandles?: string[];
  knobs?: Partial<HarvestKnobs>;
  /** Re-score the cached harvest instead of paying for a live one. */
  replay?: boolean;
  replayDay?: string;
  /** Per-candidate pipelines in flight at once. Default 3. */
  concurrency?: number;
}

interface ExtractResult {
  name?: string | null;
  company?: string | null;
  role?: string | null;
  email?: string | null;
  angle?: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function buildEngine(
  engineName: XEngineName,
  meter: CostMeter,
  knobs: HarvestKnobs,
): HarvestEngine {
  return engineName === "twitterapiio"
    ? new TwitterApiIoEngine({ meter, knobs })
    : new XApiEngine({ meter, knobs });
}

/**
 * The hit the drafts talk about: prefer a quote hit (strongest signal, and it
 * carries their own words), else the first. Mode and tweet MUST come from the
 * same hit — someone who plain-retweeted tweet A and quoted tweet B must not
 * be pitched as having "quoted" tweet A.
 */
function primaryHit(c: XCandidate) {
  return c.hits.find((h) => h.mode === "quote") ?? c.hits[0]!;
}

/** Shared grounding fields for every payload this finder enqueues. */
function grounding(s: XScoredCandidate) {
  const c = s.candidate;
  const hit = primaryHit(c);
  const quoted = hit.mode === "quote";
  return {
    handle: c.user.username,
    twitterUrl: `https://x.com/${c.user.username}`,
    xUserId: c.user.id,
    seedHandle: hit.seed,
    tweetUrl: hit.url,
    tweetText: hit.text,
    mode: (quoted ? "quote" : "retweet") as "retweet" | "quote",
    ...(hit.quoteText?.trim() ? { quote: hit.quoteText.trim() } : {}),
    followers: c.user.followers,
    score: s.score,
    why: s.why,
    dmOpen: c.user.dmOpen,
  };
}

/**
 * x-reposters finder: people who reposted/quoted a watched X account's recent
 * tweets → prospects, in two lanes. The founder lane (bio + real site say they
 * build things) routes to `x-repost-intro` — a normal email play behind the
 * person-ICP gate. The amplifier lane (dev/AI audience with reach) routes to
 * `x-amplify` when research finds an email, else `x-amplify-dm` — a manual
 * hand-send draft. Ported from the x-amplifiers pack: same engines, cost
 * meter, hard drops, lane scoring and slot split; the Obsidian side is
 * replaced by the queue.
 */
export async function runXRepostersFinder(opts: XRepostersFinderOpts): Promise<FinderResult> {
  const limit = opts.limit ?? 12;
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const engineName: XEngineName = opts.engine === "twitterapiio" ? "twitterapiio" : "xapi";
  const knobs: HarvestKnobs = { ...DEFAULT_KNOBS[engineName], ...opts.knobs };
  const maxSpend = opts.maxSpendPerRun ?? DEFAULT_MAX_SPEND[engineName];
  const laneSplit = opts.laneSplit ?? 0.5;
  const icp = resolveIcp(opts.icpOverride);
  const ledger = getLedger();
  const now = new Date();

  const result: FinderResult = {
    source: `find:${PLAY_NAME}`,
    candidates: 0,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    droppedLowSignal: 0,
    enqueued: 0,
    costUsd: 0,
  };

  logEvent("finder.start", {
    name: PLAY_NAME,
    engine: engineName,
    seeds: opts.seeds.length,
    limit,
    replay: opts.replay === true,
    est_harvest_usd: estimateHarvestCost(engineName, {
      seeds: opts.seeds.length,
      tweetsPerSeed: knobs.tweetsPerSeed,
      perTweet: knobs.maxPerTweet,
    }),
  });

  const meter = new CostMeter(engineName, maxSpend);
  const seedHandles = new Set(opts.seeds.map((s) => s.handle.toLowerCase()));
  const blocked = new Set((opts.ownHandles ?? []).map((h) => h.toLowerCase()));
  const edgeBySeed = new Map(
    opts.seeds.filter((s) => s.edge?.trim()).map((s) => [s.handle.toLowerCase(), s.edge!.trim()]),
  );

  // Step 1: harvest (paid), or replay a cached one (free — both providers
  // bill per resource returned, so filter tuning replays offline).
  let candidates: XCandidate[];
  let stoppedEarly: string | null = null;
  if (opts.replay) {
    const cached = loadXHarvest(opts.replayDay);
    if (!cached) {
      result.halted = "no cached harvest to replay — run live once first";
      logEvent("finder.done", { name: PLAY_NAME, candidates: 0, halted: result.halted });
      return result;
    }
    candidates = cached.candidates;
    result.candidates = candidates.length;
  } else {
    let engine: HarvestEngine;
    try {
      engine = buildEngine(engineName, meter, knobs);
    } catch (err) {
      result.halted = (err as Error).message;
      logEvent("finder.done", { name: PLAY_NAME, candidates: 0, halted: result.halted });
      return result;
    }
    const skip = ledger.recentXHarvestedTweetIds(
      new Date(now.getTime() - knobs.skipHarvestedWithinHours * 3600_000).toISOString(),
    );
    const harvest = await harvestReposters(
      engine,
      opts.seeds,
      knobs,
      (msg) => logEvent("finder.progress", { name: PLAY_NAME, msg }),
      skip,
    );
    candidates = harvest.candidates;
    stoppedEarly = harvest.stoppedEarly;
    result.candidates = candidates.length;

    // Cheap drops BEFORE the (twitterapi.io) enrichment pass, so we only pay
    // to fill in survivors.
    const ctx = { seeds: seedHandles, blocked };
    candidates = candidates.filter((c) => dropReason(c.user, ctx, now) === null);
    if (engine.enrich && candidates.length > 0) {
      try {
        await engine.enrich(candidates.map((c) => c.user));
      } catch (err) {
        stoppedEarly = stoppedEarly ?? (err as Error).message;
      }
    }

    // Record what was paid for even on dry runs — the harvest itself is the
    // paid step here (unlike GitHub), and not recording it would make the next
    // run buy the same tweets again. A run that PAID for nothing (every fresh
    // tweet already in the skip ledger) must not overwrite the day's replay
    // cache with an empty harvest — that file is the paid data replay re-scores.
    if (harvest.harvestedIds.length > 0) {
      saveXHarvest(
        {
          engine: engineName,
          seeds: opts.seeds.map((s) => s.handle),
          tweetsScanned: harvest.tweetsScanned,
          candidates,
        },
        now,
      );
      ledger.recordXHarvestedTweets(
        harvest.harvestedIds,
        now.toISOString(),
        new Date(now.getTime() - knobs.skipHarvestedWithinHours * 3600_000).toISOString(),
      );
    }
  }
  // X read spend and SDK/LLM spend are tracked apart: `maxCostUsd` caps only
  // the SDK side (the meter's own ceiling already capped the X side).
  let sdkCost = 0;
  if (stoppedEarly) result.halted = stoppedEarly;

  // Step 2: hard drops (re-run — `automated`/`protected` only arrive with
  // enrichment on the twitterapi.io engine; on replay the cache is pre-dropped
  // but re-checking is free and keeps one code path).
  const ctx = { seeds: seedHandles, blocked };
  const survivors = candidates.filter((c) => dropReason(c.user, ctx, now) === null);

  // Step 3: lanes + score + reserved slot split. Lanes rank within themselves
  // only — their weights differ, so scores are not comparable across lanes.
  const scored = survivors
    .map((c) => ({ c, lanes: lanesFor(c.user) }))
    .filter((x) => x.lanes.length > 0)
    .map((x) => scoreCandidate(x.c, x.lanes));
  // Everyone the finder's own thresholds shed: hard drops + lane-gate misses.
  result.droppedLowSignal = result.candidates - scored.length;
  const picks = splitSlots(scored, limit, laneSplit);

  if (picks.length === 0) {
    result.costUsd = meter.total;
    if (!result.halted) {
      result.halted =
        result.candidates === 0
          ? "no reposters harvested — check seeds, or every fresh tweet was already harvested"
          : "no candidates cleared the lane gates — widen seeds whose reposters build things";
    }
    logEvent("finder.done", {
      name: PLAY_NAME,
      candidates: result.candidates,
      enqueued: 0,
      halted: result.halted,
      x_spend_usd: meter.total,
    });
    return result;
  }

  // Step 4: per-pick pipeline (parallel, soft-capped on limit + SDK cost).
  const cfg = loadConfig();
  let halted = false;
  await parallelMap(picks, concurrency, async (pick) => {
    if (halted) return;
    if (result.enqueued >= limit) {
      halted = true;
      return;
    }
    if (opts.maxCostUsd != null && sdkCost >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      halted = true;
      return;
    }

    const c = pick.candidate;
    const handle = c.user.username.toLowerCase();
    const dedupeKey = `${PLAY_NAME}:${handle}`;
    // One shared key namespace across the three routed plays, so the same
    // human can't be enqueued twice under different lanes.
    if (ROUTED_PLAYS.some((p) => ledger.isQueueDuplicate(p, dedupeKey))) {
      result.droppedDuplicate++;
      return;
    }
    const seedHandle = primaryHit(c).seed;
    const source = `find:${PLAY_NAME}:@${seedHandle}`;

    // Founder lane: stage-A person gate on the bio, free, before any spend.
    if (pick.lane === "founder") {
      const stageA = await qualifyPreSpend({
        icp,
        person: {
          name: c.user.name,
          roleText: c.user.description,
          evidence: `reposted @${seedHandle} on X`,
        },
      });
      if (stageA.action === "reject") {
        result.droppedRole = (result.droppedRole ?? 0) + 1;
        persistRoleRejection({
          playName: "x-repost-intro",
          dedupeKey,
          payload: { name: c.user.name, handle: c.user.username },
          source,
          reason: stageA.reason,
          dryRun: opts.dryRun ?? false,
        });
        return;
      }
      if (stageA.action === "defer") {
        // Classifier outage — drop WITHOUT persisting so the dedupeKey
        // survives for the next tick.
        result.droppedEnrichment++;
        return;
      }
    }

    // Dry-run preview: count lane-cleared picks, skip all paid work.
    if (opts.dryRun) {
      result.enqueued++;
      return;
    }

    // Research the person from their X profile. X gives no company domain
    // (and x.com is a dud domain for the findEmail prescreen), so
    // deepResearchPerson is the contact path for BOTH lanes. A research
    // failure is fatal only for founders (that lane is email-only); an
    // amplifier falls through to the manual DM draft, which needs neither an
    // email nor a dossier — the repost itself is the hook.
    const twitterUrl = `https://x.com/${c.user.username}`;
    let research: Awaited<ReturnType<typeof deepResearchPerson>> | null = null;
    try {
      research = await deepResearchPerson(
        { socialMediaUrl: twitterUrl, name: c.user.name },
        { playName: PLAY_NAME, decisionContext: { source, lane: pick.lane } },
      );
    } catch (err) {
      logEvent("error.swallowed", {
        kind: `${PLAY_NAME}.research`,
        message: ((err as Error).message ?? "").slice(0, 120),
      });
      if (pick.lane === "founder") {
        result.droppedEnrichment++;
        return;
      }
    }
    sdkCost += research?.result?.cost ?? 0;
    const enrichment = (research?.result?.result?.enrichment ?? {}) as Record<string, unknown>;
    const articles = research?.result?.result?.articles;
    const hasSignal =
      Object.keys(enrichment).length > 0 || (Array.isArray(articles) && articles.length > 0);
    const dossier = hasSignal
      ? JSON.stringify(research?.result?.result ?? research?.result, null, 2).slice(0, 6000)
      : "";

    // SDK-found emails, cheapest-to-extract order.
    const altEmails = Array.isArray(enrichment["altemails"])
      ? (enrichment["altemails"] as unknown[]).map(str).filter((x): x is string => x != null)
      : [];
    const sdkEmail =
      str(enrichment["best_work_email"]) ?? str(enrichment["best_personal_email"]) ?? altEmails[0];

    const base = { ...grounding(pick), engine: engineName };

    if (pick.lane === "amplifier") {
      // No ICP/person gate — we never pitch amplifiers; the lane gate is the
      // qualification. Email found → automated ask; none → manual X draft.
      const target: XAmplifyTarget | XAmplifyDmTarget = sdkEmail
        ? {
            name: c.user.name,
            email: sdkEmail,
            ...(dossier ? { dossier } : {}),
            ...base,
            ...(opts.launchDate ? { launchDate: opts.launchDate } : {}),
          }
        : {
            name: c.user.name,
            ...base,
            ...(opts.launchDate ? { launchDate: opts.launchDate } : {}),
          };
      const id = ledger.enqueueTarget({
        playName: sdkEmail ? "x-amplify" : "x-amplify-dm",
        payload: target,
        dedupeKey,
        source,
        notes: pick.why,
      });
      if (id != null) result.enqueued++;
      else result.droppedDuplicate++;
      return;
    }

    // Founder lane: extract identity + angle from the dossier, then stage-B
    // person gate on the extracted role. Email is required — this lane is the
    // normal email cadence path.
    if (!hasSignal) {
      result.droppedEnrichment++;
      return;
    }
    // One LLM failure must not reject the whole parallelMap — that would
    // abort the run AFTER the paid harvest and the other picks' paid research,
    // and skip the closing cost accounting below.
    let extractRes: Awaited<ReturnType<typeof complete>>;
    try {
      extractRes = await complete({
        messages: [
          { role: "system", content: loadPrompt("profile-extract") },
          {
            role: "user",
            content: [
              `ICP: ${cfg.icpOneLiner ?? "(not set)"}`,
              `PRODUCT: ${cfg.productOneLiner ?? "(not set)"}`,
              `DOSSIER:\n${dossier}`,
            ].join("\n"),
          },
        ],
        temperature: 0.3,
        maxTokens: 500,
      });
    } catch (err) {
      logEvent("error.swallowed", {
        kind: `${PLAY_NAME}.extract`,
        message: ((err as Error).message ?? "").slice(0, 120),
      });
      result.droppedEnrichment++;
      return;
    }
    const extracted = tryParseJsonObject<ExtractResult>(extractRes.content, {});
    const email = str(extracted.email) ?? sdkEmail;
    const fullName = str(extracted.name) ?? c.user.name;
    const role = str(extracted.role);

    // Email is a hard requirement for this lane — check it BEFORE paying for
    // the stage-B qualifier, which can't change the outcome for a no-email pick.
    if (!email) {
      result.droppedEnrichment++;
      return;
    }

    const stageB = await qualifyPerson({
      icp,
      person: {
        name: fullName,
        company: str(extracted.company),
        roleText: role ?? c.user.description,
        evidence: `reposted @${seedHandle} on X`,
      },
    });
    if (stageB.verdict === "reject") {
      result.droppedRole = (result.droppedRole ?? 0) + 1;
      persistRoleRejection({
        playName: "x-repost-intro",
        dedupeKey,
        payload: { name: fullName, handle: c.user.username },
        source,
        reason: stageB.reason,
        dryRun: false,
      });
      return;
    }
    if (stageB.verdict === "transient") {
      result.droppedEnrichment++;
      return;
    }

    const target: XRepostIntroTarget = {
      name: fullName,
      email,
      company: str(extracted.company),
      ...(role ? { title: role } : {}),
      dossier,
      angle: str(extracted.angle),
      ...base,
      ...(edgeBySeed.has(seedHandle.toLowerCase())
        ? { seedEdge: edgeBySeed.get(seedHandle.toLowerCase())! }
        : {}),
    };
    const id = ledger.enqueueTarget({
      playName: "x-repost-intro",
      payload: target,
      dedupeKey,
      source,
      notes: pick.why,
    });
    if (id != null) result.enqueued++;
    else result.droppedDuplicate++;
  });

  result.costUsd = meter.total + sdkCost;
  logEvent("finder.done", {
    name: PLAY_NAME,
    candidates: result.candidates,
    enqueued: result.enqueued,
    dropped_dup: result.droppedDuplicate,
    dropped_enrich: result.droppedEnrichment,
    dropped_role: result.droppedRole ?? 0,
    dropped_low_signal: result.droppedLowSignal ?? 0,
    cost_usd: result.costUsd,
    x_spend_usd: meter.total,
    x_users: meter.users,
    x_posts: meter.posts,
    halted: result.halted ?? null,
  });
  return result;
}
