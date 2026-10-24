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
let nextThrowMessage = "rate limited";
const calls = { enrichProfile: 0, lastEmail: "" };

// enrichProfile runs the real paid cache around a fake purchase, so these
// cases check what a finder's post-verify enrich reads from and leaves in it.
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    withDeadline: <T>(p: Promise<T>) => p,
    enrichProfile: (input: { email?: string }, _ctx: unknown, cache?: unknown) =>
      actual.withPaidCache("enrich.profile", input, cache as never, async () => {
        calls.enrichProfile++;
        calls.lastEmail = input.email ?? "";
        if (throwOnNextCall) {
          throwOnNextCall = false;
          throw new Error(nextThrowMessage);
        }
        return {
          result: { status: "completed", profile: nextProfile ?? {}, cost: nextCost },
          receiptId: 42,
        };
      }),
    logEvent: () => {},
  };
});

const core = await import("@oneshot-gtm/core");
const { enrichVerifiedContact } = await import("../src/_enrich.ts");

function seed(
  email: string,
  status: "ok" | "failed",
  ageMs: number,
  result: unknown = { message: "rate limited" },
): void {
  core.getSharedDb().setPaidCache({
    key: core.paidCacheKey("enrich.profile", { email }),
    callType: "enrich.profile",
    status,
    resultJson: JSON.stringify(result),
    costUsd: status === "ok" ? 0.005 : null,
    fetchedAt: new Date(Date.now() - ageMs).toISOString(),
  });
}

function stored(email: string) {
  return core.readPaidCache("enrich.profile", { email });
}

function storedResult(email: string): unknown {
  const row = stored(email);
  return row?.status === "ok" ? row.result : null;
}

beforeEach(() => {
  calls.enrichProfile = 0;
  calls.lastEmail = "";
  nextProfile = null;
  nextCost = 0.005;
  throwOnNextCall = false;
  nextThrowMessage = "rate limited";
  core._resetPaidCache();
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
 * Locks in the cache contract that makes find→/run avoid double-enriching the
 * same email: the result is stored for the address, and a warm address is
 * answered without a purchase.
 */
describe("enrichVerifiedContact — paid cache contract", () => {
  it("stores the enriched result for the address on success", async () => {
    nextProfile = {
      email: "ada@acme.dev",
      phone: "+1 415-555-0100",
      linkedin_url: "https://www.linkedin.com/in/ada-lovelace",
    };
    await enrichVerifiedContact("  Ada@Acme.dev  ", { playName: "show-hn" });
    expect(stored("ada@acme.dev")?.status).toBe("ok");
    expect(storedResult("ada@acme.dev")).toMatchObject({
      profile: { email: "ada@acme.dev" },
      cost: 0.005,
    });
  });

  it("stores nothing when enrichProfile throws a transient error", async () => {
    throwOnNextCall = true;
    await enrichVerifiedContact("x@y.dev", { playName: "show-hn" });
    expect(stored("x@y.dev")).toBeNull();
  });

  it("short-circuits to the cache when the address is warm (no SDK call)", async () => {
    seed("warm@x.dev", "ok", 0, {
      profile: {
        phone: "+1 555-9999",
        linkedin_url: "https://www.linkedin.com/in/cached-person",
      },
      cost: 0.005,
    });
    const r = await enrichVerifiedContact("warm@x.dev", { playName: "show-hn" });
    expect(calls.enrichProfile).toBe(0);
    expect(r.phone).toBe("+1 555-9999");
    expect(r.linkedinUrl).toBe("https://www.linkedin.com/in/cached-person");
    // Cache hit means no new SDK call, so no new spend / receipt is attributed
    // to this invocation. The original receipt still lives where it was paid.
    expect(r.costUsd).toBe(0);
    expect(r.receiptId).toBeNull();
  });

  it("is answered by a by-LinkedIn enrich that surfaced the same email", async () => {
    await core.withPaidCache(
      "enrich.profile",
      { linkedinUrl: "https://www.linkedin.com/in/surfaced" },
      undefined,
      async () => ({
        result: {
          status: "completed",
          profile: { email: "Surfaced@Acme.dev", phone: "+1 555-3333" },
          cost: 0.005,
        },
        receiptId: 1,
      }),
    );
    const r = await enrichVerifiedContact("surfaced@acme.dev", { playName: "show-hn" });
    expect(calls.enrichProfile).toBe(0);
    expect(r.phone).toBe("+1 555-3333");
    expect(r.costUsd).toBe(0);
  });

  it("falls through to the SDK when the stored result is older than 30 days", async () => {
    seed("stale@x.dev", "ok", 31 * 24 * 3600 * 1000, {
      profile: { phone: "+1 555-0000" },
      cost: 0.005,
    });
    nextProfile = { phone: "+1 555-7777" };
    const r = await enrichVerifiedContact("stale@x.dev", { playName: "show-hn" });
    expect(calls.enrichProfile).toBe(1);
    // Fresh result, not the stale cached one, and it replaces the old row.
    expect(r.phone).toBe("+1 555-7777");
    expect(storedResult("stale@x.dev")).toMatchObject({ profile: { phone: "+1 555-7777" } });
  });
});

const EMPTY = {
  phone: null,
  linkedinUrl: null,
  title: null,
  summary: null,
  costUsd: 0,
  receiptId: null,
};

describe("enrichVerifiedContact — negative caching", () => {
  it("remembers a GENUINE no-data failure", async () => {
    throwOnNextCall = true;
    nextThrowMessage = "no profile data for this person";
    const r = await enrichVerifiedContact("boom@x.dev", { playName: "show-hn" });
    expect(r).toEqual(EMPTY);
    expect(stored("boom@x.dev")).toMatchObject({
      status: "failed",
      message: "no profile data for this person",
    });
  });

  it("does NOT negative-cache a TRANSIENT platform error (so it retries after recovery)", async () => {
    throwOnNextCall = true;
    nextThrowMessage = "Job failed: Tool execution failed. (ref: abc)";
    const r = await enrichVerifiedContact("outage@x.dev", { playName: "show-hn" });
    expect(r).toEqual(EMPTY);
    expect(stored("outage@x.dev")).toBeNull(); // NOT poisoned
    // Next call (platform recovered) re-attempts: nothing suppressing it.
    nextProfile = { phone: "+1 555-2222" };
    const r2 = await enrichVerifiedContact("outage@x.dev", { playName: "show-hn" });
    expect(r2.phone).toBe("+1 555-2222");
  });

  it("a fresh failed entry skips the SDK entirely", async () => {
    seed("boom@x.dev", "failed", 60_000); // 1 min ago
    const r = await enrichVerifiedContact("boom@x.dev", { playName: "show-hn" });
    expect(calls.enrichProfile).toBe(0);
    expect(r).toEqual(EMPTY);
  });

  it("an expired failed entry retries the SDK", async () => {
    seed("boom@x.dev", "failed", 4 * 24 * 3600 * 1000); // 4 days > 3d
    nextProfile = { phone: "+1 555-1234" };
    const r = await enrichVerifiedContact("boom@x.dev", { playName: "show-hn" });
    expect(calls.enrichProfile).toBe(1);
    expect(r.phone).toBe("+1 555-1234");
    expect(stored("boom@x.dev")?.status).toBe("ok"); // success overwrites the failure
  });
});
