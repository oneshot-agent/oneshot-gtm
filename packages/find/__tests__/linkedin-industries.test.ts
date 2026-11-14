import { describe, expect, it } from "vitest";
import { canonicalIndustries, LINKEDIN_INDUSTRIES } from "../src/linkedin-industries.ts";

describe("canonicalIndustries", () => {
  it("sends LinkedIn's spelling whatever the case, spacing or ampersand", () => {
    expect(
      canonicalIndustries([
        "manufacturing",
        " truck  transportation ",
        "media and telecommunications",
      ]),
    ).toEqual({
      industries: ["Manufacturing", "Truck Transportation", "Media & Telecommunications"],
      unknown: [],
    });
    expect(canonicalIndustries(["hospitals & health care"]).industries).toEqual([
      "Hospitals and Health Care",
    ]);
  });

  it("keeps a name LinkedIn does not have, and reports it", () => {
    expect(canonicalIndustries(["freight", "Insurance", "", "insurance"])).toEqual({
      industries: ["freight", "Insurance"],
      unknown: ["freight"],
    });
  });

  it("holds no two names that differ only in case or punctuation", () => {
    const keys = LINKEDIN_INDUSTRIES.map((n) =>
      n
        .toLowerCase()
        .replace(/\s*&\s*/g, " and ")
        .replace(/[\s,]+/g, " "),
    );
    expect(new Set(keys).size).toBe(LINKEDIN_INDUSTRIES.length);
  });
});
