import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockProfile {
  email?: string;
  full_name?: string;
  linkedin_url?: string;
  phone?: string;
  fullphone?: Array<{ fullphone: string }>;
}

let nextProfile: MockProfile | null = null;
let nextCost = 0.005;
let throwOnNextCall = false;
const calls = { enrichProfile: 0, lastEmail: "" };

vi.mock("@oneshot-gtm/core", () => ({
  enrichProfile: async (input: { email?: string }) => {
    calls.enrichProfile++;
    calls.lastEmail = input.email ?? "";
    if (throwOnNextCall) {
      throwOnNextCall = false;
      throw new Error("rate limited");
    }
    return {
      result: { status: "completed", profile: nextProfile ?? {}, cost: nextCost },
      receiptId: 42,
    };
  },
  logEvent: () => {},
}));

const { enrichVerifiedContact } = await import("../src/_enrich.ts");

beforeEach(() => {
  calls.enrichProfile = 0;
  calls.lastEmail = "";
  nextProfile = null;
  nextCost = 0.005;
  throwOnNextCall = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("enrichVerifiedContact", () => {
  it("returns phone + linkedin when both are on the PersonResult", async () => {
    nextProfile = {
      email: "ada@acme.dev",
      phone: "+1 415-555-0100",
      linkedin_url: "https://www.linkedin.com/in/ada-lovelace",
    };
    const r = await enrichVerifiedContact("ada@acme.dev", { playName: "show-hn" });
    expect(r.phone).toBe("+1 415-555-0100");
    expect(r.linkedinUrl).toBe("https://www.linkedin.com/in/ada-lovelace");
    expect(r.costUsd).toBe(0.005);
    expect(r.receiptId).toBe(42);
    expect(calls.enrichProfile).toBe(1);
    expect(calls.lastEmail).toBe("ada@acme.dev");
  });

  it("returns phone only when SDK has phone but no linkedin_url", async () => {
    nextProfile = { phone: "+1 415-555-0100" };
    const r = await enrichVerifiedContact("ada@acme.dev", { playName: "show-hn" });
    expect(r.phone).toBe("+1 415-555-0100");
    expect(r.linkedinUrl).toBeNull();
  });

  it("reads phone from fullphone[] when profile.phone is missing", async () => {
    nextProfile = {
      fullphone: [{ fullphone: "+91 77600 65112" }],
    };
    const r = await enrichVerifiedContact("foo@bar.dev", { playName: "show-hn" });
    expect(r.phone).toBe("+91 77600 65112");
  });

  it("returns linkedin only when SDK has it but no phone", async () => {
    nextProfile = { linkedin_url: "https://linkedin.com/in/bob" };
    const r = await enrichVerifiedContact("bob@x.dev", { playName: "show-hn" });
    expect(r.phone).toBeNull();
    expect(r.linkedinUrl).toBe("https://linkedin.com/in/bob");
  });

  it("rejects non-profile linkedin URLs (company / posts / garbage)", async () => {
    nextProfile = { linkedin_url: "https://www.linkedin.com/company/acme" };
    const r = await enrichVerifiedContact("x@y.dev", { playName: "show-hn" });
    expect(r.linkedinUrl).toBeNull();
  });

  it("returns all-null when SDK profile is empty", async () => {
    nextProfile = {};
    const r = await enrichVerifiedContact("x@y.dev", { playName: "show-hn" });
    expect(r.phone).toBeNull();
    expect(r.linkedinUrl).toBeNull();
    expect(r.costUsd).toBe(0.005);
    expect(r.receiptId).toBe(42);
  });

  it("swallows SDK throws and returns null fields without raising", async () => {
    throwOnNextCall = true;
    const r = await enrichVerifiedContact("x@y.dev", {
      playName: "show-hn",
      errKindPrefix: "show-hn",
    });
    expect(r.phone).toBeNull();
    expect(r.linkedinUrl).toBeNull();
    expect(r.costUsd).toBe(0);
    expect(r.receiptId).toBeNull();
  });

  it("falls back to costUsd=0 when SDK doesn't return cost field", async () => {
    nextProfile = { phone: "+1 555-0100" };
    nextCost = 0 as unknown as number;
    // Reassign so the mock returns no cost
    const r = await enrichVerifiedContact("x@y.dev", { playName: "show-hn" });
    expect(r.costUsd).toBe(0);
  });
});
