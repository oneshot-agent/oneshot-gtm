import { findEmail, getLedger, logEvent, verifyEmail, webRead, webSearch } from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import type { CompetitorSwitchTarget } from "@oneshot-gtm/plays";
import { isDuplicate } from "./_dedupe.ts";
import { icpFilter, resolveIcp } from "./_filter.ts";
import type { AgentBuilderExtract, FinderResult, RunOpts } from "./_types.ts";
import {
  allVendorNames,
  buildDefaultCombos,
  humanizePrimitives,
  normalizeRepoUrl,
  primitivesCovered,
  type ComboQuery,
} from "./_agent-builder-combos.ts";

/**
 * Enqueue into the existing competitor-switch motion play — agent builders
 * wiring multiple vendor SDKs map cleanly onto its migration-honesty pitch.
 */
const PLAY_NAME = "competitor-switch";
const SOURCE = "find:agent-builders";

const DEFAULT_EDGE =
  "OneShot unifies the tools you're stitching together (email + sms + voice + browser + webSearch + findEmail + verify + enrich) behind one SDK and one wallet — less auth surface, one receipt per call.";

export interface AgentBuildersFinderOpts extends RunOpts {
  /** Override the curated combo list. Rarely needed. */
  combos?: ComboQuery[];
  /**
   * Your one-fact edge passed to the competitor-switch email prompt. If
   * unset, falls back to a generic consolidation pitch.
   */
  yourEdge?: string;
  /** Require at least this many OneShot primitives covered by the detected stack. Default 2. */
  minPrimitives?: number;
}

interface SearchHit {
  url: string;
  title: string;
  description: string;
  /** Vendors the combo query targeted — fed to the extract prompt as a recall hint. */
  vendors: string[];
}

