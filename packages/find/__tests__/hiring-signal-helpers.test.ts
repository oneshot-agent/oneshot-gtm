import { describe, expect, it } from "vitest";
import {
  DEFAULT_JOB_SITES,
  isAtsUrl,
  isJobBoardUrl,
  normalizeSites,
  parseHiringSignalExtract,
  pickCorporateHost,
  slugFallback,
} from "../src/hiring-signal.ts";

describe("isAtsUrl", () => {
  it("recognizes the four built-in ATS hosts", () => {
    expect(isAtsUrl("https://boards.greenhouse.io/acme/jobs/123")).toBe(true);
    expect(isAtsUrl("https://jobs.lever.co/acme/abc")).toBe(true);
    expect(isAtsUrl("https://apply.workable.com/acme/j/xyz")).toBe(true);
    expect(isAtsUrl("https://jobs.ashbyhq.com/acme/def")).toBe(true);
    expect(isAtsUrl("https://ashbyhq.com/acme/def")).toBe(true);
  });

  it("treats sub-subdomains of ATS hosts as ATS URLs", () => {
    // `endsWith(.${h})` catches deeper subdomains like `foo.ashbyhq.com`.
    expect(isAtsUrl("https://foo.ashbyhq.com/acme/def")).toBe(true);
  });

  it("rejects non-ATS hosts and garbage", () => {
    expect(isAtsUrl("https://acme.com/careers")).toBe(false);
    expect(isAtsUrl("::::not-a-url::::")).toBe(false);
  });

  it("knows YC's Work at a Startup board", () => {
    expect(isAtsUrl("https://www.workatastartup.com/jobs/106818")).toBe(true);
  });
});

describe("sites: which boards a trigger searches", () => {
  it("defaults to the four ATS hosts and normalizes what a founder types", () => {
    expect(normalizeSites(undefined)).toEqual([...DEFAULT_JOB_SITES]);
    expect(
      normalizeSites([" https://www.WorkAtAStartup.com/jobs ", "workatastartup.com", "", 42, null]),
    ).toEqual(["workatastartup.com"]);
    // An all-invalid list falls back rather than aborting the run.
    expect(normalizeSites([7, {}])).toEqual([...DEFAULT_JOB_SITES]);
  });

  it("accepts hits only from the searched boards", () => {
    const yc = ["workatastartup.com"];
    expect(isJobBoardUrl("https://www.workatastartup.com/jobs/106818", yc)).toBe(true);
    expect(isJobBoardUrl("https://boards.greenhouse.io/acme/jobs/1", yc)).toBe(false);
    expect(isJobBoardUrl("https://boards.greenhouse.io/acme/jobs/1", DEFAULT_JOB_SITES)).toBe(true);
    expect(isJobBoardUrl("https://foo.ashbyhq.com/x", ["ashbyhq.com"])).toBe(true);
    expect(isJobBoardUrl("::::", yc)).toBe(false);
  });

  it("never mistakes the YC board for the company's own domain", () => {
    expect(
      pickCorporateHost("https://www.workatastartup.com/companies/intelligence-factory"),
    ).toBeNull();
  });
});

describe("pickCorporateHost", () => {
  it("returns the bare host for a corporate URL, stripping www.", () => {
    expect(pickCorporateHost("https://WWW.Acme.com/about")).toBe("acme.com");
    expect(pickCorporateHost("https://blog.acme.com/x")).toBe("blog.acme.com");
  });

  it("returns null for social / ATS hosts", () => {
    expect(pickCorporateHost("https://linkedin.com/in/someone")).toBeNull();
    expect(pickCorporateHost("https://boards.greenhouse.io/x")).toBeNull();
    expect(pickCorporateHost("https://x.com/someone")).toBeNull();
    expect(pickCorporateHost("https://www.crunchbase.com/org/acme")).toBeNull();
  });

  it("returns null for subdomains of social hosts", () => {
    expect(pickCorporateHost("https://careers.linkedin.com/jobs/123")).toBeNull();
  });

  it("returns null on null, undefined, garbage", () => {
    expect(pickCorporateHost(null)).toBeNull();
    expect(pickCorporateHost(undefined)).toBeNull();
    expect(pickCorporateHost("::::")).toBeNull();
  });
});

describe("slugFallback", () => {
  it("takes the first URL path segment as a plausible domain", () => {
    expect(slugFallback("https://boards.greenhouse.io/acme/jobs/123")).toBe("acme.com");
    expect(slugFallback("https://jobs.lever.co/foo-bar/xyz")).toBe("foo-bar.com");
  });

  it("returns null when the first segment isn't a plausible slug", () => {
    expect(slugFallback("https://boards.greenhouse.io/ACME%20Corp/123")).toBeNull();
    expect(slugFallback("https://example.com/")).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    expect(slugFallback("not a url at all")).toBeNull();
  });
});

describe("parseHiringSignalExtract", () => {
  it("parses a complete extract", () => {
    const raw = JSON.stringify({
      jobTitle: "Staff Engineer",
      jobUrl: "https://boards.greenhouse.io/acme/jobs/1",
      company: "Acme",
      companyDomain: "acme.com",
      hiringManagerName: "Sam Jones",
      hiringManagerRole: "VP Engineering",
      team: "Platform",
      postedAt: "2026-04-01",
      summary: "hiring for the platform team",
    });
    const out = parseHiringSignalExtract(raw);
    expect(out.company).toBe("Acme");
    expect(out.hiringManagerName).toBe("Sam Jones");
  });

  it("returns an all-null extract for garbage", () => {
    const out = parseHiringSignalExtract("nope");
    expect(out.jobTitle).toBeNull();
    expect(out.company).toBeNull();
    expect(out.hiringManagerName).toBeNull();
  });
});
