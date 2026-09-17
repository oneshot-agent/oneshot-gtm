import { signatureDirective } from "./_lib.ts";
import { complete, tryParseJsonObject, type LlmMessage } from "@oneshot-gtm/intel";
import { tryReserveDailySpend } from "@oneshot-gtm/core";
import {
  buildDraftSystemPrompt,
  buildDraftUserPrompt,
  flagCount,
  flagPenalty,
  lintLinkedInDrafts,
  parseDraftResponse,
  repairInstruction,
  VARIANTS,
  type DraftInput,
} from "./reply-options-rules.ts";
import { IMPROVE_INSTRUCTIONS } from "./reply-improve-prompt.ts";

export type { DraftInput as ReplyOptionsContext } from "./reply-options-rules.ts";
export { lintLinkedInDrafts as lintReplyOptions } from "./reply-options-rules.ts";

export async function generateReplyOptions(input: DraftInput) {
  const reservation = tryReserveDailySpend(2);
  if (!reservation.granted) throw new Error(reservation.reason);
  try {
    const messages: LlmMessage[] = [
      {
        role: "system",
        content:
          buildDraftSystemPrompt(input.channel) +
          (input.channel === "email" ? signatureDirective() : ""),
      },
      { role: "user", content: buildDraftUserPrompt(input) },
    ];
    const first = await complete({
      messages,
      temperature: 0.75,
      maxTokens: 2000,
      timeoutMs: 90_000,
    });
    let parsed = parseDraftResponse(first.content);
    if (!VARIANTS.every((v) => parsed.drafts[v]))
      throw new Error("The model did not return all three reply options. Try Generate again.");
    let flags = lintLinkedInDrafts(parsed.drafts, parsed.moves, input);
    if (flagCount(flags)) {
      try {
        const retry = await complete({
          messages: [
            ...messages,
            { role: "assistant", content: first.content },
            { role: "user", content: repairInstruction(flags, parsed.moves) },
          ],
          temperature: 0.5,
          maxTokens: 2000,
          timeoutMs: 90_000,
        });
        const candidate = parseDraftResponse(retry.content);
        const candidateFlags = lintLinkedInDrafts(candidate.drafts, candidate.moves, input);
        if (
          VARIANTS.every((v) => candidate.drafts[v]) &&
          flagPenalty(candidateFlags) < flagPenalty(flags)
        ) {
          parsed = candidate;
          flags = candidateFlags;
        }
      } catch {
        /* Keep the first complete set and show its review flags. */
      }
    }
    return { ...parsed, flags };
  } finally {
    reservation.release();
  }
}

export async function improveReplyOption(
  input: DraftInput,
  text: string,
  original: string,
  feedback: string,
) {
  const reservation = tryReserveDailySpend(1);
  if (!reservation.granted) throw new Error(reservation.reason);
  try {
    const response = await complete({
      messages: [
        { role: "system", content: IMPROVE_INSTRUCTIONS },
        {
          role: "user",
          content: JSON.stringify({
            currentDraft: text,
            originalSuggestion: original,
            editingFeedback: feedback,
            conversationContext: input,
          }),
        },
      ],
      temperature: 0.3,
      maxTokens: 2000,
      timeoutMs: 90_000,
    });
    const parsed = tryParseJsonObject<{ text?: unknown }>(response.content, {});
    if (typeof parsed.text !== "string" || !parsed.text.trim() || parsed.text.length > 20000)
      throw new Error("The model returned no usable improvement. Your text is unchanged.");
    return parsed.text.trim();
  } finally {
    reservation.release();
  }
}
