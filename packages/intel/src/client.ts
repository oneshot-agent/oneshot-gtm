import { llmApiKey, loadConfig, logEvent, type OneShotConfig, configDir } from "@oneshot-gtm/core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPrompt } from "./prompts.ts";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCompleteInput {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  /**
   * Accept a response cut off at max_tokens instead of throwing. For callers
   * that consume PROSE (weekly review, advise), where a truncated report is
   * still usable. JSON-parsing callers must leave this unset — truncated JSON
   * silently degrades to an empty object downstream.
   */
  allowTruncation?: boolean;
  /**
   * Per-request wall-clock budget. The request is aborted when it expires and
   * the attempt counts as retryable — a hung socket is the failure mode that
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
 * Ceiling on a server-supplied Retry-After we are willing to wait out. Beyond
 * this it is a give-up, not a wait — see the budget check in complete(),
 * which fails fast instead of burning attempts on a guaranteed-failing retry.
 */
const MAX_RETRY_AFTER_MS = 60_000;
/**
 * Floor on an explicitly-supplied timeoutMs. `maxAttempts` is already clamped
 * to >= 1; timeoutMs needs the same treatment — 0 (or a negative value) would
 * abort the request before it ever reaches the provider, on every attempt.
 * Leaving timeoutMs unset is unaffected: that still means no client-side
 * timeout at all, not "use the floor".
 */
const MIN_TIMEOUT_MS = 1_000;

