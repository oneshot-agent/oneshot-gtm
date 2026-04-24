import { findEmail, getLedger, logEvent, verifyEmail, webRead } from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import type { AcceleratorBatchTarget } from "@oneshot-gtm/plays";
import { icpFilter, resolveIcp } from "./_filter.ts";
import { isDuplicate, urlDomain } from "./_dedupe.ts";
import type { AcceleratorListExtract, FinderResult, RunOpts } from "./_types.ts";

const PLAY_NAME = "accelerator-batch";

export interface AcceleratorBatchFinderOpts extends RunOpts {
  /** Cohort tag, e.g. "yc-w26", "yc-s26", "od-current", "spc-current", "antler-current", "techstars-current". */
  cohort: string;
  /** Override the cohort index URL (lets founders point at any program page). */
  indexUrl?: string;
}

interface BatchListExtract {
  companies: AcceleratorListExtract[];
}

const COHORT_INDEX_URL: Record<string, string> = {
  // YC
  "yc-w26": "https://www.ycombinator.com/launches/?batch=W26",
  "yc-s26": "https://www.ycombinator.com/launches/?batch=S26",
  "yc-w25": "https://www.ycombinator.com/launches/?batch=W25",
  "yc-s25": "https://www.ycombinator.com/launches/?batch=S25",
  // On Deck — Founder Fellowship
  "od-current": "https://www.beondeck.com/founders",
  // South Park Commons
  "spc-current": "https://www.southparkcommons.com/founders",
  // Antler
  "antler-current": "https://www.antler.co/portfolio",
  // Techstars
  "techstars-current": "https://www.techstars.com/portfolio",
};

export async function runAcceleratorBatchFinder(
  opts: AcceleratorBatchFinderOpts,
): Promise<FinderResult> {
  const limit = opts.limit ?? 25;
  const icp = resolveIcp(opts.icpOverride);
  const ledger = getLedger();
  const source = `find:accelerator-batch:${opts.cohort}`;

  const result: FinderResult = {
    source,
    candidates: 0,
    droppedIcp: 0,
    droppedDuplicate: 0,
    droppedEnrichment: 0,
    enqueued: 0,
    costUsd: 0,
  };

  const indexUrl = opts.indexUrl ?? COHORT_INDEX_URL[opts.cohort];
  if (!indexUrl) {
    throw new Error(
      `cohort '${opts.cohort}' has no built-in index URL. Pass --index-url <url> to point at the program's portfolio/launch page, or use one of: ${Object.keys(COHORT_INDEX_URL).join(", ")}.`,
    );
  }

  // Step 1: pull the launch index, LLM-extract company list.
  let companies: AcceleratorListExtract[] = [];
  if (!opts.dryRun) {
    const indexRead = await webRead({ url: indexUrl }, { playName: PLAY_NAME });
    result.costUsd += extractCost(indexRead.result) ?? 0.02;
    const system = loadPrompt("accelerator-batch-extract");
    const llm = await complete({
      messages: [
        { role: "system", content: system },
        { role: "user", content: (indexRead.result.markdown ?? "").slice(0, 16000) },
      ],
      temperature: 0.1,
      maxTokens: 1500,
    });
    companies = parseAcceleratorList(llm.content);
  }
  result.candidates = companies.length;

  for (const c of companies.slice(0, limit)) {
    if (opts.maxCostUsd != null && result.costUsd >= opts.maxCostUsd) {
      result.halted = `max-cost cap (${opts.maxCostUsd})`;
      break;
    }

    const dedupeKey = `${c.name.toLowerCase().replace(/\s+/g, "-")}|${opts.cohort}`;
    if (ledger.isQueueDuplicate(PLAY_NAME, dedupeKey)) {
      result.droppedDuplicate++;
      continue;
    }

    // ICP filter on the one-liner.
    const filter = await icpFilter({
      icp,
      candidate: {
        title: c.name,
        url: c.launchUrl,
        summary: c.oneLiner,
      },
    });
    if (!filter.match) {
      result.droppedIcp++;
      if (!opts.dryRun) {
        ledger.enqueueTarget({
          playName: PLAY_NAME,
          payload: { company: c.name, launchUrl: c.launchUrl, oneLiner: c.oneLiner },
          dedupeKey,
          source,
          initialStatus: "rejected",
          notes: `auto: ICP — ${filter.reason}`,
        });
      }
      continue;
    }

    if (opts.dryRun) {
      result.enqueued++;
      continue;
    }

    // Step 2: read the per-company launch page for founder + website.
    let founderName: string | null = null;
    let companyWebsite: string | null = null;
    try {
      const read = await webRead({ url: c.launchUrl }, { playName: PLAY_NAME });
      result.costUsd += extractCost(read.result) ?? 0.02;
      ({ founderName, companyWebsite } = parseLaunchPage(read.result.markdown ?? ""));
    } catch (err) {
      logEvent(
        "error.swallowed",
        {
          kind: "accelerator-batch.launchPage.webRead",
          message_120: ((err as Error).message ?? "").slice(0, 120),
        },
        "warn",
      );
      result.droppedEnrichment++;
      continue;
    }
    if (!founderName) {
      result.droppedEnrichment++;
      continue;
    }

    const domain = urlDomain(companyWebsite ?? c.launchUrl);
    if (!domain) {
      result.droppedEnrichment++;
      continue;
    }

    const found = await findEmail(
      { fullName: founderName, companyDomain: domain },
      { playName: PLAY_NAME },
    );
    result.costUsd += extractCost(found.result) ?? 0.05;
    if (!found.result.found || !found.result.email) {
      result.droppedEnrichment++;
      continue;
    }
    const email = found.result.email;

    if (isDuplicate({ playName: PLAY_NAME, dedupeKey, prospectEmail: email })) {
      result.droppedDuplicate++;
      continue;
    }

    const verified = await verifyEmail({ email }, { playName: PLAY_NAME });
    result.costUsd += extractCost(verified.result) ?? 0.01;
    if (!verified.result.deliverable) {
      result.droppedEnrichment++;
      continue;
    }

    const target: AcceleratorBatchTarget = {
      name: founderName,
      email,
      company: c.name,
      cohort: opts.cohort,
      ...(c.launchUrl ? { launchUrl: c.launchUrl } : {}),
      ...(c.oneLiner ? { productOneLiner: c.oneLiner } : {}),
    };

    const id = ledger.enqueueTarget({
      playName: PLAY_NAME,
      payload: target,
      dedupeKey,
      source,
      notes: filter.reason,
    });
    if (id != null) result.enqueued++;
    else result.droppedDuplicate++;
  }

  return result;
}

