import { getLedger } from "@oneshot-gtm/core";
import { complete, type LlmCompleteInput, type LlmCompleteOutput } from "./client.ts";

/** Shared opt-in BYO LLM accounting. Missing provider costs are explicit estimates.
 * Single attempts leave retry decisions and spending with the caller. */
export async function completeWithReceipt(
  input: LlmCompleteInput,
  context: {
    playName: string;
    memo: string;
    estimatedCostUsd: number;
  },
) {
  if (!Number.isFinite(context.estimatedCostUsd) || context.estimatedCostUsd < 0)
    throw new Error("Invalid LLM cost estimate");
  let attempted = false;
  const record = (out?: LlmCompleteOutput) =>
    getLedger().recordReceipt({
      playName: context.playName,
      callType: "llm.complete",
      costUsd: out?.costUsd ?? context.estimatedCostUsd,
      memo: context.memo,
      decisionContext: {
        costBasis: out?.costUsd == null ? "estimate" : "provider",
        estimatedCostUsd: context.estimatedCostUsd,
        provider: out?.provider,
        model: out?.model,
        inputTokens: out?.inputTokens,
        outputTokens: out?.outputTokens,
        outcome: out ? "completed" : "failed-cost-uncertain",
      },
    });
  let out: LlmCompleteOutput;
  try {
    out = await complete({
      ...input,
      maxAttempts: 1,
      onAttempt: () => {
        attempted = true;
        input.onAttempt?.();
      },
    });
  } catch (err) {
    if (attempted) record();
    throw err;
  }
  return { ...out, receiptId: record(out) };
}
