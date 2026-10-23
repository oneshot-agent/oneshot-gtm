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
 * raw brief.
 */
export function productBriefText(
  cfg: Pick<OneShotConfig, "productBrief">,
  ledger?: Ledger | null,
): string | null {
  const brief = cfg.productBrief;
  if (!brief?.trim() || ledger === null) return brief;
  let block = "";
  try {
    block = codeAnswersBlock((ledger ?? getLedger()).codeAnswers.approved());
  } catch {
    return brief;
  }
  return block ? `${brief.trimEnd()}\n\n${block}` : brief;
}
