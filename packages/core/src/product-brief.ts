import { getLedger, type Ledger } from "./ledger.ts";
import type { OneShotConfig } from "./types.ts";
import { sliceText } from "./text-slice.ts";

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
  return text.length > max ? `${sliceText(text, Math.max(0, max - 1))}…` : text;
}

/** Leading words that open a one-liner without naming the product. */
const NOT_A_NAME = new Set(["a", "an", "the", "we", "our", "i", "it", "this", "my"]);
const NAME_TOKEN = /^[A-Z][\w.-]*/;
const MORE_NAME = /^\s[A-Z][\w.-]*/;
/**
 * What follows a name in "<Name> is…", "<Name>: …", "<Name> brings…", "<Name>'s…".
 * The verbs are a list, not "any word ending in s": "Automate workflows for
 * clinics" opens on an instruction. A one-liner none of them fits names no
 * product, and no check runs.
 */
const NAME_FOLLOWER =
  /^(?:['’]s\b|\s*[:,(—–]|\s+-\s|\s+(?:is|are|was|has|can|will|lets|helps|makes|turns|gives|brings|finds|runs|works|keeps|books|sends|takes|gets|handles|automates|connects|tracks|builds|does|puts|answers|follows|writes|reads|checks|carries|clears|recovers|collects|stops|saves|cuts|moves|pays|ships|monitors|manages|schedules|routes|matches|catches|fixes|replaces|sees|shows|tells|turns|wins|chases|calls|emails|executes|delivers|powers|enables|protects|verifies|finishes|closes)\b)/;

/**
 * The product's name as the founder's one-liner opens with it ("OneShot is the
 * execution layer…" → "OneShot"), for checks that a message names what is being
 * offered. Null when the one-liner is unset or does not open with a name.
 */
export function productNameOf(cfg: Pick<OneShotConfig, "productOneLiner">): string | null {
  const text = cfg.productOneLiner?.trim() ?? "";
  const token = NAME_TOKEN.exec(text)?.[0] ?? "";
  // "Acme." ends the token, not the name: a trailing dot or dash is punctuation.
  let name = token;
  while (name && ".-".includes(name[name.length - 1]!)) name = name.slice(0, -1);
  if (!name || NOT_A_NAME.has(name.toLowerCase())) return null;
  // Skip the rest of a multi-word name ("Acme Clinics is…").
  let rest = text.slice(token.length);
  for (let next = MORE_NAME.exec(rest); next; next = MORE_NAME.exec(rest)) {
    rest = rest.slice(next[0].length);
  }
  // A name is what the sentence is about: a verb or a clause mark follows it.
  // "Automate patient follow-ups" opens on an instruction, not a name.
  return NAME_FOLLOWER.test(rest) ? name : null;
}
