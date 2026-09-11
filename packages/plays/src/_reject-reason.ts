/**
 * `rejectReason` — the one sentence the reject box opens with when the row
 * has nothing better to offer.
 *
 * The box prefills from the person gate's verdict reason or the finder's
 * note first (that ladder lives in the web app, it is free). This is the
 * fallback for the rows that reach a human with neither — most approved
 * rows, where the gate said *pass* and nothing on the row says why one
 * would say no. One small isolated call, the mirror image of
 * `generateFitReason`: same evidence block, same shape rules, same cap,
 * same "never throws" contract. The model may answer null when nothing in
 * the block argues against fit, and that null is respected — an invented
 * mismatch in a human's mouth is worse than an empty box.
 */
import { loadConfig, logEvent } from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import { describeTargetForAngle } from "./_angles.ts";
import { normalizeFitReason } from "./_fit-reason.ts";

/** Same order of magnitude as `FIT_REASON_COST_ESTIMATE_USD`: one small completion. */
export const REJECT_REASON_COST_ESTIMATE_USD = 0.001;

export interface GenerateRejectReasonInput {
  /** The founder's ICP one-liner; null/blank → no call, null result. */
  icp?: string | null;
  playName: string;
  payload: unknown;
  /** The dossier `prepare` (or research) assembled, when there is one. */
  dossier?: string | null;
}

/**
 * The ICP, the play, the prospect's own evidence → a sentence, or null when
 * the model finds no mismatch or the call fails. No ICP configured → null
 * without a call: there is nothing to judge against.
 */
export async function generateRejectReason(
  input: GenerateRejectReasonInput,
): Promise<string | null> {
  const icp = input.icp?.trim() ?? loadConfig().icpOneLiner?.trim() ?? "";
  if (!icp) return null;
  const evidence = describeTargetForAngle(
    (input.payload && typeof input.payload === "object" ? input.payload : {}) as object,
    input.dossier ?? null,
  );
  try {
    const system = loadPrompt("reject-reason");
    const user = [
      `ICP: ${icp}`,
      `PLAY: ${input.playName}`,
      "PROSPECT:",
      evidence.trim() || "(nothing known beyond name and email)",
    ].join("\n");
    const res = await complete({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.1,
      maxTokens: 120,
    });
    const parsed = tryParseJsonObject<{ rejectReason?: unknown }>(res.content, {});
    const reason = normalizeFitReason(parsed.rejectReason);
    // The prefix is the machine-decision marker downstream; a model that
    // ignored the prompt must not be able to mint one through a human.
    if (!reason || /^auto:/i.test(reason)) return null;
    logEvent("reject_reason.generated", { play: input.playName, reason_120: reason.slice(0, 120) });
    return reason;
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "reject-reason",
        play: input.playName,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return null;
  }
}
