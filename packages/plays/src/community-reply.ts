import {
  communityThread,
  tryReserveDailySpend,
  isRunCancelled,
  loadConfig,
  throwIfCancelled,
  type CommunityThread,
} from "@oneshot-gtm/core";
import { completeWithReceipt, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import { errorDraft } from "./_lib.ts";
import type { DraftedRow, PlayRunInput } from "./registry.ts";

export type CommunityReplyTarget = CommunityThread;

/** Every entry point, including dryRun:false, only drafts. No transport or cadence. */
export async function runCommunityReply(opts: PlayRunInput): Promise<{ drafted: DraftedRow[] }> {
  const cfg = loadConfig();
  if (!cfg.founderName?.trim() || !cfg.productOneLiner?.trim() || !cfg.productBrief?.trim())
    throw new Error(
      "Add your founder name, product description and verified product brief in Setup before drafting.",
    );
  const drafted: DraftedRow[] = [];
  for (const [index, raw] of opts.targets.entries()) {
    let draft: DraftedRow;
    const reservation = opts.spendReserved ? null : tryReserveDailySpend(0.05);
    try {
      if (reservation && !reservation.granted) throw new Error(reservation.reason);
      throwIfCancelled(opts.signal, "community reply");
      const thread = communityThread(raw);
      if (!thread) throw new Error("Thread URL, author, date and supporting text are required");
      const response = await completeWithReceipt(
        {
          messages: [
            { role: "system", content: loadPrompt("community-reply") },
            {
              role: "user",
              content: JSON.stringify({
                thread,
                founder: cfg.founderName,
                product: cfg.productOneLiner,
                productBrief: cfg.productBrief,
                voice: cfg.founderVoice ?? null,
              }),
            },
          ],
          temperature: 0.3,
          maxTokens: 1800,
          timeoutMs: 45000,
        },
        {
          playName: "community-reply",
          memo: `Draft public reply: ${thread.postUrl}`,
          estimatedCostUsd: 0.05,
        },
      );
      throwIfCancelled(opts.signal, "community reply");
      const p = tryParseJsonObject<{ body?: unknown; facts?: unknown }>(response.content, {});
      if (
        typeof p.body !== "string" ||
        !p.body.trim() ||
        !Array.isArray(p.facts) ||
        p.facts.length === 0 ||
        !p.facts.every((f) => typeof f === "string" && f.trim() && cfg.productBrief!.includes(f))
      )
        throw new Error("Reply must cite supporting facts from your product brief");
      const links = p.body.match(/https?:\/\/[^\s)\]>]+/g) ?? [];
      if (links.some((link) => !cfg.productBrief!.includes(link)))
        throw new Error("Reply contains a link absent from your product brief");
      // Affiliation is deterministic, never left to model compliance.
      const body = `${cfg.founderName} here — I’m the founder of ${cfg.productOneLiner}.\n\n${p.body.trim()}`;
      draft = {
        subject: `Public reply: ${thread.postTitle}`,
        body,
        flags: [],
        sent: false,
        receiptIds: [response.receiptId],
      };
    } catch (err) {
      if (isRunCancelled(err)) {
        if (reservation?.granted) reservation.release();
        throw err;
      }
      draft = errorDraft((err as Error).message);
    }
    if (reservation?.granted) reservation.release();
    drafted.push(draft);
    opts.onProgress?.(index, draft);
  }
  return { drafted };
}
