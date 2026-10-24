/**
 * The words a held draft shows instead of its raw lint labels (issue #594).
 *
 * `lintEmail` labels are identifiers: `banned-opener:I-noticed`,
 * `rule-of-three`, `hard-ban:discount-offer`: fine in a log, wrong on a card
 * a founder reads before sending. This is the one place they become a
 * sentence: "Held · 2 flags: banned opener, “I noticed”, rule of three".
 *
 * Pure. An unknown label degrades to its words rather than disappearing, so a
 * new linter rule is never hidden by an out-of-date table here.
 */
import { blockingFlags } from "@oneshot-gtm/shared-types";

const NAMED: Record<string, string> = {
  "rule-of-three": "rule of three",
  "em-dash": "em dash",
  "curly-quotes": "curly quotes",
  emoji: "emoji",
  "empty-subject": "empty subject",
  "subject-too-long": "subject too long",
  "subject-shouty": "shouty subject",
  "empty-body": "empty body",
  "body-too-long": "body too long",
  "excess-exclamations": "too many exclamation marks",
  "calendar-link": "scheduling link",
  "public-record-leverage": "leans on a public record",
  "servile-closer": "servile closer",
  "negative-parallelism": "not-X-but-Y construction",
  "ai-vocab": "AI vocabulary",
  "banned-opener:provenance-verb": "banned opener, “I was looking at”",
  "banned-cta:time-slots": "time-slot ask",
  "stale-event": "the event has passed",
  "contacted-elsewhere": "another workspace emailed them this week",
  ungrounded: "research found nothing on them; the draft leans on the company name",
  "email-at-former-employer": "their address is at a company they have left",
  "already-enrolled": "already in a cadence",
  "already-contacted": "already contacted",
  "off-icp": "off ICP",
  "weak-offer": "the offer was rated a weak fit",
  "no-offer": "no offer could be written",
  "thin-body": "too thin to send",
};

export function humanizeFlag(flag: string): string {
  const named = NAMED[flag];
  if (named) return named;
  const colon = flag.indexOf(":");
  const kind = colon === -1 ? flag : flag.slice(0, colon);
  const detail = colon === -1 ? "" : flag.slice(colon + 1).replace(/-/g, " ");
  if (kind === "banned-opener") return detail ? `banned opener, “${detail}”` : "banned opener";
  if (kind === "hard-ban") return detail ? `hard ban: ${detail}` : "hard ban";
  const words = kind.replace(/-/g, " ");
  return detail ? `${words}: ${detail}` : words;
}

/**
 * What clears a flag that regenerating the draft cannot: the offer block's
 * actions (Approve offer, Next offer, Edit offer, New offers).
 */
const OFFER_ADVICE: Record<string, string> = {
  "weak-offer": "approve the offer, pick another or rewrite it",
  "no-offer": "write the offer or ask for new ones",
};

export interface HeldOptions {
  /** The `no-offer` hold is the writer's own refusal: its reason is kept with the offer. */
  offerSkipped?: boolean;
  /**
   * The weak offer still holds the send. False once the founder approved,
   * replaced or rewrote it: the flag then only records why this draft was held.
   */
  offerHeld?: boolean;
  /**
   * What the page lets the founder do about a flag only a read clears:
   * `send` (Send anyway), `approve` (approve the row, then send) or
   * `regenerate` (Send stays off while any flag stands; the default).
   */
  review?: "send" | "approve" | "regenerate";
}

/** What to do about one flag, in words that match the buttons the page has. */
export function flagAdvice(flag: string, opts: HeldOptions = {}): string {
  const offer = Object.hasOwn(OFFER_ADVICE, flag) ? OFFER_ADVICE[flag] : undefined;
  if (offer && (flag !== "weak-offer" || opts.offerHeld !== false)) return offer;
  if (blockingFlags([flag]).length > 0) return "regenerate the draft";
  return opts.review === "send"
    ? "read it once more, then send anyway"
    : opts.review === "approve"
      ? "approve to send"
      : "regenerate the draft";
}

export interface HeldSummary {
  /** `lint` blocks sending; `review` is the founder-overridable soft hold. */
  kind: "lint" | "review";
  /** "1 flag: rule of three" / "2 flags: …" */
  text: string;
  /** What to do about it, in the card's voice: each distinct fix once. */
  next: string;
}

/** The flags named, then what to do about them, the offer's fix first. */
export function heldSummary(flags: string[], opts: HeldOptions = {}): HeldSummary | null {
  if (flags.length === 0) return null;
  const kind = blockingFlags(flags).length > 0 ? "lint" : "review";
  const label = (f: string): string =>
    opts.offerSkipped === true && f === "no-offer"
      ? "the writer found no offer to make"
      : humanizeFlag(f);
  const text = `${flags.length} flag${flags.length === 1 ? "" : "s"}: ${flags.map(label).join(", ")}`;
  // A new offer redrafts the letter, so its fix comes before a regenerate.
  const ordered = flags.toSorted(
    (a, b) => Number(Object.hasOwn(OFFER_ADVICE, b)) - Number(Object.hasOwn(OFFER_ADVICE, a)),
  );
  const next = [...new Set(ordered.map((f) => flagAdvice(f, opts)))].join("; ");
  return { kind, text, next };
}
