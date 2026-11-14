import { describe, expect, it } from "vitest";
import {
  canonicalIndustries,
  industryKey,
  LINKEDIN_INDUSTRIES,
} from "../src/linkedin-industries.ts";

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

  it("reads a long run of spaces in linear time", () => {
    const started = performance.now();
    expect(industryKey(`a${" ".repeat(50_000)}b`)).toBe("a b");
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("keeps a name LinkedIn does not have, and reports it", () => {
    expect(canonicalIndustries(["freight", "Insurance", "", "insurance"])).toEqual({
      industries: ["freight", "Insurance"],
      unknown: ["freight"],
    });
  });

  it("holds no two names that differ only in case or punctuation", () => {
    const keys = LINKEDIN_INDUSTRIES.map(industryKey);
    expect(new Set(keys).size).toBe(LINKEDIN_INDUSTRIES.length);
  });
});
