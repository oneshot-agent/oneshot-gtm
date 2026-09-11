/**
 * Person research on queue rows and prospects: the current role from the
 * LinkedIn history, facts about the current company, and a re-judged person
 * gate — stored once, read by every consumer.
 *
 * Why (2026-09-11, row #9144): the guest list gave a slogan for a title and a
 * company the person had left a year earlier. Enrichment by email failed. Her
 * LinkedIn experience said Founder & Product Owner somewhere else since March.
 * The gate said "unclear" on the slogan, the draft and the angle generator
 * worked from the stale company, and the reject box had nothing to read. The
 * founder found all of it by hand in two minutes.
 *
 * Sibling of `_product-research.ts`: runs after a finder over the rows it
 * created, budgeted by the trigger's `maxCostUsd`, never behind a click
 * (`deepResearchPerson` is minutes). Two write paths, one derivation:
 *
 *   - a row not yet sent keeps the record on `payload.personResearch` and gets
 *     its `title` / `company` corrected in place (finder originals kept);
 *   - an existing prospect gets the person half of `dossier_json`, its
 *     `title` / `company` columns corrected, and the ICP verdict re-judged.
 */
import {
  boundPersonResearch,
  getLedger,
  hasDossierSignal,
  isPersonResearchDossier,
  logEvent,
  mergePersonResearchDossier,
  parallelMap,
  readPersonHalf,
  renderCompanyFacts,
  renderCurrentRole,
  renderFormerRoles,
  type PersonResearchCompany,
  type PersonResearchDossier,
  type PersonResearchOrganization,
  type QueueRow,
} from "@oneshot-gtm/core";
import type { FitReasonSource } from "@oneshot-gtm/shared-types";
import { qualifyPerson, resolveIcp, type PersonVerdict } from "./_filter.ts";
import { isDudDomain } from "./_findemail-prescreen.ts";
import { stampFitReason } from "./_fit-reason.ts";
import { researchQueueRowProduct } from "./_product-research.ts";
import { isResearchableUrl } from "./_profile-url.ts";
import { safeScorePriority } from "./_priority-adapters.ts";
import { safeDeepResearchPerson, safeEnrichCompany } from "./_sdk-safe.ts";
import type { FinderResult } from "./_types.ts";

export const PERSON_RESEARCH_COST_ESTIMATE_USD = 0.05;
export const COMPANY_RESEARCH_COST_ESTIMATE_USD = 0.005;
/** Reserved per in-flight call against the trigger cap; released on completion. */
const RESERVE_USD = 0.06;
/** Soft wall budget for one post-finder pass; leftover rows wait for the backfill or the next run. */
const RUN_BUDGET_MS = 20 * 60 * 1000;
const COMPANY_ENRICH_TIMEOUT_MS = 30_000;
const COMPANY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ORGANIZATIONS = 8;

type JsonRecord = Record<string, unknown>;
type LedgerLike = ReturnType<typeof getLedger>;

export type ResearchableQueueRow = Pick<
  QueueRow,
  "id" | "play_name" | "source" | "notes" | "payload_json" | "status" | "prospect_id"
>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(body: JsonRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeProfileUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.startsWith("http") ? value : `https://${value}`);
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Seed: what to hand the research call
// ---------------------------------------------------------------------------

export interface PersonSeed {
  url: string | null;
  email: string | null;
  name: string | null;
  company: string | null;
  title: string | null;
  domain: string | null;
}

/**
 * Null when there is nothing `deepResearchPerson` can build a person from: no
 * researchable profile URL and no email + name. A name alone fails
 * deterministically (see research-prospects: 281 of 281 twice).
 */
