import { describe, expect, it } from "vitest";
import {
  dedupeRecordsBySlug,
  interleaveByCohort,
  normalizeCohorts,
  pickAdapter,
} from "../src/accelerator-batch.ts";
import {
  buildCohortQueries,
  looksLikeAcceleratorNoise,
  parseAcceleratorLaunchExtract,
  sanitizeCompanyDomain,
} from "../src/_accelerator-search-adapter.ts";
import { cohortToBatchSlug, deriveCohortLabel, mapYcOssCompany } from "../src/_yc-oss-adapter.ts";
import type { CompanyRecord } from "../src/_types.ts";

describe("cohortToBatchSlug", () => {
  it("maps short YC tags to yc-oss slugs", () => {
    expect(cohortToBatchSlug("yc-w26")).toBe("winter-2026");
    expect(cohortToBatchSlug("yc-s25")).toBe("summer-2025");
    expect(cohortToBatchSlug("yc-w24")).toBe("winter-2024");
    expect(cohortToBatchSlug("yc-f25")).toBe("fall-2025");
  });

  it("maps long-form YC tags (yc-spring-26, yc-fall-25)", () => {
    expect(cohortToBatchSlug("yc-spring-26")).toBe("spring-2026");
    expect(cohortToBatchSlug("yc-fall-25")).toBe("fall-2025");
    expect(cohortToBatchSlug("yc-winter-24")).toBe("winter-2024");
  });

  it("handles 4-digit-year long-form variants (yc-winter-2026)", () => {
    expect(cohortToBatchSlug("yc-winter-2026")).toBe("winter-2026");
    expect(cohortToBatchSlug("yc-summer-2025")).toBe("summer-2025");
  });

  it("passes through already-resolved yc-oss slugs", () => {
    expect(cohortToBatchSlug("winter-2026")).toBe("winter-2026");
    expect(cohortToBatchSlug("summer-2024")).toBe("summer-2024");
  });

  it("is case-insensitive on input", () => {
    expect(cohortToBatchSlug("YC-W26")).toBe("winter-2026");
    expect(cohortToBatchSlug("Winter-2026")).toBe("winter-2026");
  });

  it("returns null for unknown patterns", () => {
    expect(cohortToBatchSlug("")).toBeNull();
    expect(cohortToBatchSlug("techstars-toronto-2025")).toBeNull();
    expect(cohortToBatchSlug("yc-2026")).toBeNull(); // missing season
    expect(cohortToBatchSlug("yc-z26")).toBeNull(); // unknown season letter
  });
});

describe("mapYcOssCompany", () => {
  it("maps a well-formed yc-oss record to CompanyRecord", () => {
    const record = mapYcOssCompany({
      name: "Bidflow",
      website: "https://usebidflow.com",
      one_liner: "AI Copilot for Electrical Estimating",
      long_description: "We help electrical contractors do estimates faster.",
      industry: "Real Estate and Construction",
      tags: ["SaaS", "AI Assistant"],
      url: "https://www.ycombinator.com/companies/bidflow",
    });
    expect(record).not.toBeNull();
    expect(record!.name).toBe("Bidflow");
    expect(record!.website).toBe("https://usebidflow.com");
    expect(record!.tags).toEqual(["SaaS", "AI Assistant"]);
    expect(record!.ycUrl).toBe("https://www.ycombinator.com/companies/bidflow");
    expect(record!.source).toBe("yc-oss");
  });

  it("returns null for records without a usable name", () => {
    expect(mapYcOssCompany({})).toBeNull();
    expect(mapYcOssCompany({ name: "" })).toBeNull();
    expect(mapYcOssCompany({ name: "   " })).toBeNull();
  });

  it("nulls missing optional string fields rather than passing empty strings", () => {
    const record = mapYcOssCompany({ name: "Acme" });
    expect(record!.website).toBeNull();
    expect(record!.oneLiner).toBeNull();
    expect(record!.longDescription).toBeNull();
    expect(record!.industry).toBeNull();
    expect(record!.tags).toEqual([]);
    expect(record!.ycUrl).toBeNull();
  });

  it("filters non-string entries out of the tags array", () => {
    const record = mapYcOssCompany({ name: "Acme", tags: ["SaaS", 42, null, "AI"] });
    expect(record!.tags).toEqual(["SaaS", "AI"]);
  });
});