export interface LlmCompleteOutput {
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

/** A per-request timeout that aborted the fetch. Always retryable. */
class LlmTimeoutError extends LlmError {
  constructor(message: string) {
    super(message);
    this.name = "LlmTimeoutError";
  }
}

/**
 * A transport-level rejection — DNS, TLS, socket reset. Raised only where we
 * know no HTTP response was obtained, so a second attempt can plausibly land.
 * Classifying at the call site rather than by error type matters: fetch signals
 * these with a bare TypeError, and so does every accidental property access on
 * a malformed response body.
 */
class LlmNetworkError extends LlmError {
  constructor(message: string) {
    super(message);
    this.name = "LlmNetworkError";
  }
}

/**
 * Retry only the explicitly retryable set: rate limits, provider-side faults,
 * timeouts, and transport failures. Everything else is terminal — a 400 bad
 * request, a 401 bad key and a 404 unknown model are deterministic, a
 * truncation / no-choices / no-content LlmError carries no status and will
 * reproduce exactly, and a stray TypeError from parsing a malformed body is a
 * bug in us, not weather. Retrying any of those triples the bill for nothing.
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
 * Bounded exponential backoff with equal jitter — half the delay is fixed so
 * attempts still spread out, half is random so a batch that hits the same 429
 * doesn't march back in lockstep. `attempt` is 1-based (the delay AFTER it).
 */
export function backoffDelayMs(
  attempt: number,
  retryAfterMs?: number,
  rand: () => number = Math.random,
): number {
  const capped = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  const backoff = Math.round(capped / 2 + rand() * (capped / 2));
  if (retryAfterMs === undefined) return backoff;
  // Retry-After raises the wait, it never lowers it. `Retry-After: 0` and an
  // HTTP-date already in the past (clock skew, second-rounding) are both common
  // and both parse to 0 — honouring them literally would fire every attempt
  // within milliseconds, unpaced and unjittered. Anything past our retry
  // budget (MAX_RETRY_AFTER_MS) never reaches here — complete() rejects it as
  // terminal before computing a delay, rather than silently truncating a
  // 300s hint down to a guaranteed-failing 60s wait.
  return Math.max(retryAfterMs, backoff);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Names the two ways a call hits the token ceiling, because they need opposite
 * fixes: a model that reasons by default can burn the whole budget before it
 * emits a character (raising maxTokens does not help much — pick a model that
 * doesn't reason, or budget for both), while a plain overrun just needs more room.
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

/**
 * OpenRouter's per-model reasoning metadata (`GET /api/v1/models` →
 * `reasoning.supported_efforts`) differs by mandatory-reasoning model, and no
 * single tier is safe to hardcode: `google/gemini-3.8-flash` accepts
 * `"low" | "medium" | "high"` but 400s on `"minimal"`, while
 * `openai/o4-mini-high` and `openai/o3-mini-high` accept ONLY `"high"` —
 * `"low"` itself 400s on those. A fixed `"low"` therefore either fails
 * outright (o4-mini-high) or overpays (any model that does support
 * `"minimal"`). Instead the retry climbs this ladder lowest-to-highest,
 * stopping at the first effort the model accepts — see
 * `completeWithLowestSupportedEffort`, which is what actually "reads" the
 * supported set, by trial against the live 400s rather than a second network
 * round trip to the models endpoint.
 */
const REASONING_EFFORT_LADDER = ["minimal", "low", "medium", "high"] as const;

/**
 * Extra `max_tokens` layered on top of the caller's own budget for a
 * reasoning-mandatory retry, so a small JSON budget (every drafting prompt
 * in packages/plays asks for 200-2000 tokens) still has room to answer once
 * the model spends part of the ceiling on reasoning it cannot switch off.
 * Sized from the one live data point issue #586 reports: openrouter
 * google/gemini-3.8-flash at max_tokens=500, DEFAULT effort (medium — the
 * only effort measured live) spent 481/496 tokens on reasoning. No
 * OPENROUTER_API_KEY was available in the environment this fix was written
 * in to measure a live call at the lower "low" effort the retry now
 * requests, so this allowance is sized well above that one medium-effort
 * data point rather than assumed to shrink proportionally — OpenRouter's own
 * docs say Gemini 3 reasoning-token consumption under a thinkingLevel dial
 * is "determined internally by Google", i.e. opaque, not a fixed ratio of
 * max_tokens. A model whose consumption is opaque needs headroom, not a
 * tight guess; re-measure and tighten this once a live key is available.
 */
const MANDATORY_REASONING_TOKEN_ALLOWANCE = 1500;

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
  // actually given — leaving timeoutMs unset must keep meaning "no timeout".
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

  // Only the dispatch itself sits inside the retry try. Success-path logging
  // used to live in here, and a throw from it (a null `content` field on an
  // already-billed response) discarded the paid-for completion and re-sent the
  // whole prompt — the retry loop must never be able to reject work we have.
  let result: LlmCompleteOutput | undefined;
  let attempts = 0;

  for (let attempt = 1; ; attempt++) {
    try {
      result = await dispatch(cfg.llmProvider, cfg.llmModel, key, expanded, timeoutMs);
      attempts = attempt;
      break;
    } catch (err) {
      const status = err instanceof LlmError ? (err.status ?? null) : null;
      const retryAfterMs = err instanceof LlmError ? err.retryAfterMs : undefined;
      // A Retry-After past our budget is a guaranteed-failing retry: honouring
      // it literally would burn the remaining attempts on ~120s+ of dead wait
      // in a sequential caller. Treat it as terminal instead, with a message
      // that names the wait so it reads as a deliberate give-up, not a bug.
      // Only applies when a retry was actually still on the table — a
      // non-retryable status (400/401/404) or an exhausted attempt count was
      // never going to retry regardless of Retry-After, so there is nothing
      // to "give up" on and the original error (status + provider body) must
      // survive unchanged.
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

/**
 * A mandatory-reasoning retry raises `max_tokens` by the reasoning
 * allowance so the caller's own budget still reaches the answer after the
 * model spends part of the larger ceiling on reasoning it cannot switch
 * off. The caller's original budget is NOT preserved anywhere — the raised
 * ceiling (`callerMaxTokens + MANDATORY_REASONING_TOKEN_ALLOWANCE`) fully
 * replaces `input.maxTokens`, so `truncationMessage`'s "raise maxTokens"
 * diagnostic reports the raised ceiling itself (e.g. 2000 for a 500-token
 * caller — see `truncation.test.ts`), not the caller's original request.
 * Kept as a distinct helper (not folded into `dispatch`) so it stays
 * unit-testable against a fake `openaiCompatibleComplete` without a real
 * HTTP layer.
 */
function mandatoryReasoningArgs(args: OpenAIArgs, effort: string): OpenAIArgs {
  const callerMaxTokens = args.input.maxTokens ?? 1024;
  return {
    ...args,
    reasoningEffort: effort,
    input: { ...args.input, maxTokens: callerMaxTokens + MANDATORY_REASONING_TOKEN_ALLOWANCE },
  };
}

/**
 * Climbs `REASONING_EFFORT_LADDER` from the lowest tier up, stopping at the
 * first effort OpenRouter actually accepts for this model. Each rung is one
 * real request — a rejected 400 isn't billed, so this costs nothing beyond
 * latency — and it is what "reads" the model's supported-effort set by
 * trial rather than a second authenticated call to `/api/v1/models` (which
 * would need its own caching and staleness story for a single lookup).
 *
 * `rememberMandatoryReasoningModel` is only called on an actual success —
 * never before the retry's outcome is known — so a model that rejects every
 * rung is never marked mandatory-with-a-working-effort; the caller sees the
 * real terminal error, and the NEXT call re-probes instead of replaying a
 * value nothing ever verified.
 */
async function completeWithLowestSupportedEffort(
  args: OpenAIArgs,
  model: string,
): Promise<LlmCompleteOutput> {
  let lastErr: unknown;
  for (const effort of REASONING_EFFORT_LADDER) {
    try {
      const result = await openaiCompatibleComplete(mandatoryReasoningArgs(args, effort));
      rememberMandatoryReasoningModel(model, effort);
      return result;
    } catch (err) {
      lastErr = err;
      // Anything other than a reasoning-specific 400 (a 429, a 5xx, a
      // timeout, or a 400 caused by something else entirely — e.g. the
      // raised max_tokens allowance itself tripping the model's own hard
      // token ceiling) is not "this effort is unsupported" — it is either
      // weather the outer retry loop in complete() already knows how to
      // classify, or a real error this ladder must surface immediately
      // instead of burning every remaining rung on a guaranteed-failing
      // request. Reuse the same reasoning-body check the outer dispatch used
      // to enter the ladder in the first place.
      if (!isMandatoryReasoningRejection(err)) throw err;
    }
  }
  throw lastErr;
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
      // Models that reason by default (Claude Sonnet 5 / Opus 5, o-series,
      // Gemini thinking) spend their reasoning INSIDE `max_tokens` on
      // OpenRouter, and every caller here sets a small, deliberate budget
      // (200–2000 tokens of JSON). Measured on anthropic/claude-sonnet-5 at
      // max_tokens=500: default → finish_reason=length with 313 reasoning
      // tokens and truncated JSON; reasoning off → a clean 184-token answer
      // at 40% of the cost. OpenRouter's unified `reasoning` parameter maps
      // to each provider's own switch, so this is one line for all of them —
      // except the ~100 models OpenRouter marks `reasoning.mandatory`
      // (gpt-5, the newer Gemini flashes, Fable 5.1), which answer the
      // switch with a 400. For THOSE, `enabled: false` never has a code
      // path that succeeds, so retrying it is pointless: the retry instead
      // climbs REASONING_EFFORT_LADDER to find the lowest effort THIS model
      // actually accepts (never assumed — different mandatory models accept
      // different minimum tiers) and raises max_tokens by a reasoning
      // allowance on top of the caller's own budget (see
      // MANDATORY_REASONING_TOKEN_ALLOWANCE), so the caller's requested
      // answer size still fits after the model spends part of the larger
      // ceiling on reasoning it cannot switch off. Learned once per model
      // per process (each rejected rung costs nothing useful — a 4xx isn't
      // billed) and persisted to disk, together with the effort that
      // actually worked, so later process starts skip the whole climb too.
      const known = mandatoryReasoningModels.get(model);
      if (known !== undefined) {
        return openaiCompatibleComplete(mandatoryReasoningArgs(args, known)).catch(
          (err: unknown) => {
            // The remembered effort itself can go stale (model revision,
            // provider change) and start 400ing — see #586 round-1 finding
            // PRRT_kwDOSKzrBs6gzFE2. Without this branch a stale entry wedges
            // every future call, in this process and every later one, until
            // someone finds and deletes mandatory-reasoning-models.json by
            // hand. Forget it and re-probe the ladder exactly as a model seen
            // for the first time would.
            if (isMandatoryReasoningRejection(err)) {
              forgetMandatoryReasoningModel(model);
              return completeWithLowestSupportedEffort(args, model);
            }
            throw err;
          },
        );
      }
      return openaiCompatibleComplete({ ...args, disableReasoning: true }).catch((err: unknown) => {
        if (isMandatoryReasoningRejection(err)) {
          return completeWithLowestSupportedEffort(args, model);
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
 * OpenRouter models known to reject `reasoning: { enabled: false }`, mapped
 * to the lowest effort tier that DID succeed for that model — see the
 * openrouter dispatch and `completeWithLowestSupportedEffort`. Seeded from
 * disk on first use (`loadMandatoryReasoningModels`) so a fresh process
 * doesn't have to pay for the climb again for a model a PRIOR process
 * already learned about; every addition is persisted back so the mapping
 * survives restarts, not just the current process's lifetime.
 */
const mandatoryReasoningModels = new Map<string, string>(loadMandatoryReasoningModels());

function rememberMandatoryReasoningModel(model: string, effort: string): void {
  if (mandatoryReasoningModels.get(model) === effort) return;
  mandatoryReasoningModels.set(model, effort);
  saveMandatoryReasoningModels(mandatoryReasoningModels);
}

/**
 * Discards a remembered model → effort mapping that has started 400ing —
 * see the `known` branch of the openrouter dispatch (#586 round-1 finding
 * PRRT_kwDOSKzrBs6gzFE2). A no-op if the model was never remembered, so
 * callers don't need to check `has()` first.
 */
function forgetMandatoryReasoningModel(model: string): void {
  if (!mandatoryReasoningModels.delete(model)) return;
  saveMandatoryReasoningModels(mandatoryReasoningModels);
}

/** A 400 whose body talks about reasoning: the model cannot have it switched off. */
function isMandatoryReasoningRejection(err: unknown): boolean {
  return err instanceof LlmError && err.status === 400 && /reasoning/i.test(err.message);
}

function mandatoryReasoningModelsPath(): string {
  return join(configDir(), "mandatory-reasoning-models.json");
}

/**
 * Best-effort disk read for the persisted model → working-effort mapping —
 * any failure (missing file, corrupt JSON, a non-object shape) falls back to
 * empty, exactly as if this were the first time the process had ever seen a
 * mandatory-reasoning model. A read failure here must never crash
 * `complete()` — the first call just re-learns via the normal climb-and-
 * remember path.
 *
 * The pre-correction shape (#586 round 1) persisted a bare array of model
 * names with NO effort recorded, implicitly paired with a single hardcoded
 * `"low"` that 400s on real mandatory models such as `openai/o4-mini-high`.
 * That shape carries no verified effort, so it is discarded here rather than
 * migrated — a model in an old-shape file just re-probes once, the same as
 * a model never seen before.
 */
function loadMandatoryReasoningModels(): Array<[string, string]> {
  try {
    const path = mandatoryReasoningModelsPath();
    if (!existsSync(path)) return [];
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
  } catch {
    return [];
  }
}

/** Best-effort disk write. Failure (read-only fs, etc.) never blocks the in-memory learning. */
function saveMandatoryReasoningModels(models: Map<string, string>): void {
  try {
    const dir = configDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const obj: Record<string, string> = {};
    for (const [model, effort] of [...models.entries()].toSorted(([a], [b]) =>
      a.localeCompare(b),
    )) {
      obj[model] = effort;
    }
    writeFileSync(mandatoryReasoningModelsPath(), JSON.stringify(obj, null, 2));
  } catch {
    // best-effort persistence — the in-memory Map still works for this process.
  }
}

/**
 * One POST under a single abort budget covering the body read too — a provider
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
      // The status is known, so the status decides — a 401 that happens to time
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
      // same "nothing usable" case as a body that never arrives — both provider
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
  /** Send OpenRouter's `reasoning: { enabled: false }` — see the openrouter dispatch. */
  disableReasoning?: boolean;
  /**
   * Send OpenRouter's `reasoning: { effort: ... }` — the reasoning-mandatory
   * retry path, mutually exclusive with `disableReasoning` (a model that
   * rejected `enabled: false` gets an effort dial instead, never both).
   */
  reasoningEffort?: string;
}

async function openaiCompatibleComplete(args: OpenAIArgs): Promise<LlmCompleteOutput> {
  const data = (await postJson({
    url: `${args.baseUrl}/chat/completions`,
    headers: { Authorization: `Bearer ${args.key}`, ...args.extraHeaders },
    body: {
      model: args.model,
      messages: args.input.messages,
      temperature: args.input.temperature ?? 0.7,
      max_tokens: args.input.maxTokens ?? 1024,
      // OpenRouter only — the OpenAI API rejects unknown parameters.
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
      prompt_tokens?: number;
      completion_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };

  // OpenRouter answers upstream faults with 200 and an error envelope instead of
  // choices. Naming it here keeps the failure a terminal LlmError — reaching for
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
    throw new LlmError(
      truncationMessage({
        provider: args.provider,
        model: args.model,
        maxTokens: args.input.maxTokens ?? 1024,
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
    throw new LlmError(
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
