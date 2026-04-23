import { loadConfig } from "@oneshot-gtm/core";
import { complete, loadPrompt } from "@oneshot-gtm/intel";

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
  return parseIcpJson(res.content);
}

function parseIcpJson(raw: string): IcpFilterResult {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  let parsed: { match?: unknown; reason?: unknown } = {};
  try {
    parsed = JSON.parse((candidate ?? "").trim());
  } catch {
    const start = (candidate ?? "").indexOf("{");
    const end = (candidate ?? "").lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse((candidate ?? "").slice(start, end + 1));
      } catch {
        parsed = {};
      }
    }
  }
  return {
    match: parsed.match === true,
    reason: typeof parsed.reason === "string" ? parsed.reason : "no reason given",
  };
}
