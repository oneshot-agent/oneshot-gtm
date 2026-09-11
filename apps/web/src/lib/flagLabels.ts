/**
 * The words a held draft shows instead of its raw lint labels (issue #594).
 *
 * `lintEmail` labels are identifiers — `banned-opener:I-noticed`,
 * `rule-of-three`, `hard-ban:discount-offer` — fine in a log, wrong on a card
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
  "already-enrolled": "already in a cadence",
  "already-contacted": "already contacted",
  "off-icp": "off ICP",
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

export interface HeldSummary {
  /** `lint` blocks sending; `review` is the founder-overridable soft hold. */
  kind: "lint" | "review";
  /** "1 flag: rule of three" / "2 flags: …" */
  text: string;
  /** What to do about it, in the card's voice. */
  next: string;
}

export function heldSummary(flags: string[]): HeldSummary | null {
  if (flags.length === 0) return null;
  const kind = blockingFlags(flags).length > 0 ? "lint" : "review";
  const text = `${flags.length} flag${flags.length === 1 ? "" : "s"}: ${flags.map(humanizeFlag).join(", ")}`;
  const next =
    kind === "lint" ? "regenerate to clear it, then send" : "read it once more, then send as-is";
  return { kind, text, next };
}
