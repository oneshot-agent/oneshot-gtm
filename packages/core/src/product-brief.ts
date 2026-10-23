import { getLedger, type Ledger } from "./ledger.ts";
import type { OneShotConfig } from "./types.ts";

/**
 * Heading of the approved code answers in the composed brief. It tells the
 * writer the list is complete: a how-it-works question not in it is one to
 * confirm, not to infer.
 */
export const CODE_ANSWERS_HEADING =
  "HOW IT WORKS (from the product's source; a question not listed here is not covered)";

/** The approved answers as a brief block, or "" when there are none. */
export function codeAnswersBlock(
  answers: ReadonlyArray<{ question: string; answer: string }>,
): string {
  const lines = answers
    .filter((a) => a.question.trim() && a.answer.trim())
    .map((a) => `- ${a.question.trim()}\n  ${a.answer.trim().replace(/\s+/g, " ")}`);
  return lines.length ? `${CODE_ANSWERS_HEADING}\n${lines.join("\n")}` : "";
}

/**
 * The product brief every prompt reads: the founder's `productBrief` plus
 * the code answers they approved. Prompts read this, never
 * `cfg.productBrief` directly, so an approval reaches replies, offers,
 * angles, cadences and the judge alike. Two things keep reading the raw
 * brief: the setup save (it writes only what the founder typed) and the
 * link allow-lists (a link may be cited only when the founder wrote it).
 *
 * Without a brief nothing is added: the answers extend a brief, they do not
 * stand in for one, so every "no brief, no offer" gate behaves as before.
 * `ledger` defaults to the workspace ledger; an unreadable ledger leaves the
 * raw brief (null: no ledger, the raw brief on purpose).
 *
 * `max` is for prompts that cap the brief: the result fits in it, and the
 * founder's brief is what gets cut ("…"), never the answers, which are short
 * and are the one place a how-it-works question is settled.
 */
export function productBriefText(
  cfg: Pick<OneShotConfig, "productBrief">,
  ledger?: Ledger | null,
  opts: { max?: number } = {},
): string | null {
  const brief = cfg.productBrief;
  if (!brief?.trim()) return brief;
  let block = "";
  if (ledger !== null) {
    try {
      block = codeAnswersBlock((ledger ?? getLedger()).codeAnswers.approved());
    } catch {
      block = "";
    }
  }
  const max = opts.max;
  if (max == null) return block ? `${brief.trimEnd()}\n\n${block}` : brief;
  if (!block) return clipText(brief.trim(), max);
  const room = max - block.length - 2;
  if (room < 1) return clipText(block, max);
  return `${clipText(brief.trim(), room)}\n\n${block}`;
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}
