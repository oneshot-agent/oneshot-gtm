import { getLedger, loadConfig } from "@oneshot-gtm/core";
import { complete } from "./client.ts";
import { loadPrompt } from "./prompts.ts";

export interface WeeklyReviewOutput {
  markdown: string;
  totalSpend: number;
  totalCalls: number;
  totalSent: number;
  totalReplied: number;
}

export async function weeklyReview(extraContext?: string): Promise<WeeklyReviewOutput> {
  const cfg = loadConfig();
  const ledger = getLedger();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  const spend = ledger.spendByPlay({ sinceIso: sevenDaysAgo });
  const events = ledger.eventsByPlay({ sinceIso: sevenDaysAgo });
  const eventsByName = new Map(events.map((e) => [e.play_name, e]));

  let totalSpend = 0;
  let totalCalls = 0;
  let totalSent = 0;
  let totalReplied = 0;
  for (const s of spend) {
    totalSpend += s.total_usd;
    totalCalls += s.calls;
    const ev = eventsByName.get(s.play_name);
    totalSent += ev?.sent ?? 0;
    totalReplied += ev?.replied ?? 0;
  }

  const today = new Date();
  const dateLabel = today.toISOString().slice(0, 10);

  const perPlayLines = spend.map((s) => {
    const ev = eventsByName.get(s.play_name);
    return `- ${s.play_name}: ${s.calls} calls, $${s.total_usd.toFixed(2)} spent, ${ev?.sent ?? 0} sent, ${ev?.replied ?? 0} replied`;
  });

  const system = loadPrompt("weekly-review");
  const userBlock = [
    `FOUNDER: ${cfg.founderName ?? "(unknown)"}`,
    `PRODUCT: ${cfg.productOneLiner ?? "(not set)"}`,
    `WEEK OF: ${dateLabel}`,
    "",
    "AGGREGATES:",
    `- Total spend: $${totalSpend.toFixed(2)}`,
    `- Total agent calls: ${totalCalls}`,
    `- Total sends: ${totalSent}`,
    `- Total replies: ${totalReplied}`,
    `- Reply rate: ${totalSent > 0 ? ((totalReplied / totalSent) * 100).toFixed(1) + "%" : "n/a"}`,
    "",
    "PER-PLAY BREAKDOWN:",
    ...(perPlayLines.length > 0 ? perPlayLines : ["(no plays ran this week)"]),
  ];

  if (extraContext && extraContext.trim().length > 0) {
    userBlock.push("", "FOUNDER CONTEXT:", extraContext.trim());
  }

  const res = await complete({
    messages: [
      { role: "system", content: system },
      { role: "user", content: userBlock.join("\n") },
    ],
    temperature: 0.5,
    maxTokens: 700,
  });

  return {
    markdown: res.content.trim(),
    totalSpend,
    totalCalls,
    totalSent,
    totalReplied,
  };
}
