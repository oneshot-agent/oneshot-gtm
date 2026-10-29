import type { SetupRequest } from "@oneshot-gtm/shared-types";
import type { SetupCfg } from "../components/setup/types.ts";

/** The Offers section's draft, flattened to primitives (numbers as text). */
export type OfferSectionValues = {
  rounds: string;
  fallbackModel: string;
  fallbackOnWeak: boolean;
  minConfidence: string;
};

export const DEFAULT_OFFER_ROUNDS = 3;
export const DEFAULT_OFFER_PASS_LINE = 0.5;
const MAX_MODEL_LENGTH = 200;

type OfferCfg = Pick<SetupCfg, "offerWriter" | "offerJudge">;

/** The pass line is only edited here when the decisions check is on. */
export function hasPassLine(cfg: OfferCfg): boolean {
  return cfg.offerJudge?.engine === "decisions";
}

export function offerSectionValues(cfg: OfferCfg): OfferSectionValues {
  return {
    rounds: String(cfg.offerWriter?.rounds ?? DEFAULT_OFFER_ROUNDS),
    fallbackModel: cfg.offerWriter?.fallbackModel ?? "",
    fallbackOnWeak: cfg.offerWriter?.fallbackOnWeak ?? false,
    minConfidence: String(cfg.offerJudge?.minConfidence ?? DEFAULT_OFFER_PASS_LINE),
  };
}

/**
 * Both settings are whole objects on the server, so each goes out whole when
 * any of its fields changed, read from the latest values. The fallback switch
 * is forced off without a model, and the judge keeps its engine and model.
 */
export function offerSectionRequest(
  values: OfferSectionValues,
  sent: Partial<OfferSectionValues>,
  cfg: OfferCfg,
): SetupRequest {
  const out: SetupRequest = {};
  if (
    sent.rounds !== undefined ||
    sent.fallbackModel !== undefined ||
    sent.fallbackOnWeak !== undefined
  ) {
    const model = values.fallbackModel.trim();
    out.offerWriter = {
      rounds: Number(values.rounds),
      ...(model ? { fallbackModel: model } : {}),
      fallbackOnWeak: model ? values.fallbackOnWeak : false,
    };
  }
  const judge = cfg.offerJudge;
  if (sent.minConfidence !== undefined && judge && hasPassLine(cfg)) {
    out.offerJudge = {
      engine: judge.engine,
      ...(judge.model !== undefined ? { model: judge.model } : {}),
      minConfidence: Number(values.minConfidence),
    };
  }
  return out;
}

export function offerSectionErrors(
  values: OfferSectionValues,
): Partial<Record<keyof OfferSectionValues, string | null>> {
  const rounds = values.rounds.trim();
  const n = Number(values.minConfidence);
  return {
    rounds: /^[0-5]$/.test(rounds) ? null : "A whole number from 0 to 5.",
    fallbackModel:
      values.fallbackModel.trim().length > MAX_MODEL_LENGTH
        ? `At most ${MAX_MODEL_LENGTH} characters.`
        : null,
    minConfidence:
      values.minConfidence.trim() === "" || !Number.isFinite(n) || n < 0 || n > 1
        ? "A number from 0 to 1."
        : null,
  };
}
