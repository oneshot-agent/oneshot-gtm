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

// ---------------------------------------------------------------------------
// Person research (issue: current role from the LinkedIn history)
//
// The finder's title and company come from a guest list, a headline, or an
// enrichment that may be years stale. `deepResearchPerson` returns the
// organisation history with `is_current`; this is the bounded record the
// post-finder step stores on the queue payload (`payload.personResearch`)
// and, once a prospect exists, in the person half of `dossier_json`. One
// record, every consumer: the draft's DOSSIER block, angle selection, the
// rotate generator, the reject prefill and the person gate all read it.
// ---------------------------------------------------------------------------

export interface PersonResearchOrganization {
  name: string;
  title?: string;
  /** As the provider gives it ("Mar 2026", "2026-03", "2023"). */
  startDate?: string;
  endDate?: string;
  /** `endDate_formatted.is_current`, else no end date. */
  current: boolean;
}

export interface PersonResearchCompany {
  name?: string;
  domain?: string;
  industry?: string;
  location?: string;
  size?: string;
  employeeCount?: number;
  founded?: string | number;
  fundingStage?: string;
  /** ≤400 chars. */
  description?: string;
}

export interface PersonResearchDossier {
  version: 1;
  /** complete = person + company facts; partial = person only. */
  status: "complete" | "partial" | "unavailable";
  researchedAt: string;
  /** What was handed to research, so a refresh can tell whether the seed changed. */
  seed: { url?: string; email?: string; name?: string; company?: string };
  currentRole?: { title?: string; company: string; since?: string };
  /** ≤8, current first, then most recent start. */
  organizations: PersonResearchOrganization[];
  bio?: string;
  location?: string;
  /** `best_work_email` — informational; the stored address is never swapped. */
  workEmail?: string;
  company?: PersonResearchCompany;
  costUsd: number;
  cached: boolean;
  warning?: string;
}

/** Serialized size the queue payload and the dossier half accept. */
export const PERSON_RESEARCH_MAX_CHARS = 4_000;
/** Rendered strings live on the payload as evidence; `describeTargetForAngle` skips anything longer than 240. */
export const PERSON_RESEARCH_LINE_CHARS = 240;

export function isPersonResearchDossier(value: unknown): value is PersonResearchDossier {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    r["version"] === 1 &&
    (r["status"] === "complete" || r["status"] === "partial" || r["status"] === "unavailable") &&
    Array.isArray(r["organizations"])
  );
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** "Founder & Product Owner at WildMuse.App since Mar 2026". */
export function renderCurrentRole(r: PersonResearchDossier): string | undefined {
  const role = r.currentRole;
  if (!role) return undefined;
  const head = role.title ? `${role.title} at ${role.company}` : role.company;
  return clip(role.since ? `${head} since ${role.since}` : head, PERSON_RESEARCH_LINE_CHARS);
}

/** "WildMuse.App · Software · 1-10 employees · founded 2026 · seed". */
export function renderCompanyFacts(c: PersonResearchCompany | undefined): string | undefined {
  if (!c) return undefined;
  const employees =
    typeof c.employeeCount === "number"
      ? `${c.employeeCount} employees`
      : c.size
        ? `${c.size} employees`
        : undefined;
  const parts = [
    c.name,
    c.industry,
    employees,
    c.founded != null && c.founded !== "" ? `founded ${c.founded}` : undefined,
    c.fundingStage,
    c.location,
  ].filter((p): p is string => typeof p === "string" && p.trim() !== "");
  const head = parts.join(" · ");
  const withDescription = c.description ? `${head}${head ? " — " : ""}${c.description}` : head;
  return clip(withDescription, PERSON_RESEARCH_LINE_CHARS);
}

/** "Head of Product at L'ETO Group (Nov 2024–Oct 2025); Business Consultant at Julia's Consultancy (2022–2024)". */
export function renderFormerRoles(r: PersonResearchDossier, max = 3): string | undefined {
  const former = r.organizations.filter((o) => !o.current).slice(0, max);
  if (former.length === 0) return undefined;
  const text = former
    .map((o) => {
      const head = o.title ? `${o.title} at ${o.name}` : o.name;
      const span = [o.startDate, o.endDate].filter(Boolean).join("–");
      return span ? `${head} (${span})` : head;
    })
    .join("; ");
  return clip(text, PERSON_RESEARCH_LINE_CHARS);
}

/**
 * Trim until the record fits `PERSON_RESEARCH_MAX_CHARS`: bio, then the
 * company description, then the oldest organisations. Never the current role.
 */
