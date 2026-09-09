/**
 * Angle selection for `yourEdge` (issue #584).
 *
 * An edge may hold several `//`-separated angles. Until this module, all of
 * them went into the writing prompt and the model picked one inside a
 * 100-word writing task — and on every independent call it reached for the
 * most writable angle. Measured on a live ledger: 25 of 30 accelerator-batch
 * drafts and 26 of 36 luma-events drafts on a single angle, with three of
 * luma's six never used once. Same failure the admission beat already names
 * (`admissionBlock`): a model cannot hold a distribution across independent
 * calls, so the decision lives HERE, before the prompt sees anything.
 *
 * The choice is a small isolated classifier call — fit is what the design was
 * reaching for, and asking for it in isolation is what stops the collapse —
 * cached per (prospect, edge) so a regenerate makes the same decision instead
 * of flapping, and a second draft costs nothing. A one-angle edge never calls
 * anything and reaches the prompt byte-identical to before.
 *
 * Everything here fails open: a classifier error, an out-of-range answer, or a
 * ledger double without the cache methods falls back to a stable per-prospect
 * hash (the `admissionSlot` shape). A draft is never blocked by selection.
 */
import { getLedger, logEvent } from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";

export const ANGLE_SEPARATOR = "//";
/** Cache namespace inside `product_research_cache` — a keyed JSON cache with a TTL read, which is exactly what a verdict needs. */
const CACHE_PREFIX = "angle-choice:";
/** A verdict outlives any cadence; the edge text changing is the real invalidation (it's in the key). */
const CACHE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const CLASSIFIER_MAX_TOKENS = 120;

/** The two field names an edge travels under. `hiring-signal` says `yourClaim`. */
export const EDGE_FIELDS = ["yourEdge", "yourClaim"] as const;
export type EdgeField = (typeof EDGE_FIELDS)[number];

