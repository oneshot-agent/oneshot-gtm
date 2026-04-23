import { complete } from "./client.ts";
import { loadPrompt } from "./prompts.ts";

const SLOP_PATTERNS = [
  /^I noticed that\b/im,
  /^Given your role\b/im,
  /^I came across\b/im,
  /^Hope this email finds you well\b/im,
  /\bI'd love to learn more\b/i,
];

export interface PersonalizeInput {
  founderName: string;
  founderProductOneLiner: string;
  prospectName: string;
  prospectCompany: string;
  prospectDossier: string;
  triggerContext: string;
}

export interface PersonalizedFirstLine {
  firstLine: string;
  reasoning: string;
  flagged: string[];
}

export async function generateFirstLine(input: PersonalizeInput): Promise<PersonalizedFirstLine> {
  const system = loadPrompt("personalize");
  const user = [
    `FOUNDER: ${input.founderName}`,
    `PRODUCT: ${input.founderProductOneLiner}`,
    `PROSPECT: ${input.prospectName} at ${input.prospectCompany}`,
    `TRIGGER: ${input.triggerContext}`,
    `DOSSIER:\n${input.prospectDossier}`,
    "",
    'Output JSON: { "first_line": string (max 22 words), "reasoning": string (one short sentence) }',
  ].join("\n");

  const res = await complete({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.6,
    maxTokens: 400,
  });

  const parsed = parseJson(res.content);
  const firstLine = String(parsed.first_line ?? "").trim();
  const reasoning = String(parsed.reasoning ?? "").trim();

  const flagged: string[] = [];
  for (const re of SLOP_PATTERNS) {
    if (re.test(firstLine)) flagged.push(re.source);
  }
  if (firstLine.includes("—")) flagged.push("em-dash");
  if ((firstLine.match(/,/g) ?? []).length >= 3) flagged.push("three-item-list");

  return { firstLine, reasoning, flagged };
}

function parseJson(s: string): Record<string, unknown> {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : s;
  try {
    return JSON.parse((candidate ?? "").trim());
  } catch {
    const start = (candidate ?? "").indexOf("{");
    const end = (candidate ?? "").lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse((candidate ?? "").slice(start, end + 1));
      } catch {
        return {};
      }
    }
    return {};
  }
}
