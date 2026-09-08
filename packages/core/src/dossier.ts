/**
 * Is a research dossier worth persisting onto a prospect?
 *
 * This gate is load-bearing, not a tidiness check. `apps/server/src/api/
 * _reply-research.ts` treats ANY non-empty `prospects.dossier_json` as a free
 * Tier-1 hit and skips paid research entirely — so storing a dossier that says
 * nothing leaves the reply drafter WORSE off than an empty column, because it
 * suppresses the enrich/webRead/profile-URL tiers that would have found
 * something. Two shapes reach this from real data and both look non-empty:
 *
 *   - a failed enrich:  {"status":"failed","profile":null,"cost":0}
 *   - a person lookup that found nobody: every key present, every value null,
 *     plus summary "<addr> is a role based email address" — a fact about the
 *     MAILBOX, not the person.
 */

/** Fields that actually say something about a person. */
const SIGNAL_FIELDS = [
  "title",
  "company",
  "summary",
  "bio",
  "headline",
  "experience",
  "education",
  "organizations",
  "skills",
] as const;

/**
 * `location` is deliberately absent: "United States" is a real value that
 * grounds neither a reply nor an ICP judgement, and storing a dossier for it
 * would still suppress the paid tiers.
 */

/** The provider's placeholder summary for a shared inbox — not role text. */
const ROLE_MAILBOX = /is a role based email address/i;

/**
 * Scraped profile pages that rendered fine but say nothing about the person.
 * A Luma user page for someone who hosts no events is the common case: the
 * read succeeds, the excerpt is a few hundred non-empty characters, and every
 * one of them is chrome. Left unchecked it satisfies the `excerpt` test below,
 * marks the dossier as signal, and suppresses the paid reply-research tiers —
 * the exact failure this file exists to prevent.
 *
 * Kept deliberately narrow: only phrases a page shows INSTEAD of content.
 */
const EMPTY_PROFILE = [
  /nothing here,? yet/i,
  /has no public events/i,
  /this user has no/i,
  /no results? found/i,
  /page not found/i,
] as const;

/** True when an excerpt is a page's own "there is nothing here" message. */
function isEmptyProfileExcerpt(text: string): boolean {
  return EMPTY_PROFILE.some((pattern) => pattern.test(text));
}

/** Nested places the payload shapes put the same keys. */
const NESTED_KEYS = ["enrichment", "profile", "result", "person", "product"] as const;

export interface ProductResearchSource {
  url: string;
  kind: "repository" | "website" | "profile" | "external";
  /** Bounded first-party text. External research keeps its own citations. */
  excerpt?: string;
}

export interface ProductResearchDossier {
  version: 1;
  status: "complete" | "partial" | "unavailable";
  researchedAt: string;
  subject: { name?: string; company?: string };
  sources: ProductResearchSource[];
  external?: unknown;
  warning?: string;
}

/** Merge new product context without discarding legacy person-enrichment JSON. */
export function mergeProductDossier(
  current: string | null | undefined,
  product: ProductResearchDossier,
): string {
  let person: unknown = null;
  if (current?.trim()) {
    try {
      const parsed = JSON.parse(current) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        person = "person" in record ? record["person"] : parsed;
      } else {
        person = parsed;
      }
    } catch {
      person = current;
    }
  }
  return JSON.stringify({ person, product }, null, 2);
}

/**
 * The mirror of `mergeProductDossier`: write the person half without
 * discarding product research.
 *
 * `research-prospects` used to `setProspectDossier(JSON.stringify(payload))`,
 * which replaced the whole column and destroyed the `{person, product}`
 * wrapper `research-products` had written. The two commands run independently
 * and neither should clobber the other.
 */
export function mergePersonDossier(current: string | null | undefined, person: unknown): string {
  let product: unknown = null;
  if (current?.trim()) {
    try {
      const parsed = JSON.parse(current) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        product = (parsed as Record<string, unknown>)["product"] ?? null;
      }
    } catch {
      // A legacy non-JSON dossier is person prose; there is no product half to
      // keep, and the new person payload supersedes it.
      product = null;
    }
  }
  return JSON.stringify({ person, product }, null, 2);
}

/**
 * Does the PERSON half of a stored dossier carry research?
 *
 * `hasDossierSignal` answers "is this column worth keeping", which a product
 * dossier alone satisfies. That is the wrong question for the research
 * backlog: a row whose `person` is null still needs `deepResearchPerson`, and
 * for 531 of 684 prospects the product half alone was enough to make them look
 * done. Callers selecting research candidates want this, not the broad gate.
 */
export function hasPersonSignal(stored: string | null | undefined): boolean {
  if (!stored?.trim()) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    // Prose a play assembled — genuine person context (see hasDossierSignal).
    return true;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return hasDossierSignal(parsed);
  }
  const record = parsed as Record<string, unknown>;
  // Pre-wrapper rows are a bare person payload; wrapped rows nest it.
  const person = "person" in record ? record["person"] : record;
  return hasDossierSignal(person);
}

function substantive(scope: unknown): boolean {
  if (!scope || typeof scope !== "object") return false;
  const record = scope as Record<string, unknown>;
  return SIGNAL_FIELDS.some((field) => {
    const value = record[field];
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    return trimmed.length > 0 && !ROLE_MAILBOX.test(trimmed);
  });
}

/**
 * True when `value` carries something worth storing. Accepts the parsed
 * payload or the serialized string a play assembled — prose that isn't JSON is
 * real dossier text and always counts.
 */
export function hasDossierSignal(value: unknown): boolean {
  if (value === null || value === undefined) return false;

  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") return false;
    // Only strings that PARSE are payloads to inspect; anything else is the
    // prose a play wrote for its prompt, which is genuine context.
    if (!/^[[{]/.test(text)) return true;
    try {
      return hasDossierSignal(JSON.parse(text));
    } catch {
      // Truncated JSON (dossiers are sliced) — treat as prose rather than
      // discarding context we already paid for.
      return true;
    }
  }

  if (Array.isArray(value)) return value.some((v) => hasDossierSignal(v));
  if (typeof value !== "object") return false;

  const body = value as Record<string, unknown>;
  // An explicit failure sentinel is never signal, whatever else it carries.
  if (typeof body.status === "string" && body.status.toLowerCase() === "failed") return false;
  if (Array.isArray(body.articles) && body.articles.length > 0) return true;
  if (Array.isArray(body.sources)) {
    const hasExcerpt = body.sources.some((source) => {
      if (source === null || typeof source !== "object") return false;
      const excerpt = (source as Record<string, unknown>)["excerpt"];
      if (typeof excerpt !== "string") return false;
      const trimmed = excerpt.trim();
      // Non-empty is not the same as informative — a profile page's own
      // "Nothing Here, Yet" is chrome, and counting it suppresses paid research.
      return trimmed !== "" && !isEmptyProfileExcerpt(trimmed);
    });
    // Product dossiers carry a subject for identification, but a company/name
    // alone is not researched context. Only sourced text or an external result
    // should suppress the reply research fallback.
    return hasExcerpt || ("external" in body && body["external"] != null);
  }
  if (substantive(body)) return true;
  return NESTED_KEYS.some((key) => key in body && hasDossierSignal(body[key]));
}