describe("pickAdapter", () => {
  it("auto-picks yc-oss for yc-* cohort tags", () => {
    expect(pickAdapter("yc-w26")).toBe("yc-oss");
    expect(pickAdapter("yc-s25")).toBe("yc-oss");
    expect(pickAdapter("YC-W26")).toBe("yc-oss"); // case-insensitive
  });

  it("falls back to websearch for non-YC cohorts", () => {
    expect(pickAdapter("techstars-toronto-2025")).toBe("websearch");
    expect(pickAdapter("antler-nyc-q1-2026")).toBe("websearch");
    expect(pickAdapter("500-global-batch-32")).toBe("websearch");
  });

  it("honors an explicit override", () => {
    expect(pickAdapter("yc-w26", "websearch")).toBe("websearch");
    expect(pickAdapter("techstars-toronto-2025", "yc-oss")).toBe("yc-oss");
  });

  it("ignores nonsense overrides", () => {
    // unknown override values fall through to the default heuristic
    expect(pickAdapter("yc-w26", "garbage")).toBe("yc-oss");
  });
});

describe("buildCohortQueries", () => {
  it("returns three complementary queries from a label", () => {
    const queries = buildCohortQueries("YC W26");
    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain('"YC W26"');
    expect(queries.some((q) => q.includes("portfolio"))).toBe(true);
    expect(queries.some((q) => q.includes("demo day"))).toBe(true);
    expect(queries.some((q) => q.includes("launch"))).toBe(true);
  });

  it("returns [] for empty / whitespace labels", () => {
    expect(buildCohortQueries("")).toEqual([]);
    expect(buildCohortQueries("   ")).toEqual([]);
  });
});

describe("looksLikeAcceleratorNoise", () => {
  it("blocks social-media root pages", () => {
    expect(looksLikeAcceleratorNoise("https://twitter.com/somefounder")).toBe(true);
    expect(looksLikeAcceleratorNoise("https://www.linkedin.com/in/somebody")).toBe(true);
    expect(looksLikeAcceleratorNoise("https://x.com/yc")).toBe(true);
  });

  it("blocks news aggregators that rarely host per-company pages", () => {
    expect(looksLikeAcceleratorNoise("https://news.ycombinator.com/item?id=123")).toBe(true);
    expect(looksLikeAcceleratorNoise("https://techcrunch.com/2026/04/01/yc-w26")).toBe(true);
  });

  it("allows legitimate company / accelerator URLs", () => {
    expect(looksLikeAcceleratorNoise("https://www.ycombinator.com/companies/bidflow")).toBe(false);
    expect(looksLikeAcceleratorNoise("https://usebidflow.com")).toBe(false);
    expect(looksLikeAcceleratorNoise("https://www.techstars.com/portfolio/somecorp")).toBe(false);
  });

  it("blocks URLs that don't parse", () => {
    expect(looksLikeAcceleratorNoise("not a url")).toBe(true);
    expect(looksLikeAcceleratorNoise("")).toBe(true);
  });
});

describe("parseAcceleratorLaunchExtract", () => {
  it("returns the parsed object when JSON is valid", () => {
    const raw = JSON.stringify({
      company: "Acme",
      companyDomain: "acme.dev",
      oneLiner: "does X",
      founderName: "Jane Doe",
      founderRole: "CEO",
      launchUrl: "https://example.com/launch",
    });
    const out = parseAcceleratorLaunchExtract(raw);
    expect(out.company).toBe("Acme");
    expect(out.companyDomain).toBe("acme.dev");
    expect(out.founderName).toBe("Jane Doe");
  });

  it("falls back to all-null fields on garbage", () => {
    const out = parseAcceleratorLaunchExtract("not json at all");
    expect(out).toEqual({
      company: null,
      companyDomain: null,
      oneLiner: null,
      founderName: null,
      founderRole: null,
      launchUrl: null,
      linkedinUrl: null,
      phone: null,
    });
  });

  it("handles fenced JSON blocks (LLM markdown wrapping)", () => {
    const raw = '```json\n{"company":"Acme","companyDomain":"acme.dev"}\n```';
    const out = parseAcceleratorLaunchExtract(raw);
    expect(out.company).toBe("Acme");
  });
});

