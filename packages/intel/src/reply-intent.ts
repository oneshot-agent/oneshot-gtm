import { loadConfig, logEvent, type InboxEmail, type OneShotConfig } from "@oneshot-gtm/core";
import { REPLY_INTENTS, isReplyIntent, type ReplyIntent } from "@oneshot-gtm/shared-types";
import { callDecisions, topDecisionLabels } from "./decisions.ts";
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
    const res = await callDecisions({
      model,
      key,
      questions: {
        intent: { type: "choice", instructions: INSTRUCTIONS, criteria: replyIntentCriteria() },
      },
      state: stateOf(email),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    const a = res.answers["intent"]!;
    // The criteria are the shared table, so this only narrows the type.
    if (!isReplyIntent(a.choice)) throw new ReplyIntentError(`unknown label ${a.choice}`);
    const intent = a.choice;
    const min = minConfidenceOf(cfg);
    return {
      intent,
      reason: topDecisionLabels(a.probabilities) || intent,
      confidence: a.confidence,
      probabilities: a.probabilities,
      classifier: `decisions:${res.model}`,
      costMicros: res.costUsd == null ? null : Math.round(res.costUsd * 1_000_000),
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
