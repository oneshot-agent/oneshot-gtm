import { describe, expect, it, vi } from "vitest";

// Issue #592: recovering the company-gate reason from the `notes` templates
// finders wrote before `fitReason` existed. An allowlist per play — the
// negatives matter as much as the positives.

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, logEvent: vi.fn() };
});

const { parseReasonFromNotes, stampFitReason } = await import("../src/_fit-reason.ts");

const R = "Early-stage vertical SaaS using AI for document intelligence, fitting the ICP.";

describe("parseReasonFromNotes", () => {
  it("takes the tail after the last dash for the templated finders", () => {
    expect(parseReasonFromNotes("accelerator-batch", `YC Summer 2026 — ${R}`)).toBe(R);
    expect(parseReasonFromNotes("job-change", `Ada → CTO @ Acme — ${R}`)).toBe(R);
    expect(parseReasonFromNotes("post-funding", `Seed $4,200,000 — ${R}`)).toBe(R);
    expect(parseReasonFromNotes("podcast-guest", `Ada on Lenny's Podcast — ${R}`)).toBe(R);
    expect(parseReasonFromNotes("hiring-signal", `Acme hiring "Staff ML" (Platform) — ${R}`)).toBe(
      R,
    );
  });

  it("takes the whole note where the finder wrote the bare reason", () => {
    expect(parseReasonFromNotes("show-hn", R)).toBe(R);
    expect(parseReasonFromNotes("repo-interest", R)).toBe(R);
  });

  it("handles the two finders behind competitor-switch / stack-consolidation", () => {
    expect(
      parseReasonFromNotes(
        "stack-consolidation",
        `github-topics: stripe, twilio (2 vendors) — ${R}`,
      ),
    ).toBe(R);
    expect(parseReasonFromNotes("competitor-switch", R)).toBe(R); // github-stars: bare
    // A note truncated at the repo-pipeline cap may have lost the reason itself.
    const truncated = `github-topics: ${"stripe, ".repeat(30)} (9 vendors) — ${R}`.slice(0, 220);
    expect(parseReasonFromNotes("stack-consolidation", truncated)).toBeNull();
  });

  it("handles the two finders behind free-pilot / new-business", () => {
    expect(parseReasonFromNotes("new-business", `NPPES Dentist (NY) — ${R}`)).toBe(R);
    expect(parseReasonFromNotes("free-pilot", R)).toBe(R);
  });

  it("never reads a title, an age, a lane score or a machine label as a reason", () => {
    expect(parseReasonFromNotes("breakup-revive", "47d cold — Acme")).toBeNull();
    expect(
      parseReasonFromNotes("sources-sought", "Sources Sought — GSA — Cloud migration services"),
    ).toBeNull();
    expect(
      parseReasonFromNotes("civic-pilot", "Austin — City Council — Permitting software"),
    ).toBeNull();
    expect(parseReasonFromNotes("luma-events", "Ada going to Llama Lounge 26")).toBeNull();
    expect(
      parseReasonFromNotes("x-amplify-dm", "12.4K followers · reposted 3 of @seed"),
    ).toBeNull();
    expect(parseReasonFromNotes("accelerator-batch", `auto: ICP — ${R}`)).toBeNull();
    expect(parseReasonFromNotes("profile-intro", "CSV import: ICP accepted")).toBeNull();
    expect(parseReasonFromNotes("show-hn", "ok")).toBeNull(); // too short to be a sentence
    expect(parseReasonFromNotes("show-hn", null)).toBeNull();
  });
});

describe("stampFitReason", () => {
  it("prefers the finder's explicit reason, defaulting the source to company-gate", () => {
    const out = stampFitReason("show-hn", { name: "A" }, R) as Record<string, unknown>;
    expect(out).toMatchObject({ name: "A", fitReason: R, fitReasonSource: "company-gate" });
    const person = stampFitReason("x-repost-intro", {}, R, "person-gate") as Record<
      string,
      unknown
    >;
    expect(person["fitReasonSource"]).toBe("person-gate");
  });

  it("leaves a payload that already carries one untouched", () => {
    const payload = { fitReason: "kept", fitReasonSource: "notes" };
    expect(stampFitReason("show-hn", payload)).toBe(payload);
  });

  it("falls back to the person-gate reason unless the verdict was reject", () => {
    expect(
      stampFitReason("luma-events", { icpVerdict: "pass", icpVerdictReason: R }),
    ).toMatchObject({ fitReason: R, fitReasonSource: "person-gate" });
    expect(
      stampFitReason("luma-events", { icpVerdict: "unclear", icpVerdictReason: R }),
    ).toMatchObject({ fitReasonSource: "person-gate" });
    const rejected = { icpVerdict: "reject", icpVerdictReason: "Recruiter, not a buyer." };
    expect(stampFitReason("luma-events", rejected)).toBe(rejected);
  });

  it("is total: a non-object payload comes back as-is", () => {
    expect(stampFitReason("show-hn", null)).toBeNull();
    expect(stampFitReason("show-hn", "str")).toBe("str");
  });
});