describe("sanitizeCompanyDomain", () => {
  it("returns a clean bare host for already-clean input", () => {
    expect(sanitizeCompanyDomain("foo.com")).toBe("foo.com");
    expect(sanitizeCompanyDomain("acme.dev")).toBe("acme.dev");
    expect(sanitizeCompanyDomain("usebidflow.com")).toBe("usebidflow.com");
  });

  it("strips scheme + leading www", () => {
    expect(sanitizeCompanyDomain("https://www.foo.com")).toBe("foo.com");
    expect(sanitizeCompanyDomain("http://foo.com")).toBe("foo.com");
    expect(sanitizeCompanyDomain("WWW.FOO.COM")).toBe("foo.com");
  });

  it("strips paths + query + fragment + port", () => {
    expect(sanitizeCompanyDomain("foo.com/about")).toBe("foo.com");
    expect(sanitizeCompanyDomain("foo.com?ref=x")).toBe("foo.com");
    expect(sanitizeCompanyDomain("foo.com#hash")).toBe("foo.com");
    expect(sanitizeCompanyDomain("foo.com:8080")).toBe("foo.com");
    expect(sanitizeCompanyDomain("https://www.foo.com/path?q=1#h")).toBe("foo.com");
  });

  it("rejects non-domain strings", () => {
    expect(sanitizeCompanyDomain(null)).toBeNull();
    expect(sanitizeCompanyDomain("")).toBeNull();
    expect(sanitizeCompanyDomain("   ")).toBeNull();
    expect(sanitizeCompanyDomain("not a domain")).toBeNull();
    expect(sanitizeCompanyDomain("nodothere")).toBeNull();
  });

  it("trims trailing dots and whitespace", () => {
    expect(sanitizeCompanyDomain("  foo.com.  ")).toBe("foo.com");
  });
});

describe("deriveCohortLabel", () => {
  it("preserves canonical YC short tags as 'YC W26' / 'YC S25'", () => {
    expect(deriveCohortLabel("yc-w26")).toBe("YC W26");
    expect(deriveCohortLabel("yc-s25")).toBe("YC S25");
    expect(deriveCohortLabel("YC-W26")).toBe("YC W26");
  });

  it("title-cases generic tags with hyphen separators", () => {
    expect(deriveCohortLabel("techstars-toronto-2025")).toBe("Techstars Toronto 2025");
    expect(deriveCohortLabel("antler-nyc-q1-2026")).toBe("Antler Nyc Q1 2026");
  });

  it("keeps yc as 'YC' in long-form variants", () => {
    expect(deriveCohortLabel("yc-winter-2026")).toBe("YC Winter 2026");
    expect(deriveCohortLabel("yc-spring-26")).toBe("YC Spring 26");
  });

  it("returns empty string for empty input", () => {
    expect(deriveCohortLabel("")).toBe("");
    expect(deriveCohortLabel("   ")).toBe("");
  });
});

describe("normalizeCohorts", () => {
  it("returns the explicit cohorts list verbatim when present", () => {
    const list = [
      { cohort: "yc-w26", cohortLabel: "YC W26" },
      { cohort: "techstars-spring-2026", cohortLabel: "Techstars Spring 2026" },
    ];
    expect(normalizeCohorts({ cohorts: list })).toEqual(list);
  });

  it("wraps legacy single-cohort opts and derives a label when none was set", () => {
    expect(normalizeCohorts({ cohort: "yc-w26" })).toEqual([
      { cohort: "yc-w26", cohortLabel: "YC W26" },
    ]);
  });

  it("uses an explicit legacy cohortLabel when set", () => {
    expect(normalizeCohorts({ cohort: "yc-w26", cohortLabel: "Custom Label" })).toEqual([
      { cohort: "yc-w26", cohortLabel: "Custom Label" },
    ]);
  });

  it("trims whitespace from legacy single-cohort input", () => {
    expect(normalizeCohorts({ cohort: "  yc-w26  " })).toEqual([
      { cohort: "yc-w26", cohortLabel: "YC W26" },
    ]);
  });

  it("prefers `cohorts` over the legacy single-cohort fields when both are set", () => {
    const cohorts = [{ cohort: "yc-w26", cohortLabel: "YC W26" }];
    expect(normalizeCohorts({ cohorts, cohort: "yc-f25", cohortLabel: "YC F25" })).toEqual(cohorts);
  });

  it("trims whitespace from each cohorts[] entry and fills missing labels", () => {
    const out = normalizeCohorts({
      cohorts: [
        { cohort: "  yc-w26  ", cohortLabel: "" },
        { cohort: "techstars-spring-2026", cohortLabel: "  Techstars Spring 2026  " },
      ],
    });
    expect(out).toEqual([
      { cohort: "yc-w26", cohortLabel: "YC W26" },
      { cohort: "techstars-spring-2026", cohortLabel: "Techstars Spring 2026" },
    ]);
  });

  it("drops malformed cohorts[] entries (empty / non-string tags)", () => {
    const out = normalizeCohorts({
      cohorts: [
        { cohort: "yc-w26", cohortLabel: "YC W26" },
        { cohort: "", cohortLabel: "blank" },
        { cohort: "   ", cohortLabel: "whitespace" },
        // @ts-expect-error — runtime guard
        { cohort: 42, cohortLabel: "wrong type" },
        { cohort: "yc-f25", cohortLabel: "YC F25" },
      ],
    });
    expect(out).toEqual([
      { cohort: "yc-w26", cohortLabel: "YC W26" },
      { cohort: "yc-f25", cohortLabel: "YC F25" },
    ]);
  });

  it("falls through to legacy fields when every cohorts[] entry is malformed", () => {
    const out = normalizeCohorts({
      cohorts: [{ cohort: "", cohortLabel: "blank" }],
      cohort: "yc-w26",
    });
    expect(out).toEqual([{ cohort: "yc-w26", cohortLabel: "YC W26" }]);
  });

  it("throws when neither field supplies any cohort", () => {
    expect(() => normalizeCohorts({})).toThrow();
    expect(() => normalizeCohorts({ cohorts: [] })).toThrow();
    expect(() => normalizeCohorts({ cohort: "   " })).toThrow();
    expect(() => normalizeCohorts({ cohorts: [{ cohort: "", cohortLabel: "x" }] })).toThrow();
  });
});

