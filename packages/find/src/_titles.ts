/**
 * Matching a person's job title against a wanted `jobTitles` entry, shared
 * by the finders that pick a person at a company domain by title.
 */

/** Long forms and rank prefixes written as the short word people put in a `jobTitles` entry. */
const TITLE_ALIASES: Array<[RegExp, string]> = [
  [/\b(?:senior|executive|assistant|associate) vice president\b/g, "vp"],
  [/\bvice president\b/g, "vp"],
  [/\b(?:svp|evp|avp)\b/g, "vp"],
  [/\bartificial intelligence\b/g, "ai"],
  [/\bmachine learning\b/g, "ml"],
  [/\bchief technology officer\b/g, "cto"],
  [/\bchief information officer\b/g, "cio"],
  [/\bchief executive officer\b/g, "ceo"],
];
const TITLE_FILLER = new Set(["of", "the", "and", "for", "at", "in"]);

/** A title as whole lowercase words, aliases folded in and filler words dropped. */
export function titleWords(title: string): string[] {
  let text = title.toLowerCase();
  for (const [pattern, short] of TITLE_ALIASES) text = text.replace(pattern, short);
  return text.split(/[^a-z0-9]+/).filter((w) => w && !TITLE_FILLER.has(w));
}

/**
 * Does `title` carry every word of the wanted title, as whole words? Whole
 * words because a substring test calls a Director a CTO (dire-cto-r) and a
 * Head of Retail a Head of AI (ret-ai-l).
 */
export function titleMatches(title: string | null | undefined, wanted: string): boolean {
  const want = titleWords(wanted);
  if (want.length === 0) return false;
  const have = new Set(titleWords(title ?? ""));
  return want.every((w) => have.has(w));
}
