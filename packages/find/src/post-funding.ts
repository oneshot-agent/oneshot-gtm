import { getLedger, webRead } from "@oneshot-gtm/core";
import { findEmail, verifyEmail } from "@oneshot-gtm/core";
import { complete, loadPrompt } from "@oneshot-gtm/intel";
import type { PostFundingTarget } from "@oneshot-gtm/plays";
import { readFileSync } from "node:fs";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { isDuplicate } from "./_dedupe.ts";
import type { FinderResult, PostFundingExtract, RunOpts } from "./_types.ts";

const PLAY_NAME = "post-funding";
const SOURCE = "find:post-funding";

const ROUND_MAP: Record<string, string> = {
  "Pre-Seed": "Pre-Seed",
  Seed: "Seed",
  "Series A": "Series A",
  "Series B": "Series B",
  "Series C": "Series C",
  "Series D+": "Series D+",
};

export interface PostFundingFinderOpts extends RunOpts {
  /** File with one URL per line (TC / Crunchbase / company-blog). */
  sourceUrlsFile?: string;
  /** Or: pass URLs directly. */
  sourceUrls?: string[];
}

export async function runPostFundingFinder(opts: PostFundingFinderOpts): Promise<FinderResult> {
  const urls = collectUrls(opts);
  const limit = opts.limit ?? 25;
  const icp = resolveIcp(opts.icpOverride);
  const ledger = getLedger();
  const system = loadPrompt("post-funding-extract");

  const result: FinderResult = {
    source: SOURCE,
    candidates: urls.length,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    enqueued: 0,
    costUsd: 0,
  };

  for (const url of urls.slice(0, limit)) {
    if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      break;
    }
    // Dedupe by URL before spending anything (cheap).
    if (ledger.isQueueDuplicate(PLAY_NAME, url)) {
      result.droppedDuplicate++;
      continue;
    }

    if (opts.dryRun) {
      result.enqueued++;
      continue;
    }

    // Read the announcement.
    let extract: PostFundingExtract;
    try {
      const read = await webRead({ url }, { playName: PLAY_NAME });
      result.costUsd += extractCost(read.result) ?? 0.02;
      const llm = await complete({
        messages: [
          { role: "system", content: system },
          { role: "user", content: (read.result.markdown ?? "").slice(0, 12000) },
        ],
        temperature: 0.1,
        maxTokens: 600,
      });
      extract = parseExtract(llm.content);
    } catch {
      result.droppedEnrichment++;
      continue;
    }

    if (!extract.company || !extract.companyDomain || !extract.founderName) {
      result.droppedEnrichment++;
      continue;
    }

    // ICP filter on the LLM-extracted summary.
    const filter = await icpFilter({
      icp,
      candidate: {
        title: `${extract.company} ${extract.round ?? "raised"} (${extract.industry ?? "industry n/a"})`,
        url,
        summary: extract.summary,
      },
    });
    if (!filter.match) {
      result.droppedIcp++;
      continue;
    }

    // Enrich email.
    const found = await findEmail(
      { fullName: extract.founderName, companyDomain: extract.companyDomain },
      { playName: PLAY_NAME },
    );
    result.costUsd += extractCost(found.result) ?? 0.05;
    if (!found.result.found || !found.result.email) {
      result.droppedEnrichment++;
      continue;
    }
    const email = found.result.email;

    // Cross-table dedupe.
    if (isDuplicate({ playName: PLAY_NAME, dedupeKey: url, prospectEmail: email })) {
      result.droppedDuplicate++;
      continue;
    }

    const verified = await verifyEmail({ email }, { playName: PLAY_NAME });
    result.costUsd += extractCost(verified.result) ?? 0.01;
    if (!verified.result.deliverable) {
      result.droppedEnrichment++;
      continue;
    }

    const target: PostFundingTarget = {
      name: extract.founderName,
      email,
      company: extract.company,
      round: ROUND_MAP[extract.round ?? ""] ?? extract.round ?? "Seed",
      amountUsd: extract.amountUsd ?? 0,
      sourceUrl: url,
      ...(extract.leadInvestor ? { leadInvestor: extract.leadInvestor } : {}),
    };
    const id = ledger.enqueueTarget({
      playName: PLAY_NAME,
      payload: target,
      dedupeKey: url,
      source: SOURCE,
      notes: `${extract.round ?? "?"} ${extract.amountUsd ? `$${extract.amountUsd.toLocaleString()}` : ""} — ${filter.reason}`,
    });
    if (id != null) result.enqueued++;
    else result.droppedDuplicate++;
  }

  return result;
}

function collectUrls(opts: PostFundingFinderOpts): string[] {
  const urls: string[] = [];
  if (opts.sourceUrls) urls.push(...opts.sourceUrls);
  if (opts.sourceUrlsFile) {
    const raw = readFileSync(opts.sourceUrlsFile, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      try {
        const _validate = new URL(trimmed);
        urls.push(_validate.toString());
      } catch {
        // skip non-URL lines
      }
    }
  }
  return [...new Set(urls)];
}

function parseExtract(raw: string): PostFundingExtract {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  try {
    const parsed = JSON.parse((candidate ?? "").trim()) as PostFundingExtract;
    return parsed;
  } catch {
    const start = (candidate ?? "").indexOf("{");
    const end = (candidate ?? "").lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse((candidate ?? "").slice(start, end + 1)) as PostFundingExtract;
      } catch {
        // fall through
      }
    }
  }
  return {
    company: null,
    companyDomain: null,
    round: null,
    amountUsd: null,
    leadInvestor: null,
    founderName: null,
    founderRole: null,
    industry: null,
    summary: null,
  };
}

function extractCost(r: unknown): number | undefined {
  if (!r || typeof r !== "object") return undefined;
  const v = (r as Record<string, unknown>)["cost"];
  return typeof v === "number" ? v : undefined;
}
