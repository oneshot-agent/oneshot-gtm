/**
 * A typed decisions model on OpenRouter's decisions API: a set of named
 * questions over one state, each answered with a label from its criteria,
 * a confidence and the label probabilities. Callers keep their own fallback;
 * this only makes the request. Model ids are config data.
 */
import { backoffDelayMs, isRetryableLlmError, LlmError, parseRetryAfter } from "./client.ts";

export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const DECISIONS_TIMEOUT_MS = 10_000;
const DECISIONS_MAX_ATTEMPTS = 2;
/** A Retry-After hint longer than this throws instead of sleeping: callers fall back. */
const DECISIONS_MAX_RETRY_AFTER_MS = 5_000;

/** One question: pick the label whose definition fits the state best. */
export interface DecisionsChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Label → definition. The answer must be one of these labels. */
  criteria: Record<string, string>;
}

export interface DecisionsChoiceAnswer {
  choice: string;
  confidence: number | null;
  probabilities: Record<string, number> | null;
}

export interface DecisionsResult {
  /** One answer per question asked, keyed by question name. */
  answers: Record<string, DecisionsChoiceAnswer>;
  costUsd: number | null;
  /** The model id the API reports, else the one asked for. */
  model: string;
}

function readAnswer(
  raw: unknown,
  question: DecisionsChoiceQuestion,
): DecisionsChoiceAnswer | { bad: unknown } {
  const a = (raw && typeof raw === "object" ? raw : {}) as {
    choice?: unknown;
    confidence?: unknown;
    probabilities?: unknown;
  };
  if (typeof a.choice !== "string" || !Object.hasOwn(question.criteria, a.choice)) {
    return { bad: a.choice ?? null };
  }
  const probabilities =
    a.probabilities && typeof a.probabilities === "object"
      ? Object.fromEntries(
          Object.entries(a.probabilities as Record<string, unknown>).filter(
            (e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]),
          ),
        )
      : null;
  return {
    choice: a.choice,
    confidence:
      typeof a.confidence === "number" && Number.isFinite(a.confidence) ? a.confidence : null,
    probabilities,
  };
}

/**
 * Ask every question in one request. Retries a timeout, a transport failure
 * or a retryable status once (a short Retry-After is honoured, a long one
 * throws at once). Throws an `LlmError` on any failure, including an answer
 * missing or outside its question's labels, so the caller can fall back.
 */
export async function callDecisions(input: {
  model: string;
  key: string;
  questions: Record<string, DecisionsChoiceQuestion>;
  state: string;
  fetchImpl?: typeof fetch;
}): Promise<DecisionsResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
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
          Authorization: `Bearer ${input.key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/oneshot-agent/oneshot-gtm",
          "X-Title": "oneshot-gtm",
        },
        body: JSON.stringify({
          model: input.model,
          questions: input.questions,
          state: input.state,
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
    if (!res.ok) {
      clearTimeout(timer);
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), Date.now());
      const e = new LlmError(`decisions HTTP ${res.status}`, res.status, retryAfterMs);
      // A long Retry-After would stall the caller (the inbox poll, the
      // scheduler tick): throw now so it falls back rather than sleep through it.
      const waitOk = retryAfterMs === undefined || retryAfterMs <= DECISIONS_MAX_RETRY_AFTER_MS;
      if (attempt < DECISIONS_MAX_ATTEMPTS && isRetryableLlmError(e) && waitOk) {
        await new Promise((r) => setTimeout(r, backoffDelayMs(attempt, retryAfterMs)));
        continue;
      }
      throw e;
    }
    // The timeout covers the body read too: a stalled body aborts like a stalled request.
    const body = (await res
      .json()
      .catch(() => null)
      .finally(() => clearTimeout(timer))) as {
      model?: string;
      answers?: Record<string, unknown>;
      usage?: { cost?: unknown };
    } | null;
    const answers: Record<string, DecisionsChoiceAnswer> = {};
    for (const [name, question] of Object.entries(input.questions)) {
      const read = readAnswer(body?.answers?.[name], question);
      if ("bad" in read) {
        throw new LlmError(
          `decisions response had no known label${
            Object.keys(input.questions).length > 1 ? ` for ${name}` : ""
          } (got ${JSON.stringify(read.bad)})`,
        );
      }
      answers[name] = read;
    }
    return {
      answers,
      costUsd: typeof body?.usage?.cost === "number" ? body.usage.cost : null,
      model: typeof body?.model === "string" && body.model ? body.model : input.model,
    };
  }
}

/** The top labels of a probability map, "label 0.84, other 0.10": a one-line reason. */
export function topDecisionLabels(probs: Record<string, number> | null, n = 3): string {
  if (!probs) return "";
  return Object.entries(probs)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`)
    .join(", ");
}
