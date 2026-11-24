/**
 * How an email opens, read from its text. `offer`: the offer (or anything
 * else) comes first; `bet`: "I'd bet…"; `figure`: a number such as "47%"
 * or "1 in 5"; `question`: a question. The first sentence after any
 * greeting decides. `messageOpening: "mixed"` assigns one of these before
 * drafting; this records the one the draft actually used.
 */
export type OpeningShape = "offer" | "bet" | "figure" | "question";

export const OPENING_SHAPES: readonly OpeningShape[] = ["offer", "bet", "figure", "question"];

const NUMBER_WORDS = "one|two|three|four|five|six|seven|eight|nine|ten";
const NUMBER_WORD = new Map(NUMBER_WORDS.split("|").map((w, i) => [w, String(i + 1)]));

/** "47%", "47 percent", "1 in 5", "one in five". */
const FIGURE = new RegExp(
  String.raw`\b\d+(?:\.\d+)?\s?(?:%|percent\b)|\b(?:\d+|${NUMBER_WORDS}) in (?:\d+|${NUMBER_WORDS})\b`,
  "gi",
);

/** Every figure in `text`, normalised ("one in five" → "1 in 5", "47 percent" → "47%"). */
export function figuresIn(text: string): string[] {
  return [...text.matchAll(FIGURE)].map(([m]) =>
    m
      .toLowerCase()
      .replace(/\s?percent$/, "%")
      .replace(/\s%$/, "%")
      .replace(new RegExp(`\\b(${NUMBER_WORDS})\\b`, "g"), (w) => NUMBER_WORD.get(w) ?? w),
  );
}

const GREETING = /^(?:hey|hi|hello|dear|good (?:morning|afternoon))\b[^,\n]{0,40},?\s*$/i;
const BET = /^i(?:'|’)?d bet\b|^i bet\b/i;

/** The first sentence after a greeting line; "" for an empty body. */
export function openingSentence(body: string): string {
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const rest = lines.length > 1 && GREETING.test(lines[0]!) ? lines.slice(1) : lines;
  const text = rest.join(" ");
  return (text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text).trim();
}

/** The shape an email body opens with. */
export function openingShapeOf(body: string): OpeningShape {
  const first = openingSentence(body);
  if (first.endsWith("?")) return "question";
  if (figuresIn(first).length > 0) return "figure";
  if (BET.test(first)) return "bet";
  return "offer";
}
