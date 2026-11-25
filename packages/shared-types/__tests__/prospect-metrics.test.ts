import { describe, expect, it } from "vitest";
import {
  companySizeLabel,
  companySizeOf,
  isRoleGroup,
  isSizeBucket,
  matchesProspectMetrics,
  payloadMatchesMetrics,
  payloadTitleOf,
  roleGroupOf,
  sizeBucketsOf,
} from "../src/index.ts";

describe("roleGroupOf", () => {
  it.each([
    ["Co-Founder & COO", "operations"],
    ["VP of Operations and Integration", "operations"],
    ["Vice President Operations", "operations"],
    ["Vice-President of Operations", "operations"],
    ["Senior Vice-President", "other"],
    ["Chief Operations Officer", "operations"],
    ["Regional Practice Manager", "operations"],
    ["Director of Strategic Operations", "operations"],
    ["Chief Digital Officer", "technology"],
    ["Chief Information Officer", "technology"],
    ["VP, Digital Transformation", "technology"],
    ["Director of IT", "technology"],
    ["VP Engineering", "technology"],
    ["Vice President of Artificial Intelligence", "technology"],
    ["Head of Machine Learning", "technology"],
    ["Head of Developer Experience", "technology"],
    ["Regional Director", "operations"],
    ["Director of Revenue Cycle Management", "finance"],
    ["Chief Financial Officer", "finance"],
    ["President at Aesthetic Dentistry", "leader"],
    ["CEO", "leader"],
    ["Owner", "leader"],
    ["Founder & CEO", "leader"],
    ["Head of Growth", "other"],
    ["", "other"],
    [null, "other"],
  ] as const)("%s is %s", (title, group) => {
    expect(roleGroupOf(title)).toBe(group);
  });

  it("never reads a word inside another as a role", () => {
    // "it" inside "Recruiting", "coo" inside "Coordinator"
    expect(roleGroupOf("Recruiting Coordinator")).toBe("other");
  });
});

describe("companySizeOf", () => {
  it("reads staff from research and locations from siteCount", () => {
    expect(
      companySizeOf({ siteCount: 3, personResearch: { company: { employeeCount: 131 } } }),
    ).toEqual({ staff: 131, sites: 3 });
  });

  it("falls back to the low end of a size range", () => {
    expect(companySizeOf({ personResearch: { company: { size: "51-250" } } })).toEqual({
      staff: 51,
    });
    expect(companySizeOf({ personResearch: { company: { size: "10001+" } } })).toEqual({
      staff: 10001,
    });
    expect(companySizeOf({ personResearch: { company: { size: "1,001-5,000" } } })).toEqual({
      staff: 1001,
    });
  });

  it("is empty when neither is known", () => {
    expect(companySizeOf({ company: "Acme" })).toEqual({});
    expect(companySizeOf(null)).toEqual({});
    expect(companySizeOf({ siteCount: 0, personResearch: { company: { size: "" } } })).toEqual({});
  });
});

describe("sizeBucketsOf", () => {
  it("puts a company in one bucket per count it has", () => {
    expect(sizeBucketsOf({ staff: 131, sites: 3 })).toEqual(["staff:51-200", "sites:2-5"]);
    expect(sizeBucketsOf({ staff: 50 })).toEqual(["staff:1-50"]);
    expect(sizeBucketsOf({ staff: 1000 })).toEqual(["staff:201-1000"]);
    expect(sizeBucketsOf({ staff: 1001 })).toEqual(["staff:1000+"]);
    expect(sizeBucketsOf({ sites: 1 })).toEqual(["sites:1"]);
    expect(sizeBucketsOf({ sites: 21 })).toEqual(["sites:21+"]);
  });

  it("is unknown with no count", () => {
    expect(sizeBucketsOf({})).toEqual(["unknown"]);
  });
});

describe("filter helpers", () => {
  it("validates keys", () => {
    expect(isRoleGroup("operations")).toBe(true);
    expect(isRoleGroup("ops")).toBe(false);
    expect(isSizeBucket("staff:1000+")).toBe(true);
    expect(isSizeBucket("big")).toBe(false);
  });

  it("matches on every set field", () => {
    const size = { staff: 131, sites: 3 };
    expect(matchesProspectMetrics({}, "CEO", size)).toBe(true);
    expect(matchesProspectMetrics({ role: "leader" }, "CEO", size)).toBe(true);
    expect(matchesProspectMetrics({ role: "operations" }, "CEO", size)).toBe(false);
    expect(matchesProspectMetrics({ role: "leader", size: "sites:2-5" }, "CEO", size)).toBe(true);
    expect(matchesProspectMetrics({ size: "unknown" }, "CEO", size)).toBe(false);
    expect(matchesProspectMetrics({ size: "unknown" }, "CEO", {})).toBe(true);
  });

  it("reads a payload's title and size", () => {
    const payload = { title: "COO", siteCount: 4 };
    expect(payloadTitleOf(payload)).toBe("COO");
    expect(payloadTitleOf({ currentRole: "Chief Operating Officer at Shore Lake Dental" })).toBe(
      "Chief Operating Officer at Shore Lake Dental",
    );
    expect(payloadTitleOf({ title: " " })).toBeNull();
    expect(payloadMatchesMetrics({ role: "operations", size: "sites:2-5" }, payload)).toBe(true);
    expect(payloadMatchesMetrics({ role: "leader" }, payload)).toBe(false);
    expect(payloadMatchesMetrics({}, null)).toBe(true);
  });

  it("labels the counts", () => {
    expect(companySizeLabel({ staff: 1310, sites: 3 })).toBe("1,310 staff · 3 locations");
    expect(companySizeLabel({ sites: 1 })).toBe("1 location");
    expect(companySizeLabel({})).toBeNull();
  });
});