/** Split an edge into its angles: trimmed, empties dropped. A plain edge is one angle. */
export function splitEdgeAngles(edge: string | null | undefined): string[] {
  if (!edge) return [];
  return edge
    .split(ANGLE_SEPARATOR)
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

/** Which edge field this target carries, if any. */
export function edgeFieldOf(target: object): EdgeField | null {
  for (const key of EDGE_FIELDS) {
    const v = (target as Record<string, unknown>)[key];
    if (typeof v === "string" && v.trim().length > 0) return key;
  }
  return null;
}

/** Stable 32-bit string hash — same construction as `admissionSlot`. */
function hash32(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/** Short stable key for an edge's text, so a rewritten edge is a different cache entry. */
export function edgeKey(edge: string): string {
  return hash32(edge.trim()).toString(36);
}

/** Deterministic fallback pick: the prospect's hash spread across the angles not excluded. */
export function hashPick(prospectKey: string, count: number, excludeIndex: number | null): number {
  const candidates = Array.from({ length: count }, (_, i) => i).filter((i) => i !== excludeIndex);
  if (candidates.length === 0) return 0;
  return candidates[hash32(prospectKey.trim().toLowerCase()) % candidates.length]!;
}

export interface AngleSelection {
  /** 0-based index into `splitEdgeAngles(edge)`. */
  index: number;
  angle: string;
  count: number;
  method: "single" | "cached" | "classifier" | "hash";
}

export interface SelectAngleInput {
  edge: string;
  /** Stable identity for the prospect — the email, lowercased by the callee. */
  prospectKey: string;
  /** What the classifier judges fit from: the person, not just the trigger's signal. */
  description: string;
  /** The intro's index, when choosing for a follow-up. */
  excludeIndex?: number | null;
  playName?: string;
}

function cacheKeyFor(input: SelectAngleInput, excludeIndex: number | null): string {
  const who = input.prospectKey.trim().toLowerCase();
  return `${CACHE_PREFIX}${who}:${edgeKey(input.edge)}:${excludeIndex ?? "-"}`;
}

/** Ledger reads/writes are best-effort: test doubles and older ledgers may lack them. */
function readCached(key: string): number | null {
  try {
    const raw = getLedger().getProductResearchCache(key, CACHE_MAX_AGE_MS);
    if (!raw) return null;
    const parsed = tryParseJsonObject<{ index?: unknown }>(raw, {});
    return typeof parsed.index === "number" ? parsed.index : null;
  } catch {
    return null;
  }
}
function writeCached(key: string, index: number, method: string): void {
  try {
    getLedger().setProductResearchCache(key, JSON.stringify({ index, method }));
  } catch {
    /* fail open */
  }
}

/**
 * Pick the angle for this prospect. Never throws; never returns an index the
 * caller can't use.
 */
export async function selectAngle(input: SelectAngleInput): Promise<AngleSelection> {
  const angles = splitEdgeAngles(input.edge);
  if (angles.length === 0) return { index: 0, angle: "", count: 0, method: "single" };
  if (angles.length === 1) return { index: 0, angle: angles[0]!, count: 1, method: "single" };

  const exclude =
    input.excludeIndex != null && input.excludeIndex >= 0 && input.excludeIndex < angles.length
      ? input.excludeIndex
      : null;
  const key = cacheKeyFor(input, exclude);
  const cached = readCached(key);
  if (cached != null && cached >= 0 && cached < angles.length && cached !== exclude) {
    return { index: cached, angle: angles[cached]!, count: angles.length, method: "cached" };
  }

  let index: number | null = null;
  try {
    index = await classify(angles, input.description, exclude);
  } catch (err) {
    logEvent(
      "angle.select_failed",
      { play: input.playName ?? null, message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
  }
  const method: AngleSelection["method"] = index == null ? "hash" : "classifier";
  if (index == null) index = hashPick(input.prospectKey, angles.length, exclude);
  writeCached(key, index, method);
  return { index, angle: angles[index]!, count: angles.length, method };
}

/** One tiny call: the angles, the prospect, an index back. Anything unusable → null. */
async function classify(
  angles: string[],
  description: string,
  exclude: number | null,
): Promise<number | null> {
  const system = loadPrompt("angle-select");
  const user = [
    "ANGLES:",
    ...angles.map((a, i) => `${i + 1}. ${a}`),
    "",
    "PROSPECT:",
    description.trim() || "(nothing known beyond name and email)",
    ...(exclude != null ? ["", `EXCLUDE: ${exclude + 1} (already used in the first email)`] : []),
  ].join("\n");
  const res = await complete({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
    maxTokens: CLASSIFIER_MAX_TOKENS,
  });
  const parsed = tryParseJsonObject<{ index?: unknown }>(res.content, {});
  const n = typeof parsed.index === "number" ? parsed.index : Number(parsed.index);
  if (!Number.isInteger(n)) return null;
  const idx = n - 1;
  if (idx < 0 || idx >= angles.length || idx === exclude) return null;
  return idx;
}

/** Keys that are identifiers, URLs, or the edge itself — not evidence of who the prospect is. */
const NOT_EVIDENCE = new Set<string>([
  ...EDGE_FIELDS,
  "email",
  "phone",
  "name",
  "linkedinUrl",
  "launchUrl",
  "eventUrl",
  "evidenceUrl",
  "url",
  "sourceProfileUrl",
  "dedupeKey",
  "icpVerdictReason",
]);

/**
 * The PROSPECT block the classifier judges from — built generically from the
 * target's short string fields (company, product one-liner, title, bio, event,
 * repo, stack, cohort…) so every play gets the person, not only its trigger
 * signal, without each play def naming its fields. Optionally the head of the
 * dossier `prepare` assembled.
 */
export function describeTargetForAngle(target: object, dossier?: string | null): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(target as Record<string, unknown>)) {
    if (NOT_EVIDENCE.has(k) || /url$/i.test(k)) continue;
    if (typeof v !== "string") continue;
    const val = v.replace(/\s+/g, " ").trim();
    if (!val || val.length > 240) continue;
    lines.push(`${k}: ${val}`);
  }
  const head = dossier?.replace(/\s+/g, " ").trim();
  if (head) lines.push(`research: ${head.slice(0, 600)}`);
  return lines.join("\n");
}

/** A shallow copy of the target with its edge field replaced by the single chosen angle. */
export function withSelectedAngle<T>(target: T, field: EdgeField, angle: string): T {
  return { ...(target as object), [field]: angle } as T;
}

/**
 * The angle a follow-up should be built on: a different one from the intro's.
 * Recovers the edge from the intro's sent queue row (whichever path sent it),
 * reads the intro's cached pick for that (prospect, edge), and selects among
 * the rest. Null — and therefore no block — when the intro carried no
 * multi-angle edge, or the ledger can't answer (test doubles, older rows).
 */
export async function followUpEdgeAngle(
  prospect: { email: string | null },
  playName: string,
): Promise<string | null> {
  const email = prospect.email?.trim();
  if (!email) return null;
  let payload: Record<string, unknown> | null = null;
  try {
    payload = getLedger().latestSentQueuePayload(playName, email);
  } catch {
    return null;
  }
  if (!payload) return null;
  const field = edgeFieldOf(payload);
  if (!field) return null;
  const edge = payload[field] as string;
  if (splitEdgeAngles(edge).length < 2) return null;
  const intro = readCached(cacheKeyFor({ edge, prospectKey: email, description: "" }, null));
  const sel = await selectAngle({
    edge,
    prospectKey: email,
    description: describeTargetForAngle(payload),
    excludeIndex: intro,
    playName,
  });
  return sel.angle;
}

/**
 * YOUR EDGE block for a follow-up (issue #584): a DIFFERENT angle from the
 * intro's, so the follow-up has new material instead of being a bump. Null
 * when the play's sent row carries no multi-angle edge — byte-identical
 * output to before.
 */
export function followUpEdgeBlock(angle: string | null): string | null {
  if (!angle?.trim()) return null;
  return [
    "YOUR EDGE (a different angle from the first email — the new information this follow-up is built on; never re-use the first email's angle, never mention that other angles exist):",
    angle.trim(),
  ].join("\n");
}