describe("interleaveByCohort", () => {
  it("round-robins records across cohorts (one per cohort, then next)", () => {
    const records = [
      { name: "A1", cohort: "a" },
      { name: "A2", cohort: "a" },
      { name: "A3", cohort: "a" },
      { name: "B1", cohort: "b" },
      { name: "B2", cohort: "b" },
      { name: "C1", cohort: "c" },
    ];
    const out = interleaveByCohort(records);
    expect(out.map((r) => r.name)).toEqual(["A1", "B1", "C1", "A2", "B2", "A3"]);
  });

  it("preserves first-seen cohort order across the rotation", () => {
    const records = [
      { name: "X1", cohort: "techstars-spring-2026" },
      { name: "Y1", cohort: "yc-w26" },
      { name: "X2", cohort: "techstars-spring-2026" },
      { name: "Y2", cohort: "yc-w26" },
    ];
    const out = interleaveByCohort(records);
    expect(out.map((r) => r.name)).toEqual(["X1", "Y1", "X2", "Y2"]);
  });

  it("preserves input order within a single cohort", () => {
    const records = [
      { name: "A1", cohort: "a" },
      { name: "A2", cohort: "a" },
      { name: "A3", cohort: "a" },
    ];
    expect(interleaveByCohort(records).map((r) => r.name)).toEqual(["A1", "A2", "A3"]);
  });

  it("returns [] for empty input", () => {
    expect(interleaveByCohort([])).toEqual([]);
  });

  it("never loses or duplicates records", () => {
    const records = [
      { name: "A1", cohort: "a" },
      { name: "A2", cohort: "a" },
      { name: "B1", cohort: "b" },
      { name: "C1", cohort: "c" },
      { name: "C2", cohort: "c" },
      { name: "C3", cohort: "c" },
    ];
    const out = interleaveByCohort(records);
    expect(out).toHaveLength(records.length);
    expect(new Set(out.map((r) => r.name))).toEqual(new Set(records.map((r) => r.name)));
  });
});

const makeRecord = (name: string, extra: Partial<CompanyRecord> = {}): CompanyRecord => ({
  name,
  website: null,
  oneLiner: null,
  longDescription: null,
  industry: null,
  tags: [],
  ycUrl: null,
  founderName: null,
  founderLinkedinUrl: null,
  founderPhone: null,
  source: "yc-oss",
  ...extra,
});

describe("dedupeRecordsBySlug", () => {
  it("keeps the first occurrence when the same company appears twice", () => {
    const records = [makeRecord("Acme"), makeRecord("Beta"), makeRecord("Acme")];
    const out = dedupeRecordsBySlug(records);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.name)).toEqual(["Acme", "Beta"]);
  });

  it("collapses spacing / case variants of the same name", () => {
    const records = [makeRecord("Acme Inc"), makeRecord("ACME  inc"), makeRecord("acme-inc")];
    const out = dedupeRecordsBySlug(records);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("Acme Inc");
  });

  it("preserves extension fields on the kept record (generic)", () => {
    type Tagged = CompanyRecord & { cohort: string };
    const records: Tagged[] = [
      { ...makeRecord("Acme"), cohort: "yc-w26" },
      { ...makeRecord("Acme"), cohort: "yc-f25" },
    ];
    const out = dedupeRecordsBySlug(records);
    expect(out).toHaveLength(1);
    expect(out[0]!.cohort).toBe("yc-w26");
  });

  it("returns [] for empty input", () => {
    expect(dedupeRecordsBySlug([])).toEqual([]);
  });
});
