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

// Captures every interaction with the cache so cases can assert read/write
// behavior without spinning up a real SQLite. `cachedRow` is what the next
// getCachedEnrichment call returns; cases preload it to test the short-circuit.
const cache = {
  setCalls: [] as Array<{ key: string; resultJson: string }>,
  getCalls: [] as string[],
  cachedRow: null as { result_json: string; fetched_at: string } | null,
};

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
  getLedger: () => ({
    setCachedEnrichment: (key: string, resultJson: string) => {
      cache.setCalls.push({ key, resultJson });
    },
    getCachedEnrichment: (key: string) => {
      cache.getCalls.push(key);
      return cache.cachedRow;
    },
  }),
  logEvent: () => {},
}));

const { enrichVerifiedContact } = await import("../src/_enrich.ts");

beforeEach(() => {
  calls.enrichProfile = 0;
  calls.lastEmail = "";
  nextProfile = null;
  nextCost = 0.005;
  throwOnNextCall = false;
  cache.setCalls = [];
  cache.getCalls = [];
  cache.cachedRow = null;
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

/**
 * Locks in the cache write/read contract that makes find→/run avoid
 * double-enriching the same email. If a future contributor inlines
 * enrichProfile without populating cached_enrichments, or removes the
 * cache-read short-circuit, these cases fail.
 */
describe("enrichVerifiedContact — cache write + read contract", () => {
  it("writes the enriched result to the cache on success (key + JSON value match safeEnrich)", async () => {
    nextProfile = {
      email: "ada@acme.dev",
      phone: "+1 415-555-0100",
      linkedin_url: "https://www.linkedin.com/in/ada-lovelace",
    };
    await enrichVerifiedContact("  Ada@Acme.dev  ", { playName: "show-hn" });
    expect(cache.setCalls).toHaveLength(1);
    expect(cache.setCalls[0]?.key).toBe("ada@acme.dev");
    // The value MUST be JSON.stringify(enriched.result) so safeEnrich's
    // read-side (JSON.parse) reconstructs the same shape.
    expect(JSON.parse(cache.setCalls[0]!.resultJson)).toMatchObject({
      profile: { email: "ada@acme.dev" },
      cost: 0.005,
    });
  });

  it("skips the cache write when enrichProfile throws", async () => {
    throwOnNextCall = true;
    await enrichVerifiedContact("x@y.dev", { playName: "show-hn" });
    expect(cache.setCalls).toHaveLength(0);
  });

  it("short-circuits to cache when the key is warm (no SDK call)", async () => {
    cache.cachedRow = {
      result_json: JSON.stringify({
        profile: {
          phone: "+1 555-9999",
          linkedin_url: "https://www.linkedin.com/in/cached-person",
        },
        cost: 0.005,
      }),
      fetched_at: new Date().toISOString(),
    };
    const r = await enrichVerifiedContact("warm@x.dev", { playName: "show-hn" });
    expect(calls.enrichProfile).toBe(0);
    expect(r.phone).toBe("+1 555-9999");
    expect(r.linkedinUrl).toBe("https://www.linkedin.com/in/cached-person");
    // Cache hit means no new SDK call, so no new spend / receipt is attributed
    // to this invocation — the original receipt still lives where it was paid.
    expect(r.costUsd).toBe(0);
    expect(r.receiptId).toBeNull();
  });

  it("falls through to SDK when the cache row is older than the TTL", async () => {
    // 31 days old > 30-day TTL
    const ttlPlusOneDayMs = 31 * 24 * 3600 * 1000;
    cache.cachedRow = {
      result_json: JSON.stringify({
        profile: { phone: "+1 555-0000" },
        cost: 0.005,
      }),
      fetched_at: new Date(Date.now() - ttlPlusOneDayMs).toISOString(),
    };
    nextProfile = { phone: "+1 555-7777" };
    const r = await enrichVerifiedContact("stale@x.dev", { playName: "show-hn" });
    expect(calls.enrichProfile).toBe(1);
    // Fresh result, not the stale cached one.
    expect(r.phone).toBe("+1 555-7777");
    // Fresh result → fresh cache write.
    expect(cache.setCalls).toHaveLength(1);
  });
});
