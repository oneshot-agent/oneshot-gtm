import { describe, expect, it } from "vitest";
import {
  isDudDomain,
  looksLikeUserHandle,
  shouldSkipFindEmail,
} from "../src/_findemail-prescreen.ts";

describe("isDudDomain", () => {
  it("flags exact-match free-tier subdomains", () => {
    expect(isDudDomain("vercel.app")).toBe(true);
    expect(isDudDomain("netlify.app")).toBe(true);
    expect(isDudDomain("github.io")).toBe(true);
    expect(isDudDomain("herokuapp.com")).toBe(true);
  });

  it("flags subdomains of free-tier hosts", () => {
    expect(isDudDomain("foo.vercel.app")).toBe(true);
    expect(isDudDomain("staging.foo.vercel.app")).toBe(true);
    expect(isDudDomain("alice.github.io")).toBe(true);
    expect(isDudDomain("my-app.fly.dev")).toBe(true);
  });

  it("flags personal email providers", () => {
    expect(isDudDomain("gmail.com")).toBe(true);
    expect(isDudDomain("outlook.com")).toBe(true);
    expect(isDudDomain("proton.me")).toBe(true);
  });

  it("flags social + content hosts", () => {
    expect(isDudDomain("twitter.com")).toBe(true);
    expect(isDudDomain("x.com")).toBe(true);
    expect(isDudDomain("linkedin.com")).toBe(true);
    expect(isDudDomain("medium.com")).toBe(true);
    expect(isDudDomain("dev.to")).toBe(true);
    expect(isDudDomain("notion.so")).toBe(true);
  });

  it("flags code hosts (bare)", () => {
    expect(isDudDomain("github.com")).toBe(true);
    expect(isDudDomain("gist.github.com")).toBe(true);
    expect(isDudDomain("gitlab.com")).toBe(true);
  });

  it("strips leading www. before matching", () => {
    expect(isDudDomain("www.gmail.com")).toBe(true);
    expect(isDudDomain("WWW.VERCEL.APP")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isDudDomain("Vercel.App")).toBe(true);
    expect(isDudDomain("FOO.GITHUB.IO")).toBe(true);
  });

  it("passes real company domains", () => {
    expect(isDudDomain("usebidflow.com")).toBe(false);
    expect(isDudDomain("stripe.com")).toBe(false);
    expect(isDudDomain("acme.dev")).toBe(false);
    expect(isDudDomain("anthropic.com")).toBe(false);
    // Tricky: a company whose name LOOKS like one of our blocklist hosts.
    expect(isDudDomain("vercelite.com")).toBe(false);
    expect(isDudDomain("not-twitter.com")).toBe(false);
  });

  it("treats null / empty / whitespace as dud (no signal)", () => {
    expect(isDudDomain(null)).toBe(true);
    expect(isDudDomain(undefined)).toBe(true);
    expect(isDudDomain("")).toBe(true);
    expect(isDudDomain("   ")).toBe(true);
  });

  it("strips scheme + path so a full URL still matches the blocklist", () => {
    // Callers should pass bare hostnames, but defense-in-depth catches
    // accidental URL passthrough from a misused helper.
    expect(isDudDomain("https://foo.vercel.app/about")).toBe(true);
    expect(isDudDomain("http://news.ycombinator.com/item?id=42")).toBe(true);
    expect(isDudDomain("https://github.com")).toBe(true);
    expect(isDudDomain("https://acme.dev/team")).toBe(false);
  });

  it("strips trailing dots (DNS-rooted form)", () => {
    expect(isDudDomain("vercel.app.")).toBe(true);
    expect(isDudDomain("foo.github.io.")).toBe(true);
    expect(isDudDomain("acme.dev.")).toBe(false);
  });

  it("flags the newly added investor / aggregator hosts", () => {
    expect(isDudDomain("crunchbase.com")).toBe(true);
    expect(isDudDomain("producthunt.com")).toBe(true);
    expect(isDudDomain("wellfound.com")).toBe(true);
    expect(isDudDomain("news.ycombinator.com")).toBe(true);
    expect(isDudDomain("discord.gg")).toBe(true);
  });
});

