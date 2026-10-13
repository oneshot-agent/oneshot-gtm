/**
 * The words the reply composer shows instead of the reply linter's labels.
 *
 * `lintReplyOptions` emits identifiers: `link-not-in-brief`, `same-move`,
 * `near-duplicate:technical+warm`. They are fine in a test and wrong under a
 * textarea a founder is about to send from. This is the one place they become
 * sentences, in the same spirit as `flagLabels.ts` for held queue drafts. An
 * unknown label degrades to its words rather than disappearing.
 *
 * Pure.
 */
import type { ReplyVariant } from "@oneshot-gtm/shared-types";
import { humanizeFlag } from "./flagLabels.ts";

const OPTION: Record<ReplyVariant, string> = {
  direct: "Direct",
  technical: "Technical",
  warm: "Warm",
};

/** What a flag on one option says about that option's text. */
const DRAFT: Record<string, string> = {
  "link-not-in-brief": "links to a page that is not in your product brief",
  "too-many-links": "has more than one link",
  "echoes-them": "repeats their own words back to them",
  "repeats-you": "repeats something you already sent them",
  "commits-terms": "commits to pricing or terms",
  "calendar-link": "includes a scheduling link",
  "body-too-long": "runs long for a reply",
  "empty-body": "is empty",
  "ai-vocab": "uses AI vocabulary",
  "em-dash": "uses an em dash",
  "rule-of-three": "lists things in threes",
  "excess-exclamations": "has too many exclamation marks",
  "servile-closer": "ends on a servile closer",
  "negative-parallelism": "uses a not-X-but-Y construction",
};

export function describeReplyFlag(flag: string): string {
  return DRAFT[flag] ?? humanizeFlag(flag);
}

/**
 * One sentence for the flags on the option in the editor, or null when clean:
 * "Check before sending: it links to a page that is not in your product brief."
 */
export function replyDraftNote(flags: string[]): string | null {
  if (flags.length === 0) return null;
  const parts = flags.map(describeReplyFlag);
  const joined =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")}, and it ${parts[parts.length - 1]}`;
  return `Check before sending: it ${joined}.`;
}

function describeSetFlag(flag: string): string {
  if (flag === "same-move") return "the three options take the same approach";
  if (flag.startsWith("near-duplicate:")) {
    const [a, b] = flag.slice("near-duplicate:".length).split("+") as ReplyVariant[];
    const left = OPTION[a!] ?? a;
    const right = OPTION[b!] ?? b;
    return `${left} and ${right} say nearly the same thing`;
  }
  return humanizeFlag(flag);
}

/**
 * One sentence for the flags on the set of options, or null when clean:
 * "The options overlap: Technical and Warm say nearly the same thing.
 * Regenerate for three distinct options."
 */
export function replySetNote(flags: string[]): string | null {
  if (flags.length === 0) return null;
  const parts = flags.map(describeSetFlag);
  const joined =
    parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
  return `The options overlap: ${joined}. Regenerate for three distinct options.`;
}

/** The stance an option takes, in the founder's words rather than the prompt's menu key. */
const MOVE: Record<string, string> = {
  answer: "Answers their point",
  concede: "Grants what they got right",
  reframe: "Says what it is and is not for them",
  ask: "Asks one question back",
  peer: "Talks about what they built",
  park: "Accepts the not-now",
  check: "Answers, and says what it would confirm",
};

export function describeReplyMove(move: string | undefined): string | null {
  if (!move) return null;
  return MOVE[move] ?? move;
}
