import { getLedger, loadConfig, logEvent } from "@oneshot-gtm/core";
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
  let examples: ReturnType<ReturnType<typeof getLedger>["recentIcpDecisions"]> = [];
  try {
    // Keep this boundary defensive even if a custom/older core returns full
    // queue payloads: those may contain contact details added by enrichment.
    examples = getLedger()
      .recentIcpDecisions(20)
      .map((example) => ({
        candidate: publicCandidateContext(example.candidate),
        decision: example.decision,
        reason: example.reason,
      }));
  } catch (err) {
    // Learning context is optional: a damaged/locked ledger must not turn a
    // usable classifier into a finder-wide failure.
    logEvent(
      "error.swallowed",
      {
        kind: "icp-filter-examples",
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
  }
  const user = JSON.stringify({
    icp: input.icp,
    candidate: input.candidate,
    examples,
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

const PUBLIC_CANDIDATE_FIELDS = [
  "title",
  "url",
  "summary",
  "author",
  "description",
  "postTitle",
  "postUrl",
  "repo",
  "repoUrl",
  "eventName",
  "eventUrl",
  "company",
] as const;

function publicCandidateContext(candidate: unknown): Record<string, unknown> {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return {};
  const source = candidate as Record<string, unknown>;
  return Object.fromEntries(
    PUBLIC_CANDIDATE_FIELDS.flatMap((field) => {
      const value = source[field];
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? [[field, value] as const]
        : [];
    }),
  );
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

/**
 * Verdict for a person-level ICP judgement.
 *
 * Four states, not the boolean `icpFilter` uses, because the distinction that
 * matters here is the one a boolean cannot express: "this role text is real
 * but does not settle the question". That case must trigger a paid profile
 * lookup, not a guess — guessing is what let a snowboard-team coordinator and
 * an Account Executive through.
 *
 *   - `pass`      → role fits the ICP; proceed
 *   - `reject`    → clearly a different job function; persist a rejected row
 *   - `unclear`   → genuine answer meaning "insufficient signal"; ESCALATE to
 *                   enrichment and re-judge on a real title
 *   - `transient` → classifier failure. Drop WITHOUT persisting, exactly as
 *                   `icpFilter` returns `null`: a persisted rejection would
 *                   burn the dedupeKey forever (isQueueDuplicate ignores
 *                   status), so an LLM outage would permanently blacklist
 *                   every candidate it touched.
 */
export type PersonVerdict = "pass" | "reject" | "unclear" | "transient";

export interface PersonQualification {
  verdict: PersonVerdict;
  reason: string;
}

export interface PersonCandidate {
  name?: string | null;
  company?: string | null;
  /** Job title, self-written headline, or event bio. May be absent. */
  roleText?: string | null;
  /** Why this person surfaced (starred repo, attended event). Context only. */
  evidence?: string | null;
}

/** No role text at all is the same escalation path as an ambiguous one. */
export function hasRoleText(person: PersonCandidate): boolean {
  return (person.roleText ?? "").trim().length > 0;
}

/**
 * Judge one person's role against the ICP.
 *
 * Deliberately NOT built on `icpFilter`: that classifier is tuned for
 * companies, repos and events, its prompt says "brief titles with no context
 * default to false", and its boolean cannot carry `unclear`. Feeding a bare
 * headline into it produces confident rejections of people who are fine.
 *
 * Callers must escalate on BOTH `unclear` and missing role text — see
 * `_contact.ts` / the finder call sites for the staged A→B→C ordering.
 */
export async function qualifyPerson(input: {
  icp: string | null;
  person: PersonCandidate;
}): Promise<PersonQualification> {
  // No ICP configured: same pass-through contract as `icpFilter`. The founder
  // hasn't told us who they want, so we don't get to reject on their behalf.
  if (!input.icp) {
    return { verdict: "pass", reason: "no ICP set; pass-through" };
  }
  // Nothing to judge. Not a rejection — the caller escalates to enrichment.
  if (!hasRoleText(input.person)) {
    return { verdict: "unclear", reason: "no role text available" };
  }

  const system = loadPrompt("icp-filter-person");
  const user = JSON.stringify({ icp: input.icp, person: input.person });

  let decision: PersonQualification;
  try {
    const res = await complete({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.1,
      maxTokens: 200,
    });
    decision = parsePersonJson(res.content);
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "icp-filter-person",
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return { verdict: "transient", reason: "person classifier unavailable" };
  }

  // roleText is a public job title / self-written headline, not private
  // prospect data — same logging rationale as `icp.decision` above.
  logEvent("icp.person_decision", {
    verdict: decision.verdict,
    reason_120: decision.reason.slice(0, 120),
    role_120: (input.person.roleText ?? "").slice(0, 120),
  });
  return decision;
}

function parsePersonJson(raw: string): PersonQualification {
  const parsed = tryParseJsonObject<{ verdict?: unknown; reason?: unknown }>(raw, {});
  const reason = typeof parsed.reason === "string" ? parsed.reason : "no reason given";
  // A malformed / truncated / refused response is a platform failure, not a
  // verdict. Returning `transient` (never `reject`) keeps the dedupeKey alive.
  // Note `transient` is code-only — the prompt is never asked to emit it.
  if (parsed.verdict === "pass" || parsed.verdict === "reject" || parsed.verdict === "unclear") {
    return { verdict: parsed.verdict, reason };
  }
  return { verdict: "transient", reason: "person classifier malformed response" };
}
