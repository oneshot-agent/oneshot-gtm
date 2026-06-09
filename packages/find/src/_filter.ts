import { loadConfig, logEvent } from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";

export interface IcpFilterResult {
  /**
   * Tri-state:
   *   - `true`  → candidate matches the ICP (or no ICP set; pass-through)
   *   - `false` → real ICP miss → callers persist a rejected row (audit trail
   *               + manual override path)
   *   - `null`  → TRANSIENT classifier failure (LLM 5xx / timeout / rate-limit).
   *               Callers must DROP the candidate without persisting — the
   *               dedupeKey would otherwise burn for every future watch tick
   *               (isQueueDuplicate ignores status).
   */
  match: boolean | null;
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
  let decision: IcpFilterResult;
  try {
    const res = await complete({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.1,
      maxTokens: 200,
    });
    decision = parseIcpJson(res.content);
  } catch (err) {
    // A classifier failure (LLM timeout / provider error) must not abort the
    // whole finder run — drop just this candidate. Drop-on-error (not
    // pass-through) keeps a systematic outage visible as an empty run rather
    // than flooding the queue with unfiltered candidates.
    logEvent(
      "error.swallowed",
      {
        kind: "icp-filter",
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return { match: null, reason: "icp classifier unavailable" };
  }
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
  // A malformed / truncated / refused response yields the `{}` fallback (no
  // boolean `match`). Treat that as a transient failure (`null`) — same as a
  // thrown classifier error — so callers drop WITHOUT persisting a rejected
  // row. Collapsing it to `false` would burn the dedupeKey forever, since
  // isQueueDuplicate ignores status.
  if (typeof parsed.match !== "boolean") {
    return { match: null, reason: "icp classifier malformed response" };
  }
  return {
    match: parsed.match,
    reason: typeof parsed.reason === "string" ? parsed.reason : "no reason given",
  };
}