export function personSeedFor(payload: JsonRecord): PersonSeed | null {
  const candidates = [
    str(payload, "linkedinUrl"),
    str(payload, "sourceProfileUrl"),
    str(payload, "profileUrl", "authorUrl"),
  ];
  const url =
    candidates
      .map(normalizeProfileUrl)
      .find((u): u is string => Boolean(u) && isResearchableUrl(u)) ?? null;
  const email = str(payload, "email", "founderEmail", "guestEmail")?.toLowerCase() ?? null;
  const name = str(payload, "name", "founderName", "guestName", "hostName");
  const company = str(payload, "company", "newCompany", "guestCompany");
  const title = str(payload, "title");
  const domain = str(payload, "companyDomain", "newCompanyDomain", "guestCompanyDomain");
  if (!url && !(email && name)) return null;
  return { url, email, name, company, title, domain };
}

// ---------------------------------------------------------------------------
// Organisations → current role
// ---------------------------------------------------------------------------

/** "Mar 2026" / "2026-03" / "2026" → a sortable number, or null. */
function dateKey(value: string | undefined): number | null {
  if (!value) return null;
  const iso = /^(\d{4})(?:-(\d{1,2}))?/.exec(value.trim());
  if (iso) return Number(iso[1]) * 12 + (iso[2] ? Number(iso[2]) - 1 : 0);
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) {
    const d = new Date(parsed);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  }
  const year = /(\d{4})/.exec(value);
  return year ? Number(year[1]) * 12 : null;
}

