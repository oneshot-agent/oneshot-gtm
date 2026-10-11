import { llmApiKey, loadConfig, logEvent, type OneShotConfig } from "@oneshot-gtm/core";
import { loadPrompt } from "./prompts.ts";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCompleteInput {
  /** Accounting hook after local preflight, immediately before each provider attempt. */
  onAttempt?: () => void;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  /**
   * Accept a response cut off at max_tokens instead of throwing. For callers
   * that consume PROSE (weekly review, advise), where a truncated report is
   * still usable. JSON-parsing callers must leave this unset: truncated JSON
   * silently degrades to an empty object downstream.
   */
  allowTruncation?: boolean;
  /**
   * Per-request wall-clock budget. The request is aborted when it expires and
   * the attempt counts as retryable. A hung socket is the failure mode that
   * otherwise stalls a whole 50-target drain behind one target.
   */
  timeoutMs?: number;
  /** Total attempts including the first. Clamped to >= 1. */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 20_000;
/**
 * Maximum accepted Retry-After. complete() fails fast above this budget rather
 * than retrying before the server permits it.
 */
const MAX_RETRY_AFTER_MS = 60_000;
/**
 * Minimum explicit timeout. Zero or negative values would abort every attempt
 * before dispatch. An omitted timeoutMs still means no client-side timeout.
 */
const MIN_TIMEOUT_MS = 1_000;

export interface LlmCompleteOutput {
  /** Provider-reported USD, when available. */
  costUsd?: number;
  content: string;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export class LlmError extends Error {
  public status?: number;
  public retryAfterMs?: number;

  constructor(message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The completion was cut off at the token limit. Terminal for the same
 * request, but a caller that can ask for less (a smaller slice of its input)
 * can tell this apart from every other failure and do so.
 */
export class LlmTruncatedError extends LlmError {
  constructor(message: string) {
    super(message);
    this.name = "LlmTruncatedError";
  }
}

/** A per-request timeout that aborted the fetch. Always retryable. */
class LlmTimeoutError extends LlmError {
  constructor(message: string) {
    super(message);
    this.name = "LlmTimeoutError";
  }
}

/**
 * DNS, TLS, or socket failures caught before an HTTP response arrives. Classify
 * at the fetch call site: a TypeError from parsing a malformed body is not a
 * transport failure and must not trigger retries.
 */
class LlmNetworkError extends LlmError {
  constructor(message: string) {
    super(message);
    this.name = "LlmNetworkError";
  }
}

/**
 * Retry rate limits, provider faults, timeouts, and transport failures. Bad
 * requests, invalid credentials/models, truncated or empty completions, and
 * response-parsing bugs are terminal; retries would repeat the failure and cost.
 */
export function isRetryableLlmError(err: unknown): boolean {
  if (err instanceof LlmTimeoutError || err instanceof LlmNetworkError) return true;
  if (err instanceof LlmError) {
    if (err.status === undefined) return false;
    return err.status === 429 || err.status >= 500;
  }
  return false;
}

/**
 * Delta-seconds or HTTP-date, per RFC 9110. Returns undefined for anything
 * unparseable so the caller falls back to its own backoff.
 */
export function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/**
 * Bounded exponential backoff with equal jitter: half fixed, half random.
 * `attempt` is 1-based and identifies the attempt preceding this delay.
 */
export function backoffDelayMs(
  attempt: number,
  retryAfterMs?: number,
  rand: () => number = Math.random,
): number {
  const capped = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  const backoff = Math.round(capped / 2 + rand() * (capped / 2));
  if (retryAfterMs === undefined) return backoff;
  // Keep jittered pacing even for zero or past Retry-After values.
  // complete() rejects hints above MAX_RETRY_AFTER_MS before reaching here.
  return Math.max(retryAfterMs, backoff);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Distinguish reasoning-budget exhaustion from answer overflow so callers can
 * choose a non-reasoning model or increase the appropriate token budget.
 */
function truncationMessage(d: {
  provider: string;
  model: string;
  maxTokens: number;
  completionTokens?: number;
  reasoningTokens?: number;
}): string {
  // Diagnostic first: callers surface this through an 80-char slice
  // (errorDraft), so the cause has to survive the truncation of the truncation.
  const where = `${d.provider} ${d.model}`;
  if (d.reasoningTokens && d.reasoningTokens > 0) {
    const of = d.completionTokens ? `/${d.completionTokens}` : "";
    return `truncated at max_tokens=${d.maxTokens} (${d.reasoningTokens}${of} tokens were reasoning) — ${where}. Use a model that does not reason by default, or raise maxTokens above the reasoning budget.`;
  }
  return `truncated at max_tokens=${d.maxTokens} (raise maxTokens) — ${where}.`;
}

let humanizerPrologueCache: string | null = null;
function humanizerPrologue(): string {
  if (humanizerPrologueCache !== null) return humanizerPrologueCache;
  try {
    humanizerPrologueCache = loadPrompt("_humanizer");
  } catch {
    humanizerPrologueCache = "";
  }
  return humanizerPrologueCache;
}

function injectHumanizer(messages: LlmMessage[]): LlmMessage[] {
  const prologue = humanizerPrologue();
  if (!prologue) return messages;
  const sysIdx = messages.findIndex((m) => m.role === "system");
  if (sysIdx < 0) {
    return [{ role: "system", content: prologue }, ...messages];
  }
  const sys = messages[sysIdx];
  if (!sys) return messages;
  // loadPrompt already expands the selected humanizer; never prepend it again.
  if (sys.content.includes("Anti-AI-slop rules")) return messages;
  if (sys.content.includes("_humanizer.md")) {
    const out: LlmMessage[] = messages.slice();
    out[sysIdx] = { role: "system", content: `${prologue}\n\n---\n\n${sys.content}` };
    return out;
  }
  return messages;
}

export async function complete(input: LlmCompleteInput): Promise<LlmCompleteOutput> {
  const cfg = loadConfig();
  const key = llmApiKey(cfg.llmProvider);
  if (!key) {
    const envName = {
      openrouter: "OPENROUTER_API_KEY",
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
    }[cfg.llmProvider];
    throw new LlmError(`No ${envName} set. Run: oneshot-gtm config llm`);
  }

  const expanded: LlmCompleteInput = { ...input, messages: injectHumanizer(input.messages) };

  // `??` treats 0 as "supplied", and 0 (or a negative value) would abort every
  // attempt before it reaches the provider. Only clamp when a value was
  // actually given: leaving timeoutMs unset must keep meaning "no timeout".
  const timeoutMs =
    input.timeoutMs === undefined ? undefined : Math.max(MIN_TIMEOUT_MS, input.timeoutMs);
  const maxAttempts = Math.max(1, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

  const startedAt = Date.now();
  logEvent("llm.start", {
    provider: cfg.llmProvider,
    model: cfg.llmModel,
    message_count: expanded.messages.length,
    max_tokens: expanded.maxTokens ?? null,
    max_attempts: maxAttempts,
    timeout_ms: timeoutMs ?? null,
  });

  // Keep success logging outside the retry block: a logging failure must not
  // discard a paid completion and resend the prompt.
  let result: LlmCompleteOutput | undefined;
  let attempts = 0;

  for (let attempt = 1; ; attempt++) {
    try {
      input.onAttempt?.();
      result = await dispatch(cfg.llmProvider, cfg.llmModel, key, expanded, timeoutMs);
      attempts = attempt;
      break;
    } catch (err) {
      const status = err instanceof LlmError ? (err.status ?? null) : null;
      const retryAfterMs = err instanceof LlmError ? err.retryAfterMs : undefined;
      // Reject Retry-After above the wait budget only if another retry is
      // possible. Preserve the original error for terminal statuses or an
      // exhausted attempt count.
      const overRetryBudget =
        attempt < maxAttempts &&
        isRetryableLlmError(err) &&
        retryAfterMs !== undefined &&
        retryAfterMs > MAX_RETRY_AFTER_MS;
      const ctx = {
        provider: cfg.llmProvider,
        model: cfg.llmModel,
        duration_ms: Date.now() - startedAt,
        error_class: (err as Error).constructor.name,
        message_120: ((err as Error).message ?? "").slice(0, 120),
        status,
        attempt,
        max_attempts: maxAttempts,
      };
      if (attempt < maxAttempts && isRetryableLlmError(err) && !overRetryBudget) {
        const delayMs = backoffDelayMs(attempt, retryAfterMs);
        logEvent("llm.retry", { ...ctx, delay_ms: delayMs }, "warn");
        await sleep(delayMs);
        continue;
      }
      if (overRetryBudget) {
        logEvent("llm.error", { ...ctx, retry_after_ms: retryAfterMs }, "error");
        throw new LlmError(
          `${cfg.llmProvider} asked us to wait ${Math.round((retryAfterMs as number) / 1000)}s (Retry-After), ` +
            `longer than the ${MAX_RETRY_AFTER_MS / 1000}s retry budget — giving up instead of ` +
            `burning attempts on a guaranteed-failing retry.`,
          status ?? undefined,
          retryAfterMs,
        );
      }
      logEvent("llm.error", ctx, "error");
      throw err;
    }
  }

  logEvent("llm.done", {
    provider: cfg.llmProvider,
    model: cfg.llmModel,
    duration_ms: Date.now() - startedAt,
    response_chars: result.content.length,
    attempts,
  });
  return result;
}

function dispatch(
  provider: OneShotConfig["llmProvider"],
  model: string,
  key: string,
  input: LlmCompleteInput,
  timeoutMs: number | undefined,
): Promise<LlmCompleteOutput> {
  switch (provider) {
    case "openrouter": {
      const args: OpenAIArgs = {
        key,
        model,
        baseUrl: "https://openrouter.ai/api/v1",
        provider: "openrouter",
        input,
        timeoutMs,
        extraHeaders: {
          "HTTP-Referer": "https://github.com/oneshot-agent/oneshot-gtm",
          "X-Title": "oneshot-gtm",
        },
      };
      // OpenRouter counts reasoning against max_tokens. Disable it for callers'
      // small JSON budgets. Models that require reasoning reject that switch
      // with a 400; use low effort plus extra tokens so maxTokens remains an
      // answer budget. Cache the requirement and seed known families to avoid
      // repeating the initial rejection.
      if (mandatoryReasoningModels.has(model) || seededMandatory(model)) {
        return completeWithMandatoryReasoning(args);
      }
      return openaiCompatibleComplete({ ...args, disableReasoning: true }).catch((err: unknown) => {
        if (isMandatoryReasoningRejection(err)) {
          mandatoryReasoningModels.add(model);
          return completeWithMandatoryReasoning(args);
        }
        throw err;
      });
    }
    case "openai":
      return openaiCompatibleComplete({
        key,
        model,
        baseUrl: "https://api.openai.com/v1",
        provider: "openai",
        input,
        timeoutMs,
      });
    case "anthropic":
      return anthropicComplete({ key, model, input, timeoutMs });
  }
}

/**
 * Extra tokens for mandatory reasoning, preserving maxTokens as the answer
 * budget. Gemini-3.8-flash at medium effort used 481 reasoning tokens for an
 * approximately 200-token answer. Leave headroom: unused tokens are not billed.
 */
export const MANDATORY_REASONING_ALLOWANCE_TOKENS = 1536;
/** Every reasoning-mandatory model on OpenRouter accepts `low`; not all accept `minimal`. */
export const MANDATORY_REASONING_EFFORT = "low";

/**
 * Cache mandatory-reasoning models discovered from provider 400s and seed known
 * families to avoid that first rejection. Unlisted models are still detected;
 * seeds that later allow reasoning to be disabled only waste token headroom.
 */
const mandatoryReasoningModels = new Set<string>();
const MANDATORY_REASONING_SEED = [/^google\/gemini-3\.[5-9]-flash/, /^openai\/gpt-5/];
function seededMandatory(model: string): boolean {
  return MANDATORY_REASONING_SEED.some((re) => re.test(model));
}

/**
 * The mandatory path: lowest effort plus the allowance. A model that rejects
 * the `effort` parameter too (a second 400 about reasoning) is called with no
 * reasoning parameter at all, but still with the raised budget, which is the
 * half of the fix that actually matters.
 */
function completeWithMandatoryReasoning(args: OpenAIArgs): Promise<LlmCompleteOutput> {
  const raised = { ...args, extraMaxTokens: MANDATORY_REASONING_ALLOWANCE_TOKENS };
  return openaiCompatibleComplete({ ...raised, reasoningEffort: MANDATORY_REASONING_EFFORT }).catch(
    (err: unknown) => {
      if (isMandatoryReasoningRejection(err)) return openaiCompatibleComplete(raised);
      throw err;
    },
  );
}

/** A 400 whose body talks about reasoning: the model cannot have it switched off. */
function isMandatoryReasoningRejection(err: unknown): boolean {
  return err instanceof LlmError && err.status === 400 && /reasoning/i.test(err.message);
}

/**
 * One POST under a single abort budget covering the body read too. A provider
 * that accepts the connection and then stalls mid-stream is the same failure as
 * one that never answers. Non-2xx becomes an LlmError carrying status and
 * Retry-After so the retry loop can classify and pace it.
 */
async function postJson(args: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  provider: string;
  timeoutMs: number | undefined;
}): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = args.timeoutMs ? setTimeout(() => controller.abort(), args.timeoutMs) : undefined;
  const timedOut = () =>
    new LlmTimeoutError(`${args.provider} request timed out after ${args.timeoutMs}ms`);
  try {
    let res: Response;
    try {
      res = await fetch(args.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...args.headers },
        body: JSON.stringify(args.body),
        signal: controller.signal,
      });
    } catch (err) {
      // No response at all: either our own abort or a transport failure. These
      // are the only two shapes a retry can fix.
      if (controller.signal.aborted) throw timedOut();
      throw new LlmNetworkError(`${args.provider} request failed: ${(err as Error).message}`);
    }

    if (!res.ok) {
      // The status is known, so the status decides. A 401 that happens to time
      // out while we read its body is still a 401, and retrying it three times
      // just burns the budget on the same rejected key.
      let text = "";
      try {
        text = await res.text();
      } catch {
        text = "<error body unreadable>";
      }
      throw new LlmError(
        `${args.provider} ${res.status}: ${text.slice(0, 400)}`,
        res.status,
        parseRetryAfter(res.headers.get("retry-after"), Date.now()),
      );
    }

    try {
      const parsed: unknown = await res.json();
      // A 2xx body that parses to JSON `null` (or any non-object shape) is the
      // same "nothing usable" case as a body that never arrives. Both provider
      // paths immediately do `data.choices` / `data.content`, so an
      // unclassified null here used to surface as a bare TypeError at the call
      // site instead of a named, retry-classified error.
      if (parsed === null || typeof parsed !== "object") {
        throw new LlmError(
          `${args.provider} returned a 2xx response with a non-object JSON body (${JSON.stringify(parsed)})`,
        );
      }
      return parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof LlmError) throw err;
      // A 2xx whose body never arrives or is not JSON leaves us with nothing
      // usable, so this one genuinely is worth another attempt.
      if (controller.signal.aborted) throw timedOut();
      throw new LlmNetworkError(
        `${args.provider} response body could not be read: ${(err as Error).message}`,
      );
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface OpenAIArgs {
  key: string;
  model: string;
  baseUrl: string;
  provider: string;
  input: LlmCompleteInput;
  timeoutMs: number | undefined;
  extraHeaders?: Record<string, string>;
  /** Send OpenRouter's `reasoning: { enabled: false }`: see the openrouter dispatch. */
  disableReasoning?: boolean;
  /**
   * Send OpenRouter's `reasoning: { effort }` instead: for models whose
   * reasoning cannot be switched off. Mutually exclusive with disableReasoning.
   */
  reasoningEffort?: string;
  /**
   * Extra completion budget on top of the caller's `maxTokens`. A reasoning-
   * mandatory model spends its thinking inside `max_tokens`, so the caller's
   * "tokens of answer I want" has to be topped up or the answer never starts.
   */
  extraMaxTokens?: number;
}

async function openaiCompatibleComplete(args: OpenAIArgs): Promise<LlmCompleteOutput> {
  const maxTokens = (args.input.maxTokens ?? 1024) + (args.extraMaxTokens ?? 0);
  const data = (await postJson({
    url: `${args.baseUrl}/chat/completions`,
    headers: { Authorization: `Bearer ${args.key}`, ...args.extraHeaders },
    body: {
      model: args.model,
      messages: args.input.messages,
      temperature: args.input.temperature ?? 0.7,
      max_tokens: maxTokens,
      // OpenRouter only. The OpenAI API rejects unknown parameters.
      ...(args.disableReasoning
        ? { reasoning: { enabled: false } }
        : args.reasoningEffort
          ? { reasoning: { effort: args.reasoningEffort } }
          : {}),
    },
    provider: args.provider,
    timeoutMs: args.timeoutMs,
  })) as {
    choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
    error?: { message?: string; code?: number };
    usage?: {
      cost?: number;
      prompt_tokens?: number;
      completion_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };

  // OpenRouter answers upstream faults with 200 and an error envelope instead of
  // choices. Naming it here keeps the failure a terminal LlmError: reaching for
  // data.choices[0] on it would throw a bare TypeError, which reads as weather.
  if (data.error) {
    const code = data.error.code === undefined ? "" : ` (code ${data.error.code})`;
    // Pass numeric codes through as status so retry logic can classify them (429/5xx).
    // Non-numeric or absent codes stay terminal.
    const status = typeof data.error.code === "number" ? data.error.code : undefined;
    throw new LlmError(
      `${args.provider} returned an error envelope${code}: ${data.error.message ?? "no message"}`,
      status,
    );
  }

  const choice = data.choices?.[0];
  if (!choice) throw new LlmError(`${args.provider} returned no choices`);

  // A response cut off at max_tokens is unusable: every caller parses JSON out
  // of it, and truncated JSON silently degrades to an empty object four layers
  // up (empty subject/body on a draft). Fail loudly at the source instead.
  if (choice.finish_reason === "length" && !args.input.allowTruncation) {
    throw new LlmTruncatedError(
      truncationMessage({
        provider: args.provider,
        model: args.model,
        maxTokens,
        completionTokens: data.usage?.completion_tokens,
        reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
      }),
    );
  }

  // A refusal, or a tool-call/reasoning-only message, carries no text. That is a
  // real answer from the provider, not a transport hiccup: repeating the prompt
  // buys the same reply at twice the price, so name the signal and stop.
  const content = choice.message?.content;
  if (typeof content !== "string") {
    throw new LlmError(
      `${args.provider} returned a message with no text content (finish_reason=${choice.finish_reason ?? "none"})`,
    );
  }

  return {
    content,
    provider: args.provider,
    model: args.model,
    ...(typeof data.usage?.cost === "number" &&
    Number.isFinite(data.usage.cost) &&
    data.usage.cost >= 0
      ? { costUsd: data.usage.cost }
      : {}),
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  };
}

interface AnthropicArgs {
  key: string;
  model: string;
  input: LlmCompleteInput;
  timeoutMs: number | undefined;
}

async function anthropicComplete(args: AnthropicArgs): Promise<LlmCompleteOutput> {
  const system = args.input.messages.find((m) => m.role === "system")?.content;
  const messages = args.input.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));

  const data = (await postJson({
    url: "https://api.anthropic.com/v1/messages",
    headers: { "x-api-key": args.key, "anthropic-version": "2023-06-01" },
    body: {
      model: args.model,
      max_tokens: args.input.maxTokens ?? 1024,
      temperature: args.input.temperature ?? 0.7,
      ...(system ? { system } : {}),
      messages,
    },
    provider: "anthropic",
    timeoutMs: args.timeoutMs,
  })) as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  if (data.stop_reason === "max_tokens" && !args.input.allowTruncation) {
    throw new LlmTruncatedError(
      truncationMessage({
        provider: "anthropic",
        model: args.model,
        maxTokens: args.input.maxTokens ?? 1024,
        completionTokens: data.usage?.output_tokens,
      }),
    );
  }

  // Same as the OpenAI path: an absent content array is a provider signal
  // (refusal, filtered output), not something a second attempt recovers.
  if (!Array.isArray(data.content)) {
    throw new LlmError(
      `anthropic returned no content blocks (stop_reason=${data.stop_reason ?? "none"})`,
    );
  }

  const text = data.content.map((b) => b.text ?? "").join("");
  return {
    content: text,
    provider: "anthropic",
    model: args.model,
    inputTokens: data.usage?.input_tokens,
    outputTokens: data.usage?.output_tokens,
  };
}