export function parseAcceleratorList(raw: string): AcceleratorListExtract[] {
  const parsed = tryParseJsonObject<BatchListExtract>(raw, { companies: [] });
  return Array.isArray(parsed.companies) ? parsed.companies : [];
}

/**
 * Lightweight HTML/markdown scraper for a YC launch page.
 * Looks for "Founders" or "Founder:" or first proper-noun pair under "Team".
 * Looks for the company's website link (often labeled as such).
 */
export function parseLaunchPage(markdown: string): {
  founderName: string | null;
  companyWebsite: string | null;
} {
  const lines = markdown.split(/\r?\n/);
  let founderName: string | null = null;
  let companyWebsite: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!founderName) {
      const m = line.match(
        /(?:founder|founders|ceo|co-?founder)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i,
      );
      if (m && m[1]) founderName = m[1].trim();
    }
    if (!companyWebsite) {
      const m = line.match(/\[(?:website|home|product|visit)\]\((https?:\/\/[^\s)]+)\)/i);
      if (m && m[1]) companyWebsite = m[1].trim();
    }
    if (founderName && companyWebsite) break;
  }
  // Fallback: any bare https URL not pointing to a known program domain.
  if (!companyWebsite) {
    const m = markdown.match(
      /https?:\/\/(?!(?:www\.)?(?:ycombinator|beondeck|southparkcommons|antler|techstars)\.com)[^\s)]+/,
    );
    if (m) companyWebsite = m[0].trim();
  }
  return { founderName, companyWebsite };
}

function extractCost(r: unknown): number | undefined {
  if (!r || typeof r !== "object") return undefined;
  const v = (r as Record<string, unknown>)["cost"];
  return typeof v === "number" ? v : undefined;
}
