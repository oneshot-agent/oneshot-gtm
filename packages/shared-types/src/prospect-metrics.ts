/**
 * Role group and company size of a prospect, read from what a queue row
 * already carries: the person's title, and the company's staff count (person
 * research) or location count (the local-business finder). The Queue and
 * Calls views filter on these.
 */

export const ROLE_GROUPS = [
  { key: "leader", label: "Leader (CEO, founder, owner)" },
  { key: "operations", label: "Operations" },
  { key: "technology", label: "Technology & digital" },
  { key: "finance", label: "Finance & revenue" },
  { key: "other", label: "Other" },
] as const;

export type RoleGroup = (typeof ROLE_GROUPS)[number]["key"];

export function isRoleGroup(value: unknown): value is RoleGroup {
  return ROLE_GROUPS.some((g) => g.key === value);
}

export const SIZE_BUCKETS = [
  { key: "staff:1-50", label: "1–50 staff", kind: "staff", min: 1, max: 50 },
  { key: "staff:51-200", label: "51–200 staff", kind: "staff", min: 51, max: 200 },
  { key: "staff:201-1000", label: "201–1,000 staff", kind: "staff", min: 201, max: 1000 },
  { key: "staff:1000+", label: "Over 1,000 staff", kind: "staff", min: 1001, max: Infinity },
  { key: "sites:1", label: "1 location", kind: "sites", min: 1, max: 1 },
  { key: "sites:2-5", label: "2–5 locations", kind: "sites", min: 2, max: 5 },
  { key: "sites:6-20", label: "6–20 locations", kind: "sites", min: 6, max: 20 },
  { key: "sites:21+", label: "21+ locations", kind: "sites", min: 21, max: Infinity },
  { key: "unknown", label: "Size unknown", kind: "unknown", min: 0, max: 0 },
] as const;

export type SizeBucket = (typeof SIZE_BUCKETS)[number]["key"];

export function isSizeBucket(value: unknown): value is SizeBucket {
  return SIZE_BUCKETS.some((b) => b.key === value);
}

/** Long forms folded to the short word, as `packages/find/src/_titles.ts` does. */
const ROLE_ALIASES: Array<[RegExp, string]> = [
  [/\b(?:senior|executive|assistant|associate) vice[ -]president\b/g, "vp"],
  [/\bvice[ -]president\b/g, "vp"],
  [/\b(?:svp|evp|avp)\b/g, "vp"],
  [/\bchief executive officer\b/g, "ceo"],
  [/\bchief operating officer\b|\bchief operations officer\b/g, "coo"],
  [/\bchief financial officer\b/g, "cfo"],
  [/\bchief technology officer\b/g, "cto"],
  [/\bchief information officer\b/g, "cio"],
  [/\bchief digital officer\b/g, "cdo"],
  [/\bco-founder\b|\bcofounder\b/g, "founder"],
  [/\bartificial intelligence\b/g, "ai"],
  [/\bmachine learning\b/g, "ml"],
];

const TECHNOLOGY =
  /\b(?:cto|cio|cdo|ciso|digital|transformation|innovation|it|technology|technologies|engineering|information|informatics|software|data|ai|genai|ml|developer)\b/;
const FINANCE = /\b(?:cfo|finance|financial|revenue|controller|billing|accounting|treasurer)\b/;
const OPERATIONS =
  /\b(?:coo|operations|operating|operational|integration|practice manager|general manager|office manager|clinic manager|regional director|business manager)\b/;
const LEADER =
  /\b(?:ceo|founder|owner|president|managing partner|managing director|principal|chairman|chair)\b/;

/**
 * The job function a title names. Function wins over rank: a co-founder who
 * is COO is operations, a vice president of IT is technology; a title that
 * names only rank (CEO, president, owner) is a leader. A missing or
 * unreadable title is "other".
 */
export function roleGroupOf(title: string | null | undefined): RoleGroup {
  let text = ` ${(title ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, " ")} `;
  for (const [pattern, short] of ROLE_ALIASES) text = text.replace(pattern, short);
  if (TECHNOLOGY.test(text)) return "technology";
  if (FINANCE.test(text)) return "finance";
  if (OPERATIONS.test(text)) return "operations";
  // "vp" before "president" was folded above, so a bare president is the top role.
  if (LEADER.test(text)) return "leader";
  return "other";
}

export interface CompanySize {
  staff?: number;
  sites?: number;
}

function positive(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value.replace(/,/g, "")) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/** The low end of a range such as "51-250", "10001+" or "1,001-5,000". */
function rangeFloor(value: unknown): number | undefined {
  if (typeof value !== "string") return positive(value);
  const match = /(\d[\d,]*)/.exec(value);
  return match ? positive(match[1]) : undefined;
}

/**
 * Staff and location counts a queue payload carries: staff from person
 * research's company (its count, else the low end of its size range), and
 * locations from `siteCount`, which the local-business finder writes.
 */
export function companySizeOf(payload: unknown): CompanySize {
  if (!payload || typeof payload !== "object") return {};
  const p = payload as Record<string, unknown>;
  const research = p.personResearch as Record<string, unknown> | undefined;
  const company = research?.company as Record<string, unknown> | undefined;
  const staff = positive(company?.employeeCount) ?? rangeFloor(company?.size);
  const sites = positive(p.siteCount);
  return { ...(staff ? { staff } : {}), ...(sites ? { sites } : {}) };
}

/** The size buckets a company falls in: one per count it has, or "unknown". */
export function sizeBucketsOf(size: CompanySize): SizeBucket[] {
  const out: SizeBucket[] = [];
  for (const b of SIZE_BUCKETS) {
    if (b.kind === "unknown") continue;
    const n = b.kind === "staff" ? size.staff : size.sites;
    if (n != null && n >= b.min && n <= b.max) out.push(b.key);
  }
  return out.length > 0 ? out : ["unknown"];
}

/** "131 staff · 3 locations", or null when neither is known. */
export function companySizeLabel(size: CompanySize): string | null {
  const parts: string[] = [];
  if (size.staff) parts.push(`${size.staff.toLocaleString("en-US")} staff`);
  if (size.sites) parts.push(`${size.sites} location${size.sites === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** A filter on role group and size; an unset field matches every row. */
export interface ProspectMetricFilter {
  role?: RoleGroup;
  size?: SizeBucket;
}

/**
 * The person's title on a queue payload: `title`, else `jobTitle`, else the
 * title of research's current role (never the rendered "X at Company" line,
 * whose employer name could read as a role).
 */
export function payloadTitleOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const research = p.personResearch as { currentRole?: { title?: unknown } } | undefined;
  for (const v of [p.title, p.jobTitle, research?.currentRole?.title]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Whether a queue payload passes the filter. */
export function payloadMatchesMetrics(filter: ProspectMetricFilter, payload: unknown): boolean {
  if (!filter.role && !filter.size) return true;
  return matchesProspectMetrics(filter, payloadTitleOf(payload), companySizeOf(payload));
}

export function matchesProspectMetrics(
  filter: ProspectMetricFilter,
  title: string | null | undefined,
  size: CompanySize,
): boolean {
  if (filter.role && roleGroupOf(title) !== filter.role) return false;
  if (filter.size && !sizeBucketsOf(size).includes(filter.size)) return false;
  return true;
}
