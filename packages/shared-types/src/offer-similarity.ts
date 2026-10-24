/**
 * Near-duplicate prospect offers. A writer asked for five offers can return
 * one job twice in different words ("... operating authority and active
 * safety records" beside "... operating authority and safety records"), and
 * a repair or replacement round can restate one it already kept. Exact-text
 * dedupe lets those through; this compares the offers' content words.
 * Deterministic and shared, so the writer drops what the queue's Next offer
 * would skip.
 */

// "s" is what a possessive leaves once punctuation is gone ("depot's"); "i
// can", "we will" and the like are a preamble, never the offer's action.
// "us" stays a word: it names a jurisdiction as often as a speaker. "with"
// stays too: it states a condition ("match payments with invoices"), and so
// do "over" and "under": a threshold's direction ("invoices over $5,000").
const OFFER_STOPWORDS = new Set(
  (
    "a an the and or but of to in on at by for from into onto via per across " +
    "your their our its this that these those it they them you we is are be been as so than " +
    "each every any all s i me can will would could should may might let ll"
  ).split(" "),
);

/** Words that start another clause of an offer: a second action, or more of the first. */
const JOINERS = new Set(["and", "then", "plus", "also", "while", ","]);

/**
 * Words that turn an offer around: "verify invoices are not paid". "t" is
 * what "isn't" or "can't" leaves once the apostrophe is gone.
 */
const NEGATIONS = new Set(
  "not no never without non nor none neither nothing nobody cannot t".split(" "),
);

/** Letters and digits, the units a number carries, and the comma (a joiner). */
const TOKEN = /[\p{L}\p{N}]+|[$%€£,]/gu;

/** Units spelled out, read as their sign: "10 percent" is "10%", never "10". */
const UNIT_SIGNS = new Map(
  (
    [
      ["percent", "%"],
      ["percentage", "%"],
      ["dollar", "$"],
      ["euro", "€"],
      ["pound", "£"],
    ] as const
  ).map(([word, sign]) => [stem(word), sign]),
);

/**
 * At most this many content words dropped from one offer still read as the
 * same offer: a modifier ("active"), not a job.
 */
export const OFFER_NEAR_DUPLICATE_DROPPED_WORDS = 1;
/** The offers must share this many content words for a drop to be a rewording. */
const NEAR_DUPLICATE_MIN_SHARED = 3;

/**
 * "backlogs" and "backlog", "verifying", "verifies" and "verify", "create",
 * "creating" and "created" read as one word: a trailing "e" goes too.
 */
function stem(word: string): string {
  let w = word;
  if (w.length > 4 && /i(?:es|ed)$/.test(w)) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/**
 * An offer's clauses, split at "and", "then" or a comma, each its content
 * words in order: lowercased, stopwords dropped, lightly stemmed, with a
 * number's "$" or "%" kept as a word of its own ("percent" read as "%") and
 * its thousands separators gone ("$10,000" is "$10000"). `names` holds the
 * words written capitalized
 * past the first ("US", "Leeds"): they set the offer's scope.
 */
function offerClauses(text: string): { clauses: string[][]; names: Set<string> } {
  const clauses: string[][] = [[]];
  const names = new Set<string>();
  const tokens = text.replace(/(\d),(?=\d{3}\b)/g, "$1").match(TOKEN) ?? [];
  tokens.forEach((raw, i) => {
    const t = raw.toLowerCase();
    if (JOINERS.has(t)) {
      if (clauses.at(-1)!.length > 0) clauses.push([]);
      return;
    }
    if (OFFER_STOPWORDS.has(t)) return;
    const stemmed = NEGATIONS.has(t) ? t : stem(t);
    const w = UNIT_SIGNS.get(stemmed) ?? stemmed;
    if (i > 0 && /\p{Lu}/u.test(raw)) names.add(w);
    clauses.at(-1)!.push(w);
  });
  if (clauses.length > 1 && clauses.at(-1)!.length === 0) clauses.pop();
  return { clauses, names };
}

/** An offer's content words (`offerClauses`), in the order they first appear. */
export function offerContentWords(text: string): Set<string> {
  return new Set(offerClauses(text).clauses.flat());
}

/** A word no rewording drops: a number, its unit, or a negation. */
function carriesMeaning(word: string): boolean {
  return /[\p{N}$%€£]/u.test(word) || NEGATIONS.has(word);
}

/**
 * The words `longer` has beyond `shorter`, when `shorter` is `longer` with
 * them taken out and nothing else changed (same words, same order); else null.
 */
function droppedWords(longer: string[], shorter: string[]): string[] | null {
  const out: string[] = [];
  let j = 0;
  for (const w of longer) {
    if (j < shorter.length && shorter[j] === w) j++;
    else out.push(w);
  }
  return j === shorter.length ? out : null;
}

/**
 * True when two offers name the same job: clause by clause the same content
 * words in the same order, but for at most
 * `OFFER_NEAR_DUPLICATE_DROPPED_WORDS` dropped from one (and three or more
 * kept). Anything else is a different job: a word swapped (another object,
 * action or number), the words reordered ("collect invoices and verify
 * receipts" is not "collect receipts and verify invoices"), a clause added
 * ("... and recover charges"), or a number, unit, negation or name dropped
 * (a 2025 filing and one with no year; "paid" and "not paid"; "US sales
 * tax" and "sales tax"). The offers must open on the same action.
 */
export function offersNearDuplicate(a: string, b: string): boolean {
  const pa = offerClauses(a);
  const pb = offerClauses(b);
  const ca = pa.clauses;
  const cb = pb.clauses;
  const lead = ca[0]![0];
  if (lead === undefined || cb[0]![0] === undefined) {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  if (ca.length !== cb.length || lead !== cb[0]![0]) return false;
  const dropped: string[] = [];
  let kept = 0;
  for (let i = 0; i < ca.length; i++) {
    const [longer, shorter] = ca[i]!.length >= cb[i]!.length ? [ca[i]!, cb[i]!] : [cb[i]!, ca[i]!];
    const out = droppedWords(longer, shorter);
    if (!out) return false;
    dropped.push(...out);
    kept += shorter.length;
  }
  if (dropped.length === 0) return true;
  return (
    dropped.length <= OFFER_NEAR_DUPLICATE_DROPPED_WORDS &&
    kept >= NEAR_DUPLICATE_MIN_SHARED &&
    !dropped.some((w) => carriesMeaning(w) || pa.names.has(w) || pb.names.has(w))
  );
}

/** The first of `others` that is a near-duplicate of `text`, if any. */
export function nearDuplicateOffer(text: string, others: Iterable<string>): string | null {
  for (const other of others) if (offersNearDuplicate(text, other)) return other;
  return null;
}
