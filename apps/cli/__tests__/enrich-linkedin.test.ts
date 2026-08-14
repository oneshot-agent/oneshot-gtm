import { describe, expect, it } from "vitest";
import { cleanCompanyToken, looksLikeRealName } from "../src/commands/enrich-linkedin.ts";

describe("looksLikeRealName", () => {
  it("accepts ordinary two-token names", () => {
    expect(looksLikeRealName("Ada Lovelace")).toBe(true);
    expect(looksLikeRealName("Rich Cuellar-Lopez")).toBe(true);
    expect(looksLikeRealName("J.R. Smith")).toBe(true);
    expect(looksLikeRealName("  Ryan  Walden ")).toBe(true);
  });

  it("rejects the GitHub-handle shapes that dominate repo-interest", () => {
    // Every one of these is a real unresolved name from the ledger — searching
    // them costs ~$0.01 for a near-certain miss.
    expect(looksLikeRealName("yijin840")).toBe(false);
    expect(looksLikeRealName("AAAlexander")).toBe(false);
    expect(looksLikeRealName("Demin")).toBe(false);
    expect(looksLikeRealName("麦奇")).toBe(false);
  });

  it("rejects names whose tokens aren't Latin script", () => {
    expect(looksLikeRealName("张 伟")).toBe(false);
    expect(looksLikeRealName("Ada 麦奇")).toBe(false);
  });

  it("rejects empty and degenerate input", () => {
    expect(looksLikeRealName(null)).toBe(false);
    expect(looksLikeRealName(undefined)).toBe(false);
    expect(looksLikeRealName("")).toBe(false);
    expect(looksLikeRealName("   ")).toBe(false);
    expect(looksLikeRealName("A B")).toBe(false); // under the length floor
  });

  it("rejects tokens starting with a digit or symbol", () => {
    expect(looksLikeRealName("123 456")).toBe(false);
    expect(looksLikeRealName("-foo bar")).toBe(false);
  });
});

describe("cleanCompanyToken", () => {
  it("passes through an ordinary company name", () => {
    expect(cleanCompanyToken("Voight AI")).toBe("Voight AI");
    expect(cleanCompanyToken("  STARGA, Inc.  ")).toBe("STARGA");
  });

  it("strips the GitHub org sigil", () => {
    // LinkedIn writes "iFood", never "@iFood" — the sigil alone would make the
    // quoted token unmatchable.
    expect(cleanCompanyToken("@Corvux-Systems")).toBe("Corvux-Systems");
  });

  it("takes the employer out of a job-title string", () => {
    expect(cleanCompanyToken("Software Enginneer at @iFood")).toBe("iFood");
  });

  it("keeps only the first segment of a multi-role string", () => {
    expect(cleanCompanyToken("Co-Founder/CTO @ Floramis | Product @ Vilota")).toBe("Floramis");
  });

  it("drops a trailing URL parenthetical", () => {
    expect(cleanCompanyToken("Avanse Financial Services Ltd (https://www.avanse.com)")).toBe(
      "Avanse Financial Services Ltd",
    );
  });

  it("returns null for free text that can't work as an exact-match token", () => {
    expect(cleanCompanyToken("Open to Work 😎")).toBeNull();
    expect(cleanCompanyToken("National Laboratory of the Rockies")).toBeNull();
    expect(
      cleanCompanyToken("@StakeTechnology @vuesion @hoola-inc @Sabhi-org @This-is-Ample"),
    ).toBeNull();
  });

  it("returns null for empty and placeholder values", () => {
    expect(cleanCompanyToken(null)).toBeNull();
    expect(cleanCompanyToken(undefined)).toBeNull();
    expect(cleanCompanyToken("   ")).toBeNull();
    expect(cleanCompanyToken("(unknown)")).toBeNull();
    expect(cleanCompanyToken("X")).toBeNull();
  });
});
