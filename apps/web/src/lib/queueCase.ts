/**
 * The case column of an open queue row (issue #594): what the priority engine
 * wrote about the prospect, laid out as key–value rows where a reason has a
 * key ("title: Co-Founder & CEO") and as plain lines where it does not
 * ("upcoming event", "2 evidence links").
 *
 * Pure. The engine's reasons are freeform strings (`_priority-adapters.ts`);
 * this only decides how each one sits on the page, never what it says.
 */
import { companyAtFinderFor, personResearchFor, titleAtFinderFor } from "./payloadIdentity.ts";

export interface CaseRow {
  key: string | null;
  value: string;
}

/** A leading `word: ` — one or two short words — is a key; anything else is prose. */
const KEYED = /^([a-z][a-z-]{0,13}(?: [a-z-]{1,13})?):\s+(\S.*)$/i;

export function caseRows(reasons: readonly string[]): CaseRow[] {
  const out: CaseRow[] = [];
  const seen = new Set<string>();
  for (const raw of reasons) {
    const r = raw.trim();
    if (!r || seen.has(r)) continue;
    seen.add(r);
    const m = KEYED.exec(r);
    if (m) out.push({ key: m[1]!.toLowerCase(), value: m[2]! });
    else out.push({ key: null, value: r });
  }
  return out;
}

/** The mono line under "the case": signal · where it came from · when. */
export function caseMeta(parts: ReadonlyArray<string | null | undefined>): string | null {
  const kept = parts.map((p) => p?.trim() ?? "").filter((p) => p.length > 0);
  return kept.length > 0 ? kept.join(" · ") : null;
}

function stringField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * The researched facts about the person, ahead of the engine's reasons:
 * where they are now, what that company is, what the guest list said, and
 * where they were before. Nothing when the row was never researched or the
 * research found nothing.
 */
export function personResearchRows(payload: unknown): CaseRow[] {
  const research = personResearchFor(payload);
  if (!research || research.status === "unavailable") return [];
  const rows: CaseRow[] = [];
  const now =
    stringField(payload, "currentRole") ??
    (research.currentRole
      ? [
          research.currentRole.title
            ? `${research.currentRole.title} at ${research.currentRole.company}`
            : research.currentRole.company,
          research.currentRole.since ? `since ${research.currentRole.since}` : null,
        ]
          .filter(Boolean)
          .join(" ")
      : null);
  if (now) rows.push({ key: "now", value: research.liveProfile ? `${now} · live profile` : now });
  const facts = stringField(payload, "companyFacts");
  if (facts) rows.push({ key: "company", value: facts });
  const listedTitle = titleAtFinderFor(payload);
  const listedCompany = companyAtFinderFor(payload);
  if (listedTitle || listedCompany) {
    rows.push({
      key: "listed as",
      value: [listedTitle, listedCompany].filter(Boolean).join(" · "),
    });
  }
  const formerly = stringField(payload, "formerRoles");
  if (formerly) rows.push({ key: "formerly", value: formerly });
  return rows;
}

export type PersonResearchBadge = "researched" | "researched · regenerate to use it";

/**
 * What the draft state line says about research: `researched` when the draft
 * was written from it, the regenerate hint when the draft predates it or was
 * written while enrichment had failed. Null without usable research.
 */
export function personResearchBadge(
  payload: unknown,
  lastDraft: { draftedAt?: string | null; enrichmentFailed?: boolean } | null | undefined,
): PersonResearchBadge | null {
  const research = personResearchFor(payload);
  if (!research || research.status === "unavailable") return null;
  if (!lastDraft) return "researched";
  // No timestamp on the draft means we cannot show it was written after the
  // research; treat it as stale rather than claim the draft used the facts.
  const stale =
    lastDraft.enrichmentFailed === true ||
    typeof lastDraft.draftedAt !== "string" ||
    lastDraft.draftedAt < research.researchedAt;
  return stale ? "researched · regenerate to use it" : "researched";
}
