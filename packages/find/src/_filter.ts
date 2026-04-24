import { loadConfig, logEvent } from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";

export interface IcpFilterResult {
  match: boolean;
  reason: string;
}

/**
 * Resolve the ICP one-liner: explicit override beats config.
 * Returns null if neither is set — caller should fall back to "match all".
 */
export function resolveIcp(override?: string): string | null {
  if (override && override.trim().length > 0) return override.trim();
  const cfg = loadConfig();
  return cfg.icpOneLiner;
}

/**
 * Run the ICP classifier against a single candidate. If no ICP is set, every
 * candidate matches (founder hasn't filtered yet — they'll review in queue).
 */
export async function icpFilter(input: {
  icp: string | null;
  candidate: {
    title: string;
    url?: string | null;
    summary?: string | null;
    author?: string | null;
  };
}): Promise<IcpFilterResult> {
  if (!input.icp) {
    return { match: true, reason: "no ICP set; pass-through" };
  }
  const system = loadPrompt("icp-filter");
  const user = JSON.stringify({
    icp: input.icp,
    candidate: input.candidate,
  });
  const res = await complete({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.1,
    maxTokens: 200,
  });
  const decision = parseIcpJson(res.content);
  // Title is a category-ish label sourced from public listings (post titles,
  // job titles, episode titles); reason is the LLM's own classifier output.
  // Neither is user-typed prospect data — safe to log.
  logEvent("icp.decision", {
    match: decision.match,
    reason_120: decision.reason.slice(0, 120),
    candidate_title: input.candidate.title.slice(0, 120),
  });
  return decision;
}

function parseIcpJson(raw: string): IcpFilterResult {
  const parsed = tryParseJsonObject<{ match?: unknown; reason?: unknown }>(raw, {});
  return {
    match: parsed.match === true,
    reason: typeof parsed.reason === "string" ? parsed.reason : "no reason given",
  };
}
