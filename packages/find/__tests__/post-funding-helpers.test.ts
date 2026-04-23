import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectUrls,
  deriveIndustryHint,
  isLikelyFundingUrl,
  normalizeUrl,
  parsePostFundingExtract,
} from "../src/post-funding.ts";

describe("normalizeUrl", () => {
  it("strips the fragment and round-trips a valid URL", () => {
    expect(normalizeUrl("https://techcrunch.com/foo#share")).toBe("https://techcrunch.com/foo");
  });

  it("returns null on garbage", () => {
    expect(normalizeUrl("not a url")).toBeNull();
  });

  it("preserves the querystring", () => {
    expect(normalizeUrl("https://techcrunch.com/foo?utm=x")).toBe(
      "https://techcrunch.com/foo?utm=x",
    );
  });
});

describe("isLikelyFundingUrl", () => {
  it("matches known funding-news hosts regardless of title text", () => {
    expect(isLikelyFundingUrl("https://techcrunch.com/2026/04/acme-seed")).toBe(true);
    expect(isLikelyFundingUrl("https://news.techcrunch.com/x")).toBe(true);
    expect(isLikelyFundingUrl("https://crunchbase.com/org/acme")).toBe(true);
  });

  it("matches unknown hosts when the title/description mentions a round", () => {
    expect(
      isLikelyFundingUrl("https://indie.blog/acme", "Acme raises $5M Series A", undefined),
    ).toBe(true);
    expect(
      isLikelyFundingUrl("https://indie.blog/acme", undefined, "Seed round led by Sequoia"),
    ).toBe(true);
  });

  it("rejects unknown hosts without funding vocabulary", () => {
    expect(isLikelyFundingUrl("https://indie.blog/acme", "launching our site", "we ship")).toBe(
      false,
    );
  });

  it("returns false for a malformed URL", () => {
    expect(isLikelyFundingUrl("::::not-a-url::::", "series a", undefined)).toBe(false);
  });
});

describe("deriveIndustryHint", () => {
  it("falls back to 'startup' when ICP is null or empty", () => {
    expect(deriveIndustryHint(null)).toBe("startup");
    expect(deriveIndustryHint("")).toBe("startup");
  });

  it("drops stopwords and keeps the content keywords", () => {
    const hint = deriveIndustryHint("developer tools for backend engineers at fintech startups");
    // "developer" and "engineer" are stopwords; "tools", "backend", "fintech", "startups" survive.
    expect(hint.split(" ").length).toBeLessThanOrEqual(4);
    expect(hint).toContain("fintech");
    expect(hint).not.toContain("engineers");
    expect(hint).not.toContain("developer");
  });

  it("keeps at most four keywords", () => {
    const hint = deriveIndustryHint(
      "climate risk analytics insurance actuarial catastrophe modeling reinsurance",
    );
    expect(hint.split(" ")).toHaveLength(4);
  });
});

describe("parsePostFundingExtract", () => {
  it("parses a fenced json block", () => {
    const raw = [
      "```json",
      JSON.stringify({
        company: "Acme",
        companyDomain: "acme.dev",
        round: "Seed",
        amountUsd: 5_000_000,
        leadInvestor: "Sequoia",
        founderName: "Sam",
        founderRole: "CEO",
        industry: "fintech",
        summary: "did the thing",
      }),
      "```",
    ].join("\n");
    expect(parsePostFundingExtract(raw)).toEqual({
      company: "Acme",
      companyDomain: "acme.dev",
      round: "Seed",
      amountUsd: 5_000_000,
      leadInvestor: "Sequoia",
      founderName: "Sam",
      founderRole: "CEO",
      industry: "fintech",
      summary: "did the thing",
    });
  });

  it("recovers from leading/trailing prose by slicing to the outer braces", () => {
    const raw = `Sure! Here's the json: {"company":"Acme","companyDomain":"acme.dev","round":"Seed","amountUsd":null,"leadInvestor":null,"founderName":"Sam","founderRole":null,"industry":null,"summary":null} hope this helps.`;
    const out = parsePostFundingExtract(raw);
    expect(out.company).toBe("Acme");
    expect(out.founderName).toBe("Sam");
  });

  it("returns a fully-null extract when nothing parseable is present", () => {
    const out = parsePostFundingExtract("nope");
    expect(out.company).toBeNull();
    expect(out.founderName).toBeNull();
    expect(out.amountUsd).toBeNull();
  });
});

describe("collectUrls", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("returns inline sourceUrls de-duplicated", () => {
    const urls = collectUrls({
      dryRun: true,
      sourceUrls: ["https://a.com/x", "https://a.com/x", "https://b.com/y"],
    });
    expect(urls.toSorted()).toEqual(["https://a.com/x", "https://b.com/y"]);
  });

  it("reads a source file, skipping comments/blank lines/non-URLs", () => {
    const dir = mkdtempSync(join(tmpdir(), "oneshot-gtm-pf-"));
    tmps.push(dir);
    const file = join(dir, "urls.txt");
    writeFileSync(
      file,
      ["# a comment", "", "https://a.com/x", "not a url", "https://b.com/y", ""].join("\n"),
    );
    const urls = collectUrls({ dryRun: true, sourceUrlsFile: file });
    expect(urls).toContain("https://a.com/x");
    expect(urls).toContain("https://b.com/y");
    expect(urls).not.toContain("not a url");
    expect(urls.filter((u) => u.includes("comment"))).toHaveLength(0);
  });

  it("returns an empty array when given nothing", () => {
    expect(collectUrls({ dryRun: true })).toEqual([]);
  });
});
