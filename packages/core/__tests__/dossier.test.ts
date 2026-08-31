import { describe, expect, it } from "vitest";
import { hasDossierSignal } from "../src/dossier.ts";

// The gate that decides whether a dossier is worth writing to
// prospects.dossier_json. It is load-bearing: _reply-research.ts treats any
// non-empty value as a free Tier-1 hit and skips paid research, so a
// contentless dossier is worse than no dossier at all.

describe("hasDossierSignal — real payloads that must be REJECTED", () => {
  it("rejects a failed enrich, which still serializes to a non-empty object", () => {
    // What standardEnrich stores when safeEnrich fails. A bare .trim() check
    // passes this, stores it, and suppresses the reply drafter's paid tiers.
    expect(hasDossierSignal(JSON.stringify({ status: "failed", profile: null, cost: 0 }))).toBe(
      false,
    );
    expect(hasDossierSignal({ status: "failed", profile: null, cost: 0 })).toBe(false);
  });

  it("rejects a person lookup that found nobody — full key set, empty values", () => {
    expect(
      hasDossierSignal({
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

  it("rejects the role-based-mailbox placeholder — a fact about the inbox", () => {
    expect(hasDossierSignal({ summary: "hi@niklasfrick.com is a role based email address." })).toBe(
      false,
    );
    expect(
      hasDossierSignal({ enrichment: { summary: "hi@avi.mn is a role based email address." } }),
    ).toBe(false);
  });

  it("rejects a location-only dossier — grounds nothing, still blocks Tier-2", () => {
    expect(hasDossierSignal({ location: "United States", summary: "" })).toBe(false);
  });

  it("rejects blank and missing values", () => {
    expect(hasDossierSignal(null)).toBe(false);
    expect(hasDossierSignal(undefined)).toBe(false);
    expect(hasDossierSignal("")).toBe(false);
    expect(hasDossierSignal("   ")).toBe(false);
    expect(hasDossierSignal({})).toBe(false);
    expect(hasDossierSignal("{}")).toBe(false);
    expect(hasDossierSignal(42)).toBe(false);
  });

  it("rejects a failure even when it carries other keys", () => {
    expect(hasDossierSignal({ status: "FAILED", title: "CTO" })).toBe(false);
  });
});

describe("hasDossierSignal — payloads that must be ACCEPTED", () => {
  it("accepts real content, flat or nested", () => {
    expect(hasDossierSignal({ title: "Graduate Teaching Assistant" })).toBe(true);
    expect(hasDossierSignal({ enrichment: { company: "Acme" } })).toBe(true);
    expect(hasDossierSignal({ profile: { title: "Staff Engineer" } })).toBe(true);
    expect(hasDossierSignal({ result: { enrichment: { bio: "builds agent infra" } } })).toBe(true);
  });

  it("accepts non-empty list fields and articles", () => {
    expect(hasDossierSignal({ experience: [{ title: "CTO" }] })).toBe(true);
    expect(hasDossierSignal({ skills: ["rust"] })).toBe(true);
    expect(hasDossierSignal({ articles: [{ title: "x" }] })).toBe(true);
  });

  it("accepts a successful enrich envelope", () => {
    expect(
      hasDossierSignal(
        JSON.stringify({ status: "completed", profile: { title: "Founder" }, cost: 0.005 }),
      ),
    ).toBe(true);
  });

  it("accepts prose a play assembled — that is genuine context, not a payload", () => {
    expect(hasDossierSignal("Founder at Acme; ships agent infra.")).toBe(true);
  });

  it("keeps a TRUNCATED payload rather than discarding research already paid for", () => {
    // Dossiers are sliced to 6000 chars, so a stored payload may not re-parse.
    const truncated = `{"status":"completed","profile":{"title":"Head of Platform","comp`;
    expect(hasDossierSignal(truncated)).toBe(true);
  });
});
