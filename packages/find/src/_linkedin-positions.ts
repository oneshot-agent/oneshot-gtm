/**
 * LinkedIn position strings as profile providers pass them on. Pure.
 *
 * A LinkedIn Experience entry reads "Company · Full-time" under the title,
 * and "Jun 2023 - Oct 2023 · 4 mos" under that. Providers copy those lines
 * verbatim, so a company name arrives with its employment type attached
 * ("Acme · Full-time", "Acme · undefined") and a period with its tenure.
 *
 * Several roles at one company show as a group: the company on top, then
 * "Full-time · 1 yr 9 mos" (the type and the total tenure) where a single
 * role would show its company, and no dates. Providers read that header as
 * a role: the company lands in `title`, the tenure line in `company`, and the
 * period is empty. The roles under it often do not follow.
 */

/** LinkedIn's employment types, plus the `undefined` a provider writes when the type is missing. */
const EMPLOYMENT_TYPE =
  "(?:full-time|part-time|contract|freelance|permanent|self-employed|internship|seasonal|apprenticeship|temporary|work study|co-op|casual|undefined)";

/** One employment type, or two ("Permanent Full-time", "Contract Part-time"). */
const EMPLOYMENT_TYPES_RX = new RegExp(`^${EMPLOYMENT_TYPE}(?: ${EMPLOYMENT_TYPE})?$`, "i");

/** " · Full-time" / " · Permanent Full-time" / " · undefined" at the end of a company name. */
const TRAILING_TYPE_RX = new RegExp(` · ${EMPLOYMENT_TYPE}(?: ${EMPLOYMENT_TYPE})?$`, "i");

/** "Full-time · 1 yr 9 mos" / "undefined · 3 yrs" / "4 mos": a group header's tenure line. */
const TENURE_LINE_RX = new RegExp(
  `^(?:${EMPLOYMENT_TYPE}(?: ${EMPLOYMENT_TYPE})? · )?` +
    "(?:less than a year|\\d+ (?:yrs?|years?)(?: \\d+ (?:mos?|months?))?|\\d+ (?:mos?|months?))$",
  "i",
);

/** Bare employment types that are a real answer to "where": the person works for themselves. */
const SELF_EMPLOYED_RX = /^(?:freelance|self-employed)$/i;

const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();

/**
 * True for a group header's tenure line: an optional employment type, then a
 * tenure ("Full-time · 1 yr 9 mos"). Never a company name.
 */
export function isTenureLine(value: string | null | undefined): boolean {
  return typeof value === "string" && TENURE_LINE_RX.test(collapse(value));
}

/**
 * "Jun 2023 - Oct 2023 · 4 mos" → "Jun 2023 - Oct 2023": the tenure after the
 * dot is derived from the dates, not a date. Same rule as the live read.
 */
export function stripTenure(value: string): string {
  // indexOf rather than a regex: provider text, and nothing to backtrack over.
  const dot = value.indexOf("·");
  return (dot >= 0 ? value.slice(0, dot) : value).trim();
}

/**
 * The company as a name: a trailing " · <employment type>" removed, a
 * provider's "undefined" and a tenure line read as no name (null). A dot
 * inside a name stays ("Studio · Nine Labs" keeps everything that is not an
 * employment type). A bare "Freelance" or "Self-employed" is kept: it is
 * where someone working for themselves works.
 */
export function cleanCompanyName(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const name = collapse(value);
  if (!name || isTenureLine(name)) return null;
  const cleaned = name.replace(TRAILING_TYPE_RX, "").replace(/ ?·$/u, "").trim();
  if (!cleaned || /^(?:undefined|null)$/i.test(cleaned)) return null;
  return cleaned;
}

/**
 * True when a name says how someone worked, not where: a tenure line, the
 * provider's "undefined", or a bare employment type such as "Full-time".
 * "Freelance" and "Self-employed" name a way of working for yourself and
 * are not placeholders.
 */
export function isPlaceholderCompanyName(value: string | null | undefined): boolean {
  const cleaned = cleanCompanyName(value);
  if (!cleaned) return true;
  return EMPLOYMENT_TYPES_RX.test(cleaned) && !SELF_EMPLOYED_RX.test(cleaned);
}

/**
 * A provider's top-level `title` / `company` pair, read the same way: when
 * `company` is a group header's tenure line, `title` holds the company and
 * there is no title. Otherwise the company is cleaned and the title kept.
 */
export function providerTopRole(
  title: string | null | undefined,
  company: string | null | undefined,
): { title: string | null; company: string | null } {
  if (isTenureLine(company)) return { title: null, company: cleanCompanyName(title) };
  const name = cleanCompanyName(company);
  return {
    title: typeof title === "string" && title.trim() ? title.trim() : null,
    company: name && !isPlaceholderCompanyName(name) ? name : null,
  };
}
