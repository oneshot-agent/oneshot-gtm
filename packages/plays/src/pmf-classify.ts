import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";

export type SequoiaArc = "hair-on-fire" | "hard-fact" | "future-vision";
export type FitStatus = "fit" | "misfit" | "unknown";

export interface PmfClassifyAnswers {
  buyer: string;
  painInTheirWords: string;
  urgency: string;
  workaround: string;
  salesCycle: string;
  firstDollarAmount: string;
}

export interface PmfClassifyResult {
  sequoiaArc: SequoiaArc;
  sequoiaReasoning: string;
  fourFits: {
    market: FitStatus;
    product: FitStatus;
    channel: FitStatus;
    model: FitStatus;
  };
  fourFitsReasoning: string;
  recommendedMotion: string;
  nextActions: string[];
  raw: string;
}

export async function pmfClassify(answers: PmfClassifyAnswers): Promise<PmfClassifyResult> {
  const system = loadPrompt("pmf-classify");
  const user = [
    `1. BUYER: ${answers.buyer}`,
    `2. PAIN (their words): ${answers.painInTheirWords}`,
    `3. URGENCY: ${answers.urgency}`,
    `4. CURRENT WORKAROUND: ${answers.workaround}`,
    `5. SALES CYCLE SO FAR: ${answers.salesCycle}`,
    `6. TYPICAL FIRST DOLLAR AMOUNT: ${answers.firstDollarAmount}`,
  ].join("\n");

  const res = await complete({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.3,
    maxTokens: 900,
  });

  const parsed = tryParseJsonObject<Record<string, unknown>>(res.content, {});

  const fits = (parsed["four_fits"] as Record<string, FitStatus> | undefined) ?? {};
  const actions = parsed["next_actions"];

  return {
    sequoiaArc: (parsed["sequoia_arc"] as SequoiaArc) ?? "future-vision",
    sequoiaReasoning: String(parsed["sequoia_reasoning"] ?? ""),
    fourFits: {
      market: fits.market ?? "unknown",
      product: fits.product ?? "unknown",
      channel: fits.channel ?? "unknown",
      model: fits.model ?? "unknown",
    },
    fourFitsReasoning: String(parsed["four_fits_reasoning"] ?? ""),
    recommendedMotion: String(parsed["recommended_motion"] ?? ""),
    nextActions: Array.isArray(actions)
      ? actions.filter((a): a is string => typeof a === "string")
      : [],
    raw: res.content,
  };
}