describe("looksLikeUserHandle", () => {
  it("flags single-token handles", () => {
    expect(looksLikeUserHandle("samaralihussain")).toBe(true);
    expect(looksLikeUserHandle("ynarwal__")).toBe(true);
    expect(looksLikeUserHandle("user_123")).toBe(true);
    expect(looksLikeUserHandle("dev-name")).toBe(true);
  });

  it("passes multi-word real names", () => {
    expect(looksLikeUserHandle("Sam Jones")).toBe(false);
    expect(looksLikeUserHandle("Samar Ali Hussain")).toBe(false);
    expect(looksLikeUserHandle("Jean-Claude Van Damme")).toBe(false);
  });

  it("passes single-word names with a period", () => {
    expect(looksLikeUserHandle("Sam J. Jones")).toBe(false);
    expect(looksLikeUserHandle("Dr. House")).toBe(false);
  });

  it("flags single-token names like Madonna (accepted false positive)", () => {
    // Documented tradeoff: a real single-name reads as a handle. Acceptable
    // vs the volume of HN-style usernames the heuristic catches.
    expect(looksLikeUserHandle("Madonna")).toBe(true);
    expect(looksLikeUserHandle("Sting")).toBe(true);
  });

  it("flags null / empty / whitespace", () => {
    expect(looksLikeUserHandle(null)).toBe(true);
    expect(looksLikeUserHandle(undefined)).toBe(true);
    expect(looksLikeUserHandle("")).toBe(true);
    expect(looksLikeUserHandle("   ")).toBe(true);
  });

  it("flags single tokens containing only [a-z0-9_-]", () => {
    expect(looksLikeUserHandle("abc123")).toBe(true);
    expect(looksLikeUserHandle("Abc-Def_Ghi")).toBe(true);
  });

  it("passes tokens with characters outside [a-z0-9_-] (likely real)", () => {
    // Apostrophes, accents, etc. read as real names; let the SDK try.
    expect(looksLikeUserHandle("O'Brien")).toBe(false);
    expect(looksLikeUserHandle("Müller")).toBe(false);
  });
});

describe("shouldSkipFindEmail", () => {
  it("returns ok:true for a real domain + real name", () => {
    expect(shouldSkipFindEmail({ fullName: "Sam Jones", companyDomain: "acme.dev" })).toEqual({
      ok: true,
    });
  });

  it("returns no-domain when companyDomain is null / empty", () => {
    expect(shouldSkipFindEmail({ fullName: "Sam Jones", companyDomain: null })).toEqual({
      ok: false,
      reason: "no-domain",
    });
    expect(shouldSkipFindEmail({ fullName: "Sam Jones", companyDomain: "" })).toEqual({
      ok: false,
      reason: "no-domain",
    });
    expect(shouldSkipFindEmail({ fullName: "Sam Jones", companyDomain: "   " })).toEqual({
      ok: false,
      reason: "no-domain",
    });
  });

  it("returns dud-domain when companyDomain is on the blocklist", () => {
    const out = shouldSkipFindEmail({
      fullName: "Sam Jones",
      companyDomain: "foo.vercel.app",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/^dud-domain: foo\.vercel\.app/);
  });

  it("returns no-fullname when fullName is missing / empty even with a real domain", () => {
    expect(shouldSkipFindEmail({ fullName: null, companyDomain: "acme.dev" })).toEqual({
      ok: false,
      reason: "no-fullname",
    });
    expect(shouldSkipFindEmail({ fullName: "", companyDomain: "acme.dev" })).toEqual({
      ok: false,
      reason: "no-fullname",
    });
    expect(shouldSkipFindEmail({ companyDomain: "acme.dev" })).toEqual({
      ok: false,
      reason: "no-fullname",
    });
  });

  it("returns handle-not-name when fullName looks like a username", () => {
    const out = shouldSkipFindEmail({
      fullName: "samaralihussain",
      companyDomain: "acme.dev",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/^handle-not-name: samaralihussain/);
  });

  it("dud-domain dominates handle-not-name when both apply", () => {
    // We surface the domain reason first because the domain check is
    // more decisive — fixing the name wouldn't make the call succeed.
    const out = shouldSkipFindEmail({
      fullName: "samaralihussain",
      companyDomain: "github.io",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/^dud-domain/);
  });
});