/** "Nov 2024 - Present" / "2019 - 2021" / "Mar 2026 -" → start, end, current. */
export function parsePeriod(period: string | null | undefined): {
  startDate?: string;
  endDate?: string;
  current: boolean;
} | null {
  if (!period) return null;
  const parts = period
    .split(/\s*[-–—]\s*|\s+to\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const start = parts[0];
  const endRaw = parts[1] ?? "";
  const current = endRaw === "" || /^(present|current|now|today)$/i.test(endRaw);
  return {
    ...(start ? { startDate: start } : {}),
    ...(current || !endRaw ? {} : { endDate: endRaw }),
    current,
  };
}

function orgFrom(raw: JsonRecord): PersonResearchOrganization | null {
  const name = isRecord(raw["company"])
    ? str(raw["company"] as JsonRecord, "name")
    : (str(raw, "company") ?? str(raw, "name"));
  if (!name) return null;
  const title = isRecord(raw["title"])
    ? str(raw["title"] as JsonRecord, "name")
    : str(raw, "title");
  const period = parsePeriod(str(raw, "period"));
  const formatted = isRecord(raw["endDate_formatted"])
    ? (raw["endDate_formatted"] as JsonRecord)
    : null;
  const startDate = period?.startDate ?? str(raw, "startDate", "start_date") ?? undefined;
  const endDate = period?.endDate ?? str(raw, "endDate", "end_date") ?? undefined;
  const current =
    typeof formatted?.["is_current"] === "boolean"
      ? (formatted["is_current"] as boolean)
      : period
        ? period.current
        : raw["is_primary"] === true || !endDate;
  return {
    name,
    ...(title ? { title } : {}),
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    current,
  };
}

/**
 * Read the organisation history out of a `deepResearchPerson` result. Two
 * shapes arrive: the typed `enrichment.organizations[]` (`endDate_formatted.
 * is_current`), and the enrich-style `experience[]` with a `period` string
 * ("Nov 2024 - Present") at the top level and again under `enrichment`. The
 * provider also emits a dateless `organizations` entry built from the
 * headline; a dated entry for the same company wins over it, because the
 * dates are what a current-role judgment turns on.
 */
export function organizationsFromResearch(result: unknown): PersonResearchOrganization[] {
  if (!isRecord(result)) return [];
  const inner = isRecord(result["result"]) ? (result["result"] as JsonRecord) : result;
  const scopes: JsonRecord[] = [inner];
  if (isRecord(inner["enrichment"])) scopes.push(inner["enrichment"] as JsonRecord);
  const dated: PersonResearchOrganization[] = [];
  const undated: PersonResearchOrganization[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    for (const key of ["experience", "organizations"] as const) {
      const list = Array.isArray(scope[key]) ? scope[key] : [];
      for (const raw of list) {
        if (!isRecord(raw)) continue;
        const org = orgFrom(raw);
        if (!org) continue;
        const id = `${normalizeCompany(org.name)}|${normalizeTitle(org.title)}|${org.startDate ?? ""}`;
        if (seen.has(id)) continue;
        seen.add(id);
        (org.startDate || org.endDate ? dated : undated).push(org);
      }
    }
  }
  // A dateless headline entry for a company that already has a dated entry
  // adds nothing; keep dateless entries only for companies not seen dated.
  const datedCompanies = new Set(dated.map((o) => normalizeCompany(o.name)));
  return [...dated, ...undated.filter((o) => !datedCompanies.has(normalizeCompany(o.name)))];
}

/**
 * The current role and the history ordered for storage: current first, then
 * most recent start. Among several current entries the latest start wins;
 * unparseable dates keep the provider's order. No current entry → no role:
 * the most recently ended job is not where someone works now.
 */
export function deriveCurrentRole(orgs: PersonResearchOrganization[]): {
  current: PersonResearchOrganization | null;
  organizations: PersonResearchOrganization[];
} {
  const indexed = orgs.map((o, i) => ({ o, i, start: dateKey(o.startDate) }));
  const byRecency = (a: (typeof indexed)[number], b: (typeof indexed)[number]): number => {
    if (a.start != null && b.start != null && a.start !== b.start) return b.start - a.start;
    if (a.start != null && b.start == null) return -1;
    if (a.start == null && b.start != null) return 1;
    return a.i - b.i;
  };
  const current = indexed.filter((x) => x.o.current).sort(byRecency);
  const former = indexed.filter((x) => !x.o.current).sort(byRecency);
  const organizations = [...current, ...former].map((x) => x.o).slice(0, MAX_ORGANIZATIONS);
  return { current: current[0]?.o ?? null, organizations };
}

function unavailable(seed: PersonSeed | null, warning: string): PersonResearchDossier {
  return {
    version: 1,
    status: "unavailable",
    researchedAt: new Date().toISOString(),
    seed: {
      ...(seed?.url ? { url: seed.url } : {}),
      ...(seed?.email ? { email: seed.email } : {}),
      ...(seed?.name ? { name: seed.name } : {}),
      ...(seed?.company ? { company: seed.company } : {}),
    },
    organizations: [],
    costUsd: 0,
    cached: false,
    warning,
  };
}

function companyFromRecord(record: JsonRecord): PersonResearchCompany | null {
  const c: PersonResearchCompany = {};
  const name = str(record, "name");
  if (name) c.name = name;
  const domain = str(record, "domain");
  if (domain) c.domain = domain.toLowerCase();
  const industry = str(record, "industry");
  if (industry) c.industry = industry;
  const location = str(record, "location");
  if (location) c.location = location;
  const size = str(record, "size");
  if (size) c.size = size;
  if (typeof record["employee_count"] === "number") c.employeeCount = record["employee_count"];
  const founded = record["founded"] ?? record["founded_year"] ?? record["year_founded"];
  if (typeof founded === "number" || (typeof founded === "string" && founded.trim()))
    c.founded = founded;
  const stage = str(record, "funding_stage", "latest_funding_stage");
  if (stage) c.fundingStage = stage;
  const description = str(record, "description");
  if (description) c.description = description.replace(/\s+/g, " ").slice(0, 400);
  return Object.keys(c).length > 0 ? c : null;
}

// ---------------------------------------------------------------------------
// Research one person
// ---------------------------------------------------------------------------

export interface ResearchPersonInput {
  seed: PersonSeed | null;
  playName: string;
  /** For the receipt's decision context. */
  subject: { queueId?: number; prospectId?: number };
  remainingUsd: number;
  /** Buy the current company's record (default true). */
  enrichCompany?: boolean;
}

export async function researchPerson(input: ResearchPersonInput): Promise<{
  dossier: PersonResearchDossier;
  costUsd: number;
  cached: boolean;
}> {
  const { seed } = input;
  if (!seed) {
    return {
      dossier: unavailable(null, "no researchable profile URL and no email with a name"),
      costUsd: 0,
      cached: false,
    };
  }
  if (input.remainingUsd < PERSON_RESEARCH_COST_ESTIMATE_USD) {
    return {
      dossier: unavailable(seed, "person research skipped: cost cap reached"),
      costUsd: 0,
      cached: false,
    };
  }
  const ledger = getLedger();
  const res = await safeDeepResearchPerson(
    {
      ...(seed.url ? { socialMediaUrl: seed.url } : {}),
      ...(seed.email ? { email: seed.email } : {}),
      ...(seed.name ? { name: seed.name } : {}),
      ...(seed.company && seed.company !== "(unknown)" ? { company: seed.company } : {}),
    },
    {
      playName: input.playName,
      memo: "person research: current role and company before review",
      decisionContext: { source: "person-research", ...input.subject },
    },
  );
  const billed = res.receiptId !== 0;
  let costUsd = billed ? (res.result?.cost ?? 0) : 0;
  if (!res.result || res.result.status === "failed") {
    return { dossier: unavailable(seed, "person research failed"), costUsd, cached: false };
  }
  const orgs = organizationsFromResearch(res.result);
  const { current, organizations } = deriveCurrentRole(orgs);
  const inner = isRecord(res.result.result) ? (res.result.result as JsonRecord) : {};
  const enrichment = isRecord(inner["enrichment"]) ? (inner["enrichment"] as JsonRecord) : {};
  const bio = str(enrichment, "bio", "summary", "headline") ?? undefined;
  const location = str(enrichment, "location") ?? undefined;
  const workEmail = str(enrichment, "best_work_email")?.toLowerCase() ?? undefined;
  if (!current && organizations.length === 0 && !bio) {
    return {
      dossier: unavailable(seed, "person research returned no organisation history"),
      costUsd,
      cached: !billed,
    };
  }

  let company: PersonResearchCompany | undefined;
  if (current && input.enrichCompany !== false) {
    const key = `company:${current.name.toLowerCase()}`;
    const cached = ledger.getProductResearchCache(key, COMPANY_CACHE_TTL_MS);
    if (cached) {
      try {
        company = JSON.parse(cached) as PersonResearchCompany;
      } catch {
        // corrupt cache → refetch
      }
    }
    if (!company && costUsd + COMPANY_RESEARCH_COST_ESTIMATE_USD <= input.remainingUsd) {
      const sameCompany =
        seed.company != null && normalizeCompany(seed.company) === normalizeCompany(current.name);
      const enriched = await safeEnrichCompany(
        {
          ...(sameCompany && seed.domain ? { domain: seed.domain } : { name: current.name }),
          timeoutMs: COMPANY_ENRICH_TIMEOUT_MS,
        },
        {
          playName: input.playName,
          memo: "company facts for the person's current employer",
          decisionContext: { source: "person-research", ...input.subject },
        },
      );
      if (enriched.receiptId !== 0) costUsd += enriched.result.cost ?? 0;
      if (enriched.result.status !== "error" && isRecord(enriched.result.company)) {
        const record = companyFromRecord(enriched.result.company as JsonRecord);
        if (record) {
          company = record;
          ledger.setProductResearchCache(key, JSON.stringify(record));
        }
      }
    }
  }

  const dossier: PersonResearchDossier = boundPersonResearch({
    version: 1,
    status: company ? "complete" : "partial",
    researchedAt: new Date().toISOString(),
    seed: {
      ...(seed.url ? { url: seed.url } : {}),
      ...(seed.email ? { email: seed.email } : {}),
      ...(seed.name ? { name: seed.name } : {}),
      ...(seed.company ? { company: seed.company } : {}),
    },
    ...(current
      ? {
          currentRole: {
            ...(current.title ? { title: current.title } : {}),
            company: current.name,
            ...(current.startDate ? { since: current.startDate } : {}),
          },
        }
      : {}),
    organizations,
    ...(bio ? { bio: bio.replace(/\s+/g, " ").slice(0, 600) } : {}),
    ...(location ? { location } : {}),
    ...(workEmail ? { workEmail } : {}),
    ...(company ? { company } : {}),
    costUsd,
    cached: !billed,
  });
  return { dossier, costUsd, cached: !billed };
}

// ---------------------------------------------------------------------------
// From research to the row: title/company overrides and rendered evidence
// ---------------------------------------------------------------------------

const COMPANY_SUFFIX =
  /\b(?:group|inc|incorporated|llc|ltd|limited|co|corp|corporation|gmbh|sas|srl|plc|ag|the)\b/g;

/** "L'eto Group" ≡ "L'ETO Group" ≡ "L'ETO": case, punctuation and legal suffixes never count as a change. */
export function normalizeCompany(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(COMPANY_SUFFIX, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function normalizeTitle(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface PersonPayloadPatch extends JsonRecord {
  personResearch: PersonResearchDossier;
  title?: string;
  company?: string;
  companyDomain?: string;
  titleAtFinder?: string;
  companyAtFinder?: string;
  companyDomainAtFinder?: string;
  currentRole?: string;
  companyFacts?: string;
  formerRoles?: string;
  productResearch?: null;
}

/**
 * Pure: the patch that puts research on a row. Overrides `title` / `company`
 * only when the research says something different, keeping the finder's
 * originals (set once, never overwritten on refresh). A domain change clears
 * `productResearch` so it is re-run for the right company.
 */
export function personPayloadPatch(
  payload: JsonRecord,
  dossier: PersonResearchDossier,
): PersonPayloadPatch {
  const patch: PersonPayloadPatch = { personResearch: dossier };
  if (dossier.status === "unavailable") return patch;
  const role = dossier.currentRole;
  const existingTitle = str(payload, "title");
  const existingCompany = str(payload, "company");
  const existingDomain = str(payload, "companyDomain");
  if (role?.title && normalizeTitle(role.title) !== normalizeTitle(existingTitle)) {
    patch.title = role.title;
    if (existingTitle && !str(payload, "titleAtFinder")) patch.titleAtFinder = existingTitle;
  }
  if (role?.company && normalizeCompany(role.company) !== normalizeCompany(existingCompany)) {
    patch.company = role.company;
    if (existingCompany && !str(payload, "companyAtFinder"))
      patch.companyAtFinder = existingCompany;
  }
  const domain = dossier.company?.domain?.toLowerCase();
  if (
    domain &&
    !isDudDomain(domain) &&
    (!existingDomain || existingDomain.toLowerCase() !== domain) &&
    // Only move the domain when the research also moved the company; a
    // provider's guess at a domain for the same company is not a correction.
    (patch.company !== undefined || !existingDomain)
  ) {
    patch.companyDomain = domain;
    if (existingDomain && !str(payload, "companyDomainAtFinder")) {
      patch.companyDomainAtFinder = existingDomain;
    }
    if (existingDomain) patch.productResearch = null;
  }
  const currentRole = renderCurrentRole(dossier);
  if (currentRole) patch.currentRole = currentRole;
  const companyFacts = renderCompanyFacts(dossier.company);
  if (companyFacts) patch.companyFacts = companyFacts;
  const formerRoles = renderFormerRoles(dossier);
  if (formerRoles) patch.formerRoles = formerRoles;
  return patch;
}

/** True when the researched role differs from what the payload had. */
export function roleChanged(patch: PersonPayloadPatch): boolean {
  return patch.title !== undefined || patch.company !== undefined;
}

// ---------------------------------------------------------------------------
// Re-judge the person gate on real facts
// ---------------------------------------------------------------------------

export interface RejudgeResult {
  verdict: PersonVerdict | null;
  reason: string | null;
  patch: JsonRecord;
}

/**
 * Re-run the person gate with the current role, the company facts and the
 * bio as role text. Runs when the verdict was missing or `unclear`, or when
 * the role changed. `pass` also refreshes the fit line; `reject` leaves it
 * alone (a reject reason is not a fit reason); `unclear` / `transient` change
 * nothing.
 */
export async function rejudgePerson(input: {
  playName: string;
  payload: JsonRecord;
  patch: PersonPayloadPatch;
  icp: string | null;
  evidence?: string | null;
}): Promise<RejudgeResult> {
  const { payload, patch } = input;
  const dossier = patch.personResearch;
  const verdictBefore = str(payload, "icpVerdict");
  const should =
    dossier.status !== "unavailable" &&
    (!verdictBefore || verdictBefore === "unclear" || roleChanged(patch));
  if (!should) return { verdict: null, reason: null, patch: {} };
  const roleText = [
    patch.currentRole ?? str(payload, "currentRole"),
    patch.companyFacts ?? str(payload, "companyFacts"),
    dossier.bio?.slice(0, 300),
  ]
    .filter((s): s is string => Boolean(s))
    .join(" — ");
  const decision = await qualifyPerson({
    icp: input.icp,
    person: {
      name: str(payload, "name", "founderName", "guestName", "hostName"),
      company: patch.company ?? str(payload, "company"),
      roleText,
      evidence: input.evidence ?? str(payload, "fitReason"),
    },
  });
  if (decision.verdict === "unclear" || decision.verdict === "transient") {
    return { verdict: decision.verdict, reason: decision.reason, patch: {} };
  }
  const out: JsonRecord = { icpVerdict: decision.verdict, icpVerdictReason: decision.reason };
  if (decision.verdict === "pass") {
    const stamped = stampFitReason(
      input.playName,
      { ...payload, ...patch, fitReason: undefined, icpVerdict: "pass" },
      decision.reason,
      "person-gate" satisfies FitReasonSource,
    ) as JsonRecord;
    if (typeof stamped["fitReason"] === "string") {
      out["fitReason"] = stamped["fitReason"];
      out["fitReasonSource"] = stamped["fitReasonSource"];
    }
  }
  return { verdict: decision.verdict, reason: decision.reason, patch: out };
}

// ---------------------------------------------------------------------------
// Apply to a queue row
// ---------------------------------------------------------------------------

export type ApplyOutcome = "patched" | "rejected" | "skipped" | "unavailable";

export interface ApplyPersonResearchOpts {
  rejudge: boolean;
  icp?: string | null;
  remainingUsd: number;
  /** Cost accumulator for the surrounding run. */
  result?: { costUsd: number };
}

/**
 * Write research onto a live queue row. Guarded: `patchLiveQueuePayload`
 * refuses sent and mid-send rows. A pending row the re-judge rejects is
 * rejected as the finder would have (`auto: role — …`, machine); an approved
 * row only gets the verdict stamped and a note — the founder approved it, and
 * the step-0 off-ICP gate holds the send with the reason visible. Never
 * touches `last_draft_json`.
 */
export async function applyPersonResearch(
  ledger: LedgerLike,
  row: ResearchableQueueRow,
  dossier: PersonResearchDossier,
  opts: ApplyPersonResearchOpts,
): Promise<{ outcome: ApplyOutcome; verdict: PersonVerdict | null; patch: JsonRecord }> {
  let payload: JsonRecord;
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    payload = isRecord(parsed) ? parsed : {};
  } catch {
    return { outcome: "skipped", verdict: null, patch: {} };
  }
  if (dossier.status === "unavailable") {
    const ok = ledger.patchLiveQueuePayload({ id: row.id, patch: { personResearch: dossier } });
    if (ok) {
      ledger.setQueueNotes({
        id: row.id,
        notes: [row.notes, `person research unavailable: ${dossier.warning ?? "unknown"}`]
          .filter(Boolean)
          .join(" — "),
      });
    }
    return { outcome: ok ? "unavailable" : "skipped", verdict: null, patch: {} };
  }
  const patch = personPayloadPatch(payload, dossier);
  let verdict: PersonVerdict | null = null;
  let reason: string | null = null;
  if (opts.rejudge) {
    const judged = await rejudgePerson({
      playName: row.play_name,
      payload,
      patch,
      icp: opts.icp === undefined ? resolveIcp() : opts.icp,
      evidence: row.notes,
    });
    verdict = judged.verdict;
    reason = judged.reason;
    Object.assign(patch, judged.patch);
  }
  const ok = ledger.patchLiveQueuePayload({ id: row.id, patch });
  if (!ok) {
    logEvent("person_research.row_not_live", { queue_id: row.id, play: row.play_name });
    return { outcome: "skipped", verdict, patch };
  }
  const merged = { ...payload, ...patch };
  try {
    ledger.setQueuePriority(row.id, safeScorePriority(row.play_name, merged));
  } catch {
    // priority is decoration; never let it fail the research write
  }
  if (patch.productResearch === null) {
    const researched = await researchQueueRowProduct(
      { ...row, payload_json: JSON.stringify(merged) },
      { remainingUsd: opts.remainingUsd },
    );
    if (opts.result) opts.result.costUsd += researched.costUsd;
    ledger.patchLiveQueuePayload({ id: row.id, patch: { productResearch: researched.dossier } });
  }
  if (verdict === "reject") {
    const note = `auto: role — ${(reason ?? "does not fit the ICP").slice(0, 280)}`;
    if (row.status === "pending") {
      ledger.setQueueStatus({ id: row.id, status: "rejected", notes: note });
      return { outcome: "rejected", verdict, patch };
    }
    ledger.setQueueNotes({
      id: row.id,
      notes: [row.notes, `re-judged after research: ${reason ?? "does not fit the ICP"}`]
        .filter(Boolean)
        .join(" — "),
    });
  }
  return { outcome: "patched", verdict, patch };
}

/** The research a row already carries, if any. */
export function personResearchOf(payload: unknown): PersonResearchDossier | null {
  if (!isRecord(payload)) return null;
  const value = payload["personResearch"];
  return isPersonResearchDossier(value) ? value : null;
}

/**
 * Research the people behind the rows a finder just created. Mirror of
 * `researchNewQueueRows`: same own-source filter; skips rows that already
 * carry research, rows whose linked prospect already has a dossier with
 * signal, and rows with nothing to research. Three in flight, a reservation
 * per call against the trigger cap, and a soft wall budget so one slow
 * backend cannot make a finder run look stuck.
 */
export async function researchNewQueueRowPeople(input: {
  afterId: number;
  result: FinderResult;
  maxCostUsd?: number;
  enabled: boolean;
  priorSdkCostUsd?: number;
}): Promise<void> {
  if (!input.enabled) return;
  const ledger = getLedger();
  const ownsSource = (source: string): boolean =>
    source === input.result.source ||
    source.startsWith(`${input.result.source}:`) ||
    input.result.source.startsWith(`${source}:`);
  const rows = ledger
    .listPendingQueueAfterId(input.afterId)
    .filter((row) => ownsSource(row.source));
  const startedAt = Date.now();
  const initialResultCostUsd = input.result.costUsd;
  const icp = resolveIcp();
  let reserved = 0;
  let timedOut = false;
  await parallelMap(rows, 3, async (row) => {
    if (timedOut || Date.now() - startedAt > RUN_BUDGET_MS) {
      if (!timedOut) {
        timedOut = true;
        logEvent("person_research.time_budget_exhausted", { play: row.play_name });
      }
      return;
    }
    let payload: JsonRecord;
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      payload = isRecord(parsed) ? parsed : {};
    } catch {
      return;
    }
    if (personResearchOf(payload)) return;
    if (row.prospect_id != null) {
      const prospect = ledger.getProspectById(row.prospect_id);
      if (prospect && hasDossierSignal(readPersonHalf(prospect.dossier_json))) return;
    }
    const seed = personSeedFor(payload);
    if (!seed) return;
    const spent =
      (input.priorSdkCostUsd ?? initialResultCostUsd) +
      (input.result.costUsd - initialResultCostUsd);
    const remainingUsd = Math.max(
      0,
      (input.maxCostUsd ?? Number.POSITIVE_INFINITY) - spent - reserved,
    );
    if (input.maxCostUsd !== undefined && remainingUsd < RESERVE_USD) return;
    reserved += RESERVE_USD;
    try {
      const researched = await researchPerson({
        seed,
        playName: row.play_name,
        subject: { queueId: row.id },
        remainingUsd,
      });
      input.result.costUsd += researched.costUsd;
      const applied = await applyPersonResearch(ledger, row, researched.dossier, {
        rejudge: true,
        icp,
        remainingUsd: Math.max(0, remainingUsd - researched.costUsd),
        result: input.result,
      });
      logEvent("person_research.row_done", {
        queue_id: row.id,
        play: row.play_name,
        status: researched.dossier.status,
        cached: researched.cached,
        outcome: applied.outcome,
        title_changed: applied.patch["title"] !== undefined,
        company_changed: applied.patch["company"] !== undefined,
        verdict: applied.verdict,
      });
    } finally {
      reserved -= RESERVE_USD;
    }
  });
}

// ---------------------------------------------------------------------------
// Apply to an existing prospect
// ---------------------------------------------------------------------------

export interface ProspectForResearch {
  id: number;
  name: string | null;
  company: string | null;
  email: string | null;
  source: string | null;
  source_profile_url: string | null;
  linkedin_url: string | null;
  dossier_json: string | null;
  title?: string | null;
  icp_verdict?: string | null;
}

/** The seed for a prospect row: profile URL first, else email + name. */
export function personSeedForProspect(p: ProspectForResearch): PersonSeed | null {
  const candidates = [p.source_profile_url, p.linkedin_url];
  const url =
    candidates
      .map(normalizeProfileUrl)
      .find((u): u is string => Boolean(u) && isResearchableUrl(u)) ?? null;
  const email = p.email?.trim().toLowerCase() || null;
  const name = p.name?.trim() || null;
  if (!url && !(email && name)) return null;
  return {
    url,
    email,
    name,
    company: p.company && p.company !== "(unknown)" ? p.company : null,
    title: p.title?.trim() || null,
    domain: null,
  };
}

/**
 * Write research onto a prospect: the person half of `dossier_json` (product
 * half kept, prior enrich record kept under `enrichment`), the `title` /
 * `company` columns corrected, and the ICP verdict re-judged. A `reject` on a
 * prospect with an active cadence stops its follow-ups through the existing
 * off-ICP gate — that is the point.
 */
export async function applyPersonResearchToProspect(
  ledger: LedgerLike,
  prospect: ProspectForResearch,
  dossier: PersonResearchDossier,
  opts: { rejudge: boolean; icp?: string | null; dossierSlice?: number; playName?: string },
): Promise<{
  outcome: "written" | "unavailable";
  verdict: PersonVerdict | null;
  roleChanged: boolean;
}> {
  if (dossier.status === "unavailable")
    return { outcome: "unavailable", verdict: null, roleChanged: false };
  const payload: JsonRecord = {
    ...(prospect.name ? { name: prospect.name } : {}),
    ...(prospect.company ? { company: prospect.company } : {}),
    ...(prospect.title ? { title: prospect.title } : {}),
    ...(prospect.icp_verdict ? { icpVerdict: prospect.icp_verdict } : {}),
  };
  const patch = personPayloadPatch(payload, dossier);
  const merged = mergePersonResearchDossier(prospect.dossier_json, dossier);
  const half = readPersonHalf(merged);
  ledger.mergeProspectDossierHalf(prospect.id, "person", half, opts.dossierSlice);
  if (patch.title !== undefined || patch.company !== undefined) {
    ledger.setProspectCurrentRole(prospect.id, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.company !== undefined ? { company: patch.company } : {}),
    });
  }
  let verdict: PersonVerdict | null = null;
  if (opts.rejudge) {
    const judged = await rejudgePerson({
      playName: opts.playName ?? prospect.source ?? "research-prospects",
      payload,
      patch,
      icp: opts.icp === undefined ? resolveIcp() : opts.icp,
    });
    verdict = judged.verdict;
    if (judged.verdict === "pass" || judged.verdict === "reject") {
      ledger.setProspectIcpVerdict(prospect.id, judged.verdict, judged.reason);
    }
  }
  return { outcome: "written", verdict, roleChanged: roleChanged(patch) };
}
