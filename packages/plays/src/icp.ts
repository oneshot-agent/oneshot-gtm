import { getLedger } from "@oneshot-gtm/core";
import { complete, loadPrompt, synthesizeInterviews } from "@oneshot-gtm/intel";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export async function generateInterviewPrep(hypothesis: string): Promise<string> {
  const system = loadPrompt("interview-prep");
  const res = await complete({
    messages: [
      { role: "system", content: system },
      { role: "user", content: `HYPOTHESIS: ${hypothesis}` },
    ],
    temperature: 0.4,
    maxTokens: 2000,
  });
  return res.content;
}

export interface SynthesizeResult {
  jtbd: string[];
  painQuotes: string[];
  switchMoment: string | null;
  icpLanguage: string[];
  filesRead: number;
}

export async function synthesizeFromDir(transcriptDir: string): Promise<SynthesizeResult> {
  if (!existsSync(transcriptDir)) {
    throw new Error(`transcript dir not found: ${transcriptDir}`);
  }
  const stat = statSync(transcriptDir);
  const files: string[] = [];
  if (stat.isFile()) {
    files.push(transcriptDir);
  } else {
    for (const name of readdirSync(transcriptDir)) {
      if (/\.(txt|md|json)$/i.test(name)) files.push(join(transcriptDir, name));
    }
  }

  if (files.length === 0) throw new Error(`no .txt/.md/.json files in ${transcriptDir}`);

  const combined = files.map((f) => `### ${f}\n\n${readFileSync(f, "utf8")}`).join("\n\n---\n\n");

  const out = await synthesizeInterviews(combined);

  const ledger = getLedger();
  for (const f of files) {
    ledger.recordInterview({
      person: f.split("/").pop() ?? f,
      transcript_path: f,
      jtbd: out.jtbd[0] ?? null,
      pain_quotes_json: JSON.stringify(out.painQuotes),
    });
  }

  return { ...out, filesRead: files.length };
}
