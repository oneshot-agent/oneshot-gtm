/**
 * `fitReason` — the one sentence on a queue row that says why this prospect
 * fits the founder's ICP (issue #592).
 *
 * Until this, the only human-readable rationale a row carried was `notes`, a
 * free-text string each finder formatted differently, and the only place the
 * company-level `icpFilter` reason ever landed. Some finders wrote no reason at
 * all. The row's line is now `${queueEvidence} — ${fitReason}`, with
 * `fitReason` a payload field every finder stamps the same way (see
 * `packages/find/src/_fit-reason.ts` for the enqueue-time ladder).
 *
 * This module holds the pieces that need an LLM or are shared by plays, find
 * and the CLI: normalization, and the generator used where no gate produced a
 * reason (gov notices, amplifiers, manual adds, the backfill). Plays is the
 * right home — find already depends on plays (`drain.ts`), and
 * `describeTargetForAngle` is here.
 */
import { loadConfig, logEvent } from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import type { FitReasonSource } from "@oneshot-gtm/shared-types";
import { describeTargetForAngle } from "./_angles.ts";

export type { FitReasonSource };

/** Same order of magnitude as `ICP_FILTER_COST_ESTIMATE_USD`: one small completion. */
export const FIT_REASON_COST_ESTIMATE_USD = 0.001;
/** A fit sentence is ≤25 words; anything past this is not one. */
export const FIT_REASON_MAX_CHARS = 240;

/**
 * What the gates say when they did NOT judge anything — pass-throughs and
 * deferrals from `_filter.ts` / `_qualify.ts`. A row must never show one as
 * its reason. `unclear-after-enrich: <sentence>` wraps a real sentence and
 * is unwrapped instead.
 */
const NOT_A_REASON = new Set([
  "no icp set; pass-through",
  "no role text available",
  "no role text at discovery; deferred to enrichment",
  "classifier unavailable pre-spend; deferred",
  "no role text in any tier",
]);

/**
 * Trim, collapse whitespace, strip wrapping quotes, drop the gates' canned
 * non-reasons, cap length. Null for blank or non-string input — the caller's
 * "nothing to stamp" signal.
 */
export function normalizeFitReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.replace(/\s+/g, " ").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^unclear-after-enrich:\s*/i, "");
  if (s.length === 0 || NOT_A_REASON.has(s.toLowerCase())) return null;
  return s.length > FIT_REASON_MAX_CHARS ? `${s.slice(0, FIT_REASON_MAX_CHARS - 1).trimEnd()}…` : s;
}

export interface GenerateFitReasonInput {
  /** The founder's ICP one-liner; null/blank → no call, null result. */
  icp: string | null | undefined;
  playName: string;
  payload: unknown;
  /** The dossier `prepare` (or research) assembled, when there is one. */
  dossier?: string | null;
}

/**
 * One small isolated call: the ICP, the play, the prospect's own evidence → a
 * sentence. Never throws — a provider failure or unusable answer logs
 * `error.swallowed` and returns null, so an enqueue or a backfill row is never
 * blocked by a missing rationale. No ICP configured → null without a call:
 * there is nothing to judge fit against, and the UI's half-line contract
 * handles absence.
 */
export async function generateFitReason(input: GenerateFitReasonInput): Promise<string | null> {
  const icp = input.icp?.trim() ?? loadConfig().icpOneLiner?.trim() ?? "";
  if (!icp) return null;
  const evidence = describeTargetForAngle(
    (input.payload && typeof input.payload === "object" ? input.payload : {}) as object,
    input.dossier ?? null,
  );
  try {
    const system = loadPrompt("fit-reason");
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
    const parsed = tryParseJsonObject<{ fitReason?: unknown }>(res.content, {});
    const reason = normalizeFitReason(parsed.fitReason);
    if (reason) {
      logEvent("fit_reason.generated", { play: input.playName, reason_120: reason.slice(0, 120) });
    }
    return reason;
  } catch (err) {
    logEvent(
      "error.swallowed",
      {
        kind: "fit-reason",
        play: input.playName,
        message_120: ((err as Error).message ?? "").slice(0, 120),
      },
      "warn",
    );
    return null;
  }
}
