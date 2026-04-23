import { complete } from "./client.ts";
import { loadPrompt } from "./prompts.ts";

export interface SynthesizeOutput {
  jtbd: string[];
  painQuotes: string[];
  switchMoment: string | null;
  icpLanguage: string[];
  raw: string;
}

export async function synthesizeInterviews(combinedTranscripts: string): Promise<SynthesizeOutput> {
  const system = loadPrompt("synthesize");
  const res = await complete({
    messages: [
      { role: "system", content: system },
      { role: "user", content: combinedTranscripts.slice(0, 60000) },
    ],
    temperature: 0.3,
    maxTokens: 2000,
  });

  const fenced = res.content.match(/```(?:json)?\s*([\s\S]*?)```/);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse((fenced ? fenced[1] : res.content) ?? "{}");
  } catch {
    parsed = {};
  }

  return {
    jtbd: asStringArray(parsed["jtbd"]),
    painQuotes: asStringArray(parsed["pain_quotes"]),
    switchMoment:
      typeof parsed["switch_moment"] === "string" ? (parsed["switch_moment"] as string) : null,
    icpLanguage: asStringArray(parsed["icp_language"]),
    raw: res.content,
  };
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}