export function boundPersonResearch(r: PersonResearchDossier): PersonResearchDossier {
  const size = (x: PersonResearchDossier): number => JSON.stringify(x).length;
  let out: PersonResearchDossier = { ...r, organizations: [...r.organizations] };
  if (size(out) <= PERSON_RESEARCH_MAX_CHARS) return out;
  out = { ...out, ...(out.bio ? { bio: clip(out.bio, 300) } : {}) };
  if (size(out) <= PERSON_RESEARCH_MAX_CHARS) return out;
  if (out.company?.description) {
    out = { ...out, company: { ...out.company, description: clip(out.company.description, 160) } };
  }
  while (size(out) > PERSON_RESEARCH_MAX_CHARS && out.organizations.length > 1) {
    // Organisations are stored current-first, most recent next; drop from the tail.
    out = { ...out, organizations: out.organizations.slice(0, -1) };
  }
  if (size(out) > PERSON_RESEARCH_MAX_CHARS) {
    const { bio: _bio, ...rest } = out;
    out = rest;
  }
  return out;
}

/**
 * The person record every existing reader already understands:
 * `describeDossierForReject` reads title / company / summary / organizations
 * with `is_current`; `hasDossierSignal` counts title, company, summary and
 * organizations as signal; reply research slices the JSON.
 */
export function personRecordFromResearch(r: PersonResearchDossier): Record<string, unknown> {
  const currentRole = renderCurrentRole(r);
  const companyFacts = renderCompanyFacts(r.company);
  const formerRoles = renderFormerRoles(r);
  return {
    source: "deepResearchPerson",
    researchedAt: r.researchedAt,
    ...(r.currentRole?.title ? { title: r.currentRole.title } : {}),
    ...(r.currentRole?.company ? { company: r.currentRole.company } : {}),
    ...(currentRole ? { currentRole } : {}),
    ...(r.bio ? { summary: r.bio } : {}),
    ...(r.location ? { location: r.location } : {}),
    organizations: r.organizations.map((o) => ({
      name: o.name,
      ...(o.title ? { title: o.title } : {}),
      ...(o.startDate ? { startDate: o.startDate } : {}),
      ...(o.endDate ? { endDate: o.endDate } : {}),
      is_current: o.current,
    })),
    ...(companyFacts ? { companyFacts } : {}),
    ...(formerRoles ? { formerRoles } : {}),
    ...(r.workEmail ? { workEmail: r.workEmail } : {}),
  };
}

/** The `CompanyResult`-shaped record `describeCompanyForReject` reads. */
export function companyRecordFromResearch(
  r: PersonResearchDossier,
): Record<string, unknown> | null {
  const c = r.company;
  if (!c) return null;
  const out: Record<string, unknown> = {};
  if (c.name) out["name"] = c.name;
  if (c.domain) out["domain"] = c.domain;
  if (c.industry) out["industry"] = c.industry;
  if (c.location) out["location"] = c.location;
  if (c.size) out["size"] = c.size;
  if (typeof c.employeeCount === "number") out["employee_count"] = c.employeeCount;
  if (c.founded != null && c.founded !== "") out["founded"] = c.founded;
  if (c.fundingStage) out["funding_stage"] = c.fundingStage;
  if (c.description) out["description"] = c.description;
  return Object.keys(out).length > 0 ? out : null;
}

/** The person half of a stored dossier (bare legacy payload, or the `{person, product}` wrapper). */
export function readPersonHalf(current: string | null | undefined): unknown {
  if (!current?.trim()) return null;
  try {
    const parsed = JSON.parse(current) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return "person" in record || "product" in record ? (record["person"] ?? null) : parsed;
    }
    return parsed;
  } catch {
    return current;
  }
}

/**
 * Write the researched person record as the person half, keeping whatever
 * the enrich step already stored under `enrichment` (a failed sentinel is
 * dropped), and the product half untouched. The researched title, company
 * and organisations sit at the top of the half, so a reader that slices the
 * first few hundred characters sees the current facts first.
 */
export function mergePersonResearchDossier(
  current: string | null | undefined,
  research: PersonResearchDossier,
): string {
  const existing = readPersonHalf(current);
  const record = personRecordFromResearch(research);
  const keep =
    existing &&
    typeof existing === "object" &&
    !Array.isArray(existing) &&
    (existing as Record<string, unknown>)["source"] !== "deepResearchPerson" &&
    hasDossierSignal(existing)
      ? existing
      : typeof existing === "string" && hasDossierSignal(existing)
        ? existing
        : null;
  return mergePersonDossier(current, keep ? { ...record, enrichment: keep } : record);
}
