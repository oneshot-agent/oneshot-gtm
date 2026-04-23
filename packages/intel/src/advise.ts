import { getLedger, loadConfig } from "@oneshot-gtm/core";
import { complete, type LlmMessage } from "./client.ts";
import { loadPrompt } from "./prompts.ts";

export interface AdviseInput {
  question: string;
  /** Prior turns; pass back the array returned by adviseOnce to maintain context. */
  history?: LlmMessage[];
  /** When true, prepend a fresh ledger context block; otherwise rely on history. */
  refreshContext?: boolean;
}

export interface AdviseOutput {
  answer: string;
  citedPrinciples: string[];
  /** Updated history including this turn's user + assistant messages. */
  history: LlmMessage[];
}

export async function adviseOnce(input: AdviseInput): Promise<AdviseOutput> {
  const cfg = loadConfig();
  const system = loadPrompt("advise");
  const history = input.history ?? [];
  const isFirstTurn = history.length === 0;
  const refresh = input.refreshContext ?? isFirstTurn;

  const userTurn = refresh
    ? `${ledgerContextBlock(cfg)}\n\nQUESTION: ${input.question}`
    : input.question;

  const messages: LlmMessage[] = [
    { role: "system", content: system },
    ...history,
    { role: "user", content: userTurn },
  ];

  const res = await complete({
    messages,
    temperature: 0.5,
    maxTokens: 1200,
  });

  const cited = extractCitedPrinciples(res.content);
  const newHistory: LlmMessage[] = [
    ...history,
    { role: "user", content: userTurn },
    { role: "assistant", content: res.content },
  ];
  return { answer: res.content, citedPrinciples: cited, history: trimHistory(newHistory) };
}

function ledgerContextBlock(cfg: ReturnType<typeof loadConfig>): string {
  const ledger = getLedger();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const recentReceipts = ledger.listReceipts({ sinceIso: sevenDaysAgo, limit: 100 });
  const totalSpend = ledger.totalSpendUsd({ sinceIso: sevenDaysAgo });
  const sendsTotal = ledger.countSends();
  return [
    `FOUNDER: ${cfg.founderName ?? "(unknown)"}`,
    `PRODUCT: ${cfg.productOneLiner ?? "(not set)"}`,
    "",
    "LAST 7 DAYS:",
    `- Total spend (signed receipts): $${totalSpend.toFixed(2)}`,
    `- OneShot calls: ${recentReceipts.length}`,
    `- Hand-tracked sends (lifetime): ${sendsTotal}`,
    `- Receipts by play: ${summarizeByPlay(recentReceipts)}`,
  ].join("\n");
}

const MAX_HISTORY_TURNS = 12;
function trimHistory(history: LlmMessage[]): LlmMessage[] {
  // Keep the last MAX_HISTORY_TURNS user+assistant messages.
  if (history.length <= MAX_HISTORY_TURNS) return history;
  return history.slice(-MAX_HISTORY_TURNS);
}

function summarizeByPlay(receipts: { play_name: string }[]): string {
  const counts = new Map<string, number>();
  for (const r of receipts) counts.set(r.play_name, (counts.get(r.play_name) ?? 0) + 1);
  if (counts.size === 0) return "(none)";
  return [...counts.entries()].map(([k, v]) => `${k}=${v}`).join(", ");
}

function extractCitedPrinciples(text: string): string[] {
  const re = /\[([A-Z][^\]]{2,40})\]/g;
  const found = new Set<string>();
  for (const m of text.matchAll(re)) found.add(m[1] as string);
  return [...found];
}
