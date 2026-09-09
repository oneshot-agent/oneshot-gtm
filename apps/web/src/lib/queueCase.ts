/**
 * The case column of an open queue row (issue #594): what the priority engine
 * wrote about the prospect, laid out as key–value rows where a reason has a
 * key ("title: Co-Founder & CEO") and as plain lines where it does not
 * ("upcoming event", "2 evidence links").
 *
 * Pure. The engine's reasons are freeform strings (`_priority-adapters.ts`);
 * this only decides how each one sits on the page, never what it says.
 */
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
