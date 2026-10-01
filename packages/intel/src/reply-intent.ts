import { loadConfig, logEvent, type InboxEmail, type OneShotConfig } from "@oneshot-gtm/core";
import { REPLY_INTENTS, isReplyIntent, type ReplyIntent } from "@oneshot-gtm/shared-types";
import { backoffDelayMs, isRetryableLlmError, LlmError, parseRetryAfter } from "./client.ts";
import { triageEmails } from "./triage.ts";

/**
 * One reply's intent, with how it was decided. `confidence`/`probabilities`
 * come only from the decisions engine; the LLM triage gives neither.
 */
export interface ReplyIntentResult {
  intent: ReplyIntent;
  /** One line: the LLM's justification, or the decisions engine's top labels. */
  reason: string;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  /** `<engine>:<model>` that produced the label. */
  classifier: string;
  costMicros: number | null;
  /** Confidence under the workspace threshold: store it, but act on it only to avoid contact. */
  review: boolean;
  /** The decisions engine was configured but failed, so the LLM triage labelled it. */
  fellBack: boolean;
}

/** Thrown when no engine produced a label; the caller releases the claim. */
export class ReplyIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyIntentError";
  }
}

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const DECISIONS_TIMEOUT_MS = 10_000;
const DECISIONS_MAX_ATTEMPTS = 2;
const DEFAULT_MIN_CONFIDENCE = 0.5;
const BODY_CHARS = 2000;

const INSTRUCTIONS =
  "This is a reply to a cold outreach email a founder sent. Classify the intent of the reply.";

/** The decisions-engine criteria: every label with its shared definition. */
export function replyIntentCriteria(): Record<string, string> {
  return Object.fromEntries(REPLY_INTENTS.map((i) => [i.label, i.description]));
}

function minConfidenceOf(cfg: OneShotConfig): number {
  const v = cfg.replyClassifier?.minConfidence;
  return typeof v === "number" && v >= 0 && v <= 1 ? v : DEFAULT_MIN_CONFIDENCE;
}

function stateOf(email: InboxEmail): string {
  return `Subject: ${email.subject ?? ""}\n\n${(email.body ?? "").slice(0, BODY_CHARS)}`;
}

interface DecisionsAnswer {
  choice: ReplyIntent;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  costUsd: number | null;
  model: string;
}

async function callDecisions(
  email: InboxEmail,
  model: string,
  key: string,
  fetchImpl: typeof fetch,
): Promise<DecisionsAnswer> {
  let attempt = 0;
  for (;;) {
    attempt++;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), DECISIONS_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(DECISIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/oneshot-agent/oneshot-gtm",
          "X-Title": "oneshot-gtm",
        },
        body: JSON.stringify({
          model,
          questions: {
            intent: { type: "choice", instructions: INSTRUCTIONS, criteria: replyIntentCriteria() },
          },
          state: stateOf(email),
        }),
        signal: ctl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      // A timeout or transport failure: retryable, like the LLM client's.
      const e = new LlmError(
        (err as Error)?.name === "AbortError"
          ? `decisions request timed out after ${DECISIONS_TIMEOUT_MS}ms`
          : `decisions request failed: ${(err as Error)?.message ?? err}`,
        503,
      );
      if (attempt < DECISIONS_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, backoffDelayMs(attempt)));
        continue;
      }
      throw e;
    }
    clearTimeout(timer);
    if (!res.ok) {
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), Date.now());
      const e = new LlmError(`decisions HTTP ${res.status}`, res.status, retryAfterMs);
      if (attempt < DECISIONS_MAX_ATTEMPTS && isRetryableLlmError(e)) {
        await new Promise((r) => setTimeout(r, backoffDelayMs(attempt, retryAfterMs)));
        continue;
      }
      throw e;
    }
    const body = (await res.json().catch(() => null)) as {
      model?: string;
      answers?: { intent?: { choice?: unknown; confidence?: unknown; probabilities?: unknown } };
      usage?: { cost?: unknown };
    } | null;
    const answer = body?.answers?.intent;
    if (!answer || !isReplyIntent(answer.choice)) {
      throw new LlmError(
        `decisions response had no known label (got ${JSON.stringify(answer?.choice ?? null)})`,
      );
    }
    const probs =
      answer.probabilities && typeof answer.probabilities === "object"
        ? Object.fromEntries(
            Object.entries(answer.probabilities as Record<string, unknown>).filter(
              (e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]),
            ),
          )
        : null;
    return {
      choice: answer.choice,
      confidence:
        typeof answer.confidence === "number" && Number.isFinite(answer.confidence)
          ? answer.confidence
          : null,
      probabilities: probs,
      costUsd: typeof body?.usage?.cost === "number" ? body.usage.cost : null,
      model: typeof body?.model === "string" && body.model ? body.model : model,
    };
  }
}

function topLabels(probs: Record<string, number> | null, n = 3): string {
  if (!probs) return "";
  return Object.entries(probs)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`)
    .join(", ");
}

async function classifyWithLlm(email: InboxEmail, cfg: OneShotConfig, fellBack: boolean) {
  const [r] = await triageEmails([email]);
  if (!r) throw new ReplyIntentError("triage returned no label");
  const result: ReplyIntentResult = {
    intent: r.category,
    reason: r.reasoning,
    confidence: null,
    probabilities: null,
    classifier: `llm:${cfg.llmModel}`,
    costMicros: null,
    review: false,
    fellBack,
  };
  return result;
}

/**
 * Label one inbound human reply with an intent from the shared REPLY_INTENTS
 * table, using the workspace's `replyClassifier` engine. The decisions engine
 * falls back to the LLM triage on a missing key or model, a timeout, a non-2xx
 * response, or a response without a known label, so a configured-but-broken
 * engine never leaves replies unlabelled. Throws only when no engine produced
 * a label (the caller releases its claim so a later pass retries).
 */
export async function classifyReplyIntent(
  email: InboxEmail,
  opts: { fetchImpl?: typeof fetch; cfg?: OneShotConfig } = {},
): Promise<ReplyIntentResult> {
  const cfg = opts.cfg ?? loadConfig();
  const engine = cfg.replyClassifier?.engine ?? "llm";
  if (engine !== "decisions") return classifyWithLlm(email, cfg, false);

  const model = cfg.replyClassifier?.model?.trim();
  const key = process.env["OPENROUTER_API_KEY"]?.trim();
  if (!model || !key) {
    logEvent(
      "reply.intent.fallback",
      { reason: !model ? "no_model" : "no_openrouter_key" },
      "warn",
    );
    return classifyWithLlm(email, cfg, true);
  }
  try {
    const a = await callDecisions(email, model, key, opts.fetchImpl ?? fetch);
    const min = minConfidenceOf(cfg);
    return {
      intent: a.choice,
      reason: topLabels(a.probabilities) || a.choice,
      confidence: a.confidence,
      probabilities: a.probabilities,
      classifier: `decisions:${a.model}`,
      costMicros: a.costUsd == null ? null : Math.round(a.costUsd * 1_000_000),
      review: a.confidence != null && a.confidence < min,
      fellBack: false,
    };
  } catch (err) {
    logEvent(
      "reply.intent.fallback",
      { reason: "decisions_failed", message_120: ((err as Error)?.message ?? "").slice(0, 120) },
      "warn",
    );
    return classifyWithLlm(email, cfg, true);
  }
}
