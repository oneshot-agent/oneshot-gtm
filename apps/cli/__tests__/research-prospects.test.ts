import { describe, expect, it } from "vitest";
import {
  bounded,
  hasSignal,
  parseScopes,
  researchUrl,
  resolveCap,
} from "../src/commands/research-prospects.ts";

// Pure helpers for the paid dossier backfill. Every one of these guards spend:
// a mis-parsed scope, an unclamped limit, or a signal-less payload each mean
// either buying rows we didn't intend to or storing a dossier that says nothing.

describe("parseScopes", () => {
  it("defaults to the three scopes that change behaviour", () => {
    expect(parseScopes(undefined)).toEqual(["active", "replied", "unjudged"]);
    expect(parseScopes("  ")).toEqual(["active", "replied", "unjudged"]);
  });

  it("parses, trims, lowercases and dedupes", () => {
    expect(parseScopes(" Active , replied ,active ")).toEqual(["active", "replied"]);
  });

  it("REJECTS an unknown scope rather than silently ignoring it", () => {
    // Dropping a typo'd scope would quietly change which rows a paid run buys.
    expect(() => parseScopes("active,activve")).toThrow(/unknown --scope/);
    expect(() => parseScopes("everything")).toThrow(/Valid: active, replied, unjudged, all/);
  });
});

describe("resolveCap", () => {
  it("passes a sane limit through and floors it", () => {
    expect(resolveCap(250)).toBe(250);
    expect(resolveCap(7.9)).toBe(7);
  });

  it("never WIDENS a paid run on bad input", () => {
    expect(resolveCap(undefined)).toBeUndefined();
    expect(resolveCap(Number.NaN)).toBe(0);
    expect(resolveCap(-5)).toBe(0);
  });
});

describe("researchUrl", () => {
  it("prefers source_profile_url when it is a researchable profile", () => {
    expect(
      researchUrl({
        source_profile_url: "https://github.com/rishibanota",
        linkedin_url: "https://linkedin.com/in/x",
      }),
    ).toBe("https://github.com/rishibanota");
  });

  it("skips a non-profile source_profile_url in favour of LinkedIn", () => {
    // The bug this fixes: luma-events stamps a `luma.com/user/<handle>` page as
    // source_profile_url. For someone who hosts no events its whole content is
    // "Nothing Here, Yet", so deepResearchPerson burned a call and returned
    // nothing while a perfectly good LinkedIn URL sat in the next column.
    // 68 prospects were in exactly this state.
    expect(
      researchUrl({
        source_profile_url: "https://luma.com/user/rnq",
        linkedin_url: "https://www.linkedin.com/in/raunaqbose",
      }),
    ).toBe("https://www.linkedin.com/in/raunaqbose");
  });

  it("still returns a non-profile URL when there is nothing better", () => {
    // Worse than a social profile, but strictly more than an email alone.
    expect(
      researchUrl({ source_profile_url: "https://luma.com/user/rnq", linkedin_url: null }),
    ).toBe("https://luma.com/user/rnq");
  });

  it("treats x.com and twitter.com as researchable too", () => {
    expect(
      researchUrl({ source_profile_url: "https://x.com/rnq", linkedin_url: "https://li.com/in/x" }),
    ).toBe("https://x.com/rnq");
  });

  it("falls back to linkedin_url, else null", () => {
    expect(researchUrl({ source_profile_url: null, linkedin_url: "https://li.com/in/x" })).toBe(
      "https://li.com/in/x",
    );
    expect(researchUrl({ source_profile_url: "  ", linkedin_url: null })).toBeNull();
    expect(researchUrl({ source_profile_url: null, linkedin_url: null })).toBeNull();
  });
});

describe("bounded — the person half must stay mergeable", () => {
  it("passes a normal payload through untouched", () => {
    const payload = { title: "CTO", company: "xevall" };
    expect(bounded(payload)).toBe(payload);
  });

  it("degrades an oversized payload to sliced text, which still reads as signal", () => {
    const huge = { summary: "x".repeat(20_000) };
    const result = bounded(huge);
    expect(typeof result).toBe("string");
    // Slicing the MERGED wrapper would have produced invalid JSON and taken the
    // product half down with it; slicing the person half keeps it parseable.
    expect(hasSignal(result)).toBe(true);
  });
});

describe("hasSignal", () => {
  it("accepts a payload that actually says something, flat or nested", () => {
    expect(hasSignal({ title: "Graduate Teaching Assistant" })).toBe(true);
    expect(hasSignal({ enrichment: { company: "Acme" } })).toBe(true);
    expect(hasSignal({ experience: [{ title: "CTO" }] })).toBe(true);
    expect(hasSignal({ articles: [{ title: "x" }] })).toBe(true);
  });

  it("rejects an empty payload — storing it would poison the Tier-1 read", () => {
    expect(hasSignal({ enrichment: {}, articles: [] })).toBe(false);
    expect(hasSignal({})).toBe(false);
    expect(hasSignal(undefined)).toBe(false);
    expect(hasSignal(null)).toBe(false);
  });

  it("rejects a full key set whose values are all empty", () => {
    // What a real lookup returns when it finds nothing: every key present,
    // every value null. Counting keys would call this a hit.
    expect(
      hasSignal({
        email: "a@b.c",
        title: null,
        company: null,
        summary: "",
        experience: [],
        education: [],
        skills: [],
        enrichment: { title: null, company: null, summary: "", experience: [] },
      }),
    ).toBe(false);
  });

  it("rejects a location-only dossier — it grounds nothing but would still block Tier-2", () => {
    expect(hasSignal({ location: "United States", summary: "" })).toBe(false);
  });

  it("rejects the role-based-mailbox placeholder — a fact about the inbox, not the person", () => {
    expect(hasSignal({ summary: "hi@niklasfrick.com is a role based email address." })).toBe(false);
    expect(hasSignal({ enrichment: { summary: "hi@avi.mn is a role based email address." } })).toBe(
      false,
    );
  });
});