export async function runAgentBuildersFinder(opts: AgentBuildersFinderOpts): Promise<FinderResult> {
  const limit = opts.limit ?? 25;
  const minPrimitives = opts.minPrimitives ?? 2;
  const icp = resolveIcp(opts.icpOverride);
  const ledger = getLedger();
  const system = loadPrompt("agent-builder-extract");
  const vocab = allVendorNames();
  const combos = opts.combos && opts.combos.length > 0 ? opts.combos : buildDefaultCombos();
  const yourEdge = opts.yourEdge ?? DEFAULT_EDGE;

  const result: FinderResult = {
    source: SOURCE,
    candidates: 0,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    enqueued: 0,
    costUsd: 0,
  };

  // webSearch per combo, collect unique repo URLs.
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const combo of combos) {
    if (hits.length >= limit * 2) break;
    if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      break;
    }
    try {
      const search = await webSearch(
        { query: combo.query, maxResults: Math.min(15, limit) },
        { playName: PLAY_NAME },
      );
      result.costUsd += extractCost(search.result) ?? 0.01;
      for (const raw of search.result.results ?? []) {
        const repoUrl = normalizeRepoUrl(raw.url);
        if (!repoUrl || seen.has(repoUrl)) continue;
        seen.add(repoUrl);
        hits.push({
          url: repoUrl,
          title: raw.title,
          description: raw.description,
          vendors: combo.vendors,
        });
      }
    } catch (err) {
      logEvent(
        "error.swallowed",
        {
          kind: "agent-builders.combo.search",
          message_120: ((err as Error).message ?? "").slice(0, 120),
        },
        "warn",
      );
    }
  }
  result.candidates = hits.length;

  for (const hit of hits.slice(0, limit)) {
    if (result.enqueued >= limit) break;
    if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      break;
    }
    // Dedupe BEFORE any LLM / OneShot spend.
    if (ledger.isQueueDuplicate(PLAY_NAME, hit.url)) {
      result.droppedDuplicate++;
      continue;
    }

    if (opts.dryRun) {
      result.enqueued++;
      continue;
    }

    // ICP filter on the search-snippet before spending on a webRead.
    const filter = await icpFilter({
      icp,
      candidate: { title: hit.title, url: hit.url, summary: hit.description },
    });
    if (!filter.match) {
      result.droppedIcp++;
      ledger.enqueueTarget({
        playName: PLAY_NAME,
        payload: { repoUrl: hit.url, title: hit.title, description: hit.description },
        dedupeKey: hit.url,
        source: SOURCE,
        initialStatus: "rejected",
        notes: `auto: ICP — ${filter.reason}`,
      });
      continue;
    }

    let extract: AgentBuilderExtract;
    try {
      const read = await webRead({ url: hit.url }, { playName: PLAY_NAME });
      result.costUsd += extractCost(read.result) ?? 0.02;
      const llm = await complete({
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: JSON.stringify({
              url: hit.url,
              // Hint the LLM with the vendors the search query already matched —
              // improves recall on short READMEs where a skim might miss them.
              queryMatchedVendors: hit.vendors,
              canonicalVendors: vocab,
              markdown: (read.result.markdown ?? "").slice(0, 12000),
            }),
          },
        ],
        temperature: 0.1,
        maxTokens: 500,
      });
      extract = parseAgentBuilderExtract(llm.content);
    } catch (err) {
      logEvent(
        "error.swallowed",
        {
          kind: "agent-builders.repo.read_or_extract",
          message_120: ((err as Error).message ?? "").slice(0, 120),
        },
        "warn",
      );
      result.droppedEnrichment++;
      continue;
    }

    // Require enough distinct vendors AND enough OneShot-primitive coverage
    // to be worth pitching consolidation. The vendor-count check blocks a
    // single vendor (e.g. "twilio" alone) from hitting multiple primitives
    // via substring match ("twilio voice" contains "twilio").
    const primitives = primitivesCovered(extract.stackDetected);
    if (extract.stackDetected.length < minPrimitives || primitives.length < minPrimitives) {
      result.droppedEnrichment++;
      continue;
    }

    // We need a domain to enrich contact against. Prefer company, fallback to personal.
    const domain = extract.companyDomain ?? extract.personalDomain;
    if (!domain) {
      result.droppedEnrichment++;
      continue;
    }

    const findInput =
      extract.authorFullName && extract.authorFullName.length > 0
        ? { fullName: extract.authorFullName, companyDomain: domain }
        : { companyDomain: domain };
    const found = await findEmail(findInput, { playName: PLAY_NAME });
    result.costUsd += extractCost(found.result) ?? 0.05;
    if (!found.result.found || !found.result.email) {
      result.droppedEnrichment++;
      continue;
    }
    const email = found.result.email;

    if (isDuplicate({ playName: PLAY_NAME, dedupeKey: hit.url, prospectEmail: email })) {
      result.droppedDuplicate++;
      continue;
    }

    const verified = await verifyEmail({ email }, { playName: PLAY_NAME });
    result.costUsd += extractCost(verified.result) ?? 0.01;
    if (!verified.result.deliverable) {
      result.droppedEnrichment++;
      continue;
    }

    const stackLine = extract.stackDetected.join(", ");
    const humanPrimitives = humanizePrimitives(primitives);
    const evidenceText = `Repo wires ${stackLine}. OneShot collapses ${humanPrimitives.join(" + ")} into one SDK.`;
    // The minPrimitives gate guarantees stackDetected[0] exists.
    const primaryCompetitor = extract.stackDetected[0] as string;

    const target: CompetitorSwitchTarget = {
      name: extract.authorFullName ?? found.result.full_name ?? extract.githubHandle ?? "there",
      email,
      company: extract.companyName ?? extract.githubHandle ?? domain,
      competitor: primaryCompetitor,
      evidenceUrl: hit.url,
      evidenceText,
      yourEdge,
    };
    const notes = truncate(
      `agent-builder: ${stackLine} (${primitives.length} primitives) — ${filter.reason}`,
      220,
    );
    const id = ledger.enqueueTarget({
      playName: PLAY_NAME,
      payload: target,
      dedupeKey: hit.url,
      source: SOURCE,
      notes,
    });
    if (id != null) result.enqueued++;
    else result.droppedDuplicate++;
  }

  return result;
}

export function parseAgentBuilderExtract(raw: string): AgentBuilderExtract {
  const parsed = tryParseJsonObject<Partial<AgentBuilderExtract>>(raw, {});
  return {
    repoUrl: typeof parsed.repoUrl === "string" ? parsed.repoUrl : null,
    githubHandle: typeof parsed.githubHandle === "string" ? parsed.githubHandle : null,
    authorFullName: typeof parsed.authorFullName === "string" ? parsed.authorFullName : null,
    authorRole: typeof parsed.authorRole === "string" ? parsed.authorRole : null,
    companyName: typeof parsed.companyName === "string" ? parsed.companyName : null,
    companyDomain: typeof parsed.companyDomain === "string" ? parsed.companyDomain : null,
    personalDomain: typeof parsed.personalDomain === "string" ? parsed.personalDomain : null,
    stackDetected: Array.isArray(parsed.stackDetected)
      ? parsed.stackDetected.filter((v): v is string => typeof v === "string")
      : [],
    summary: typeof parsed.summary === "string" ? parsed.summary : null,
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function extractCost(r: unknown): number | undefined {
  if (!r || typeof r !== "object") return undefined;
  const v = (r as Record<string, unknown>)["cost"];
  return typeof v === "number" ? v : undefined;
}
