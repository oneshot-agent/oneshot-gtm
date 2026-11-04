import {
  autoReplyText,
  classifyAutoReplyFast,
  isAutoReplyReason,
  llmApiKey,
  loadConfig,
  logEvent,
  resolveReturnDate,
  successorFromModel,
  type AutoReplyFacts,
  type AutoReplyInput,
  type OneShotConfig,
} from "@oneshot-gtm/core";
import { complete, type LlmCompleteInput, type LlmCompleteOutput } from "./client.ts";
import { tryParseJsonObject } from "./_parse.ts";
import { loadPrompt } from "./prompts.ts";

export interface AutoReplyClassification extends AutoReplyFacts {
  /** `rules`, or `llm:<model>` when the model added something. */
  classifier: string;
}

const DAY_MS = 86_400_000;

/** A model date counts only when it falls within a year of the reply. */
function modelDate(raw: unknown, receivedAt: string): string | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const at = Date.parse(`${raw}T00:00:00.000Z`);
  const received = Date.parse(receivedAt);
  if (!Number.isFinite(at) || !Number.isFinite(received)) return null;
  if (new Date(at).toISOString().slice(0, 10) !== raw) return null;
  return Math.abs(at - received) <= 366 * DAY_MS ? raw : null;
}

/**
 * What an automatic reply says: why the person is not answering (left, away,
 * other), the first day back, and who to contact instead. The rules in core
 * settle the clear cases; anything they leave open goes to one structured
 * extraction on the workspace's configured model. Without an LLM key, or on
 * any model failure, the rules' answer stands (an unclear reason reads as
 * `other`, which changes nothing).
 *
 * A model answer is checked against the reply: a successor's address and
 * name must appear in it, and a date must fall within a year of it.
 */
export async function classifyAutoReply(
  input: AutoReplyInput,
  opts: {
    cfg?: OneShotConfig;
    completeImpl?: (input: LlmCompleteInput) => Promise<LlmCompleteOutput>;
  } = {},
): Promise<AutoReplyClassification> {
  const fast = classifyAutoReplyFast(input);
  const ruled: AutoReplyClassification = {
    reason: fast.reason,
    returnDate: fast.returnDate,
    successor: fast.successor,
    classifier: "rules",
  };
  if (!fast.needsModel) return ruled;
  const cfg = opts.cfg ?? loadConfig();
  if (!opts.completeImpl && !llmApiKey(cfg.llmProvider)) return ruled;

  const text = autoReplyText(input.subject, input.body);
  const exclude = input.fromEmail ? [input.fromEmail] : [];
  try {
    const res = await (opts.completeImpl ?? complete)({
      messages: [
        { role: "system", content: loadPrompt("auto-reply-extract") },
        {
          role: "user",
          content: `Received: ${input.receivedAt.slice(0, 10)}\nFrom: ${input.fromEmail ?? ""}\nSubject: ${input.subject ?? ""}\n\n${text.slice((input.subject ?? "").length + 1)}`,
        },
      ],
      temperature: 0,
      maxTokens: 300,
      timeoutMs: 30_000,
      maxAttempts: 2,
    });
    const parsed = tryParseJsonObject<Record<string, unknown>>(res.content, {});
    const modelReason = isAutoReplyReason(parsed["reason"]) ? parsed["reason"] : null;
    // A clear rule verdict stands; the model fills in what the rules left open.
    const reason = fast.reason !== "other" ? fast.reason : (modelReason ?? "other");
    const returnDate =
      reason !== "out_of_office"
        ? null
        : (fast.returnDate ??
          modelDate(parsed["return_date"], input.receivedAt) ??
          (typeof parsed["return_date"] === "string"
            ? resolveReturnDate(`until ${parsed["return_date"]}`, input.receivedAt)
            : null));
    const rawSuccessor = parsed["successor"];
    const modelSuccessor =
      rawSuccessor && typeof rawSuccessor === "object"
        ? successorFromModel(text, rawSuccessor as { name?: unknown; email?: unknown }, exclude)
        : null;
    const successor =
      reason !== "left_company"
        ? null
        : fast.successor?.email
          ? fast.successor
          : (modelSuccessor ?? fast.successor);
    return { reason, returnDate, successor, classifier: `llm:${res.model || cfg.llmModel}` };
  } catch (err) {
    logEvent(
      "reply.auto.extract_failed",
      { message_120: ((err as Error)?.message ?? "").slice(0, 120) },
      "warn",
    );
    return ruled;
  }
}
