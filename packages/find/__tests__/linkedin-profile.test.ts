import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Live LinkedIn profile reads: cache first, every skip has a reason, a login
// wall invalidates the session, reads are serialized from the founder's
// account, and failures are negative-cached only when they are not transient.

const calls = { browser: 0, list: 0, create: 0 };
const cache = new Map<string, { result_json: string; fetched_at: string; status: string | null }>();
let readsToday = 0;
let cfg: Record<string, unknown> = {};
let browserOutput: unknown = null;
let browserSteps: Array<{ number: number; goal: string; url: string }> = [];
let browserError: Error | null = null;
const saved: Array<Record<string, unknown>> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), ...cfg }),
    saveConfig: (next: Record<string, unknown>) => {
      saved.push(next);
      cfg = { ...cfg, ...next };
    },
    logEvent: () => {},
    getLedger: () => ({
      getCachedEnrichment: (key: string) => cache.get(key) ?? null,
      setCachedEnrichment: (key: string, json: string) =>
        cache.set(key, { result_json: json, fetched_at: new Date().toISOString(), status: null }),
      setCachedEnrichmentFailure: (key: string, message: string) =>
        cache.set(key, {
          result_json: JSON.stringify({ failed: true, message }),
          fetched_at: new Date().toISOString(),
          status: "failed",
        }),
      countCachedEnrichmentSince: () => readsToday,
    }),
    listBrowserProfiles: async () => {
      calls.list++;
      return [{ id: "prof_existing", name: "oneshot-gtm linkedin" }];
    },
    createBrowserProfile: async (name: string) => {
      calls.create++;
      return { id: "prof_new", name };
    },
    browserTask: async () => {
      calls.browser++;
      if (browserError) throw browserError;
      return { result: { output: browserOutput, steps: browserSteps, cost: 0.012 }, receiptId: 5 };
    },
  };
});

const {
  _resetLinkedInReadGate,
  ensureLinkedInProfile,
  linkedinProfileCacheKey,
  linkedinSessionState,
  readLinkedInProfile,
  seedLinkedInSession,
} = await import("../src/_linkedin-profile.ts");

const URL = "https://www.linkedin.com/in/julia-zabrodska-akinci-cv/";
const ctx = { playName: "luma-events" };
const ok = () => ({
  loggedIn: true,
  name: "Julia Zabrodska-Akinci",
  headline: "Founder & Product Owner at WildMuse.App",
  location: "London",
  experience: [
    { company: "WildMuse.App", title: "Founder & Product Owner", period: "Mar 2026 - Present" },
    { company: "L'ETO Group", title: "Head of Product", period: "Nov 2024 - Oct 2025" },
  ],
});

beforeEach(() => {
  calls.browser = calls.list = calls.create = 0;
  cache.clear();
  saved.length = 0;
  readsToday = 0;
  browserOutput = ok();
  browserSteps = [];
  browserError = null;
  process.env["LINKEDIN_SESSION_COOKIE"] = "cookie-value";
  cfg = {
    linkedinBrowserProfileId: "prof_existing",
    linkedinSessionCheckedAt: "2026-09-11T20:00:00.000Z",
    linkedinSessionName: "Founder",
    linkedinSessionInvalidAt: null,
    linkedinReadsPerDay: 80,
  };
  _resetLinkedInReadGate();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env["LINKEDIN_SESSION_COOKIE"];
});

describe("session state", () => {
  it("unset without a cookie, unchecked before seeding, invalid after a wall, ok otherwise", () => {
    expect(linkedinSessionState()).toBe("ok");
    cfg = { ...cfg, linkedinSessionInvalidAt: "x" };
    expect(linkedinSessionState()).toBe("invalid");
    cfg = { ...cfg, linkedinSessionInvalidAt: null, linkedinSessionCheckedAt: null };
    expect(linkedinSessionState()).toBe("unchecked");
    delete process.env["LINKEDIN_SESSION_COOKIE"];
    expect(linkedinSessionState()).toBe("unset");
  });

  it("the cache key normalises host, trailing slash and query", () => {
    expect(linkedinProfileCacheKey(URL)).toBe(
      "linkedin-profile:https://linkedin.com/in/julia-zabrodska-akinci-cv",
    );
    expect(linkedinProfileCacheKey("https://LinkedIn.com/in/Julia-Zabrodska-Akinci-cv?trk=x")).toBe(
      "linkedin-profile:https://linkedin.com/in/julia-zabrodska-akinci-cv",
    );
  });
});

describe("ensureLinkedInProfile / seedLinkedInSession", () => {
  it("reuses the platform profile with our name and persists its id", async () => {
    cfg = { ...cfg, linkedinBrowserProfileId: null };
    expect(await ensureLinkedInProfile(ctx)).toBe("prof_existing");
    expect(calls.create).toBe(0);
    expect(saved.at(-1)?.["linkedinBrowserProfileId"]).toBe("prof_existing");
  });

  it("seeding records a live session, or marks it invalid when the page is not signed in", async () => {
    browserOutput = { loggedIn: true, name: "Founder Name" };
    const seeded = await seedLinkedInSession(ctx);
    expect(seeded).toMatchObject({
      loggedIn: true,
      name: "Founder Name",
      profileId: "prof_existing",
    });
    expect(saved.at(-1)).toMatchObject({
      linkedinSessionName: "Founder Name",
      linkedinSessionInvalidAt: null,
    });

    browserOutput = { loggedIn: false, name: null };
    const failed = await seedLinkedInSession(ctx);
    expect(failed.loggedIn).toBe(false);
    expect(typeof saved.at(-1)?.["linkedinSessionInvalidAt"]).toBe("string");
  });
});

describe("readLinkedInProfile", () => {
  it("reads the Experience section, caches it, and a second read is free", async () => {
    const first = await readLinkedInProfile(URL, ctx, { remainingUsd: 1 });
    expect(first.profile?.experience).toEqual(ok().experience);
    expect(first.profile?.headline).toBe("Founder & Product Owner at WildMuse.App");
    expect(first.costUsd).toBeCloseTo(0.012, 5);
    expect(calls.browser).toBe(1);
    const second = await readLinkedInProfile(URL, ctx, { remainingUsd: 1 });
    expect(second.cached).toBe(true);
    expect(second.costUsd).toBe(0);
    expect(calls.browser).toBe(1);
  });

  it("skips with a reason instead of reading: not LinkedIn, no cookie, unchecked, invalid, daily limit, cost cap", async () => {
    expect(
      (await readLinkedInProfile("https://github.com/x", ctx, { remainingUsd: 1 })).skipped,
    ).toBe("not-linkedin");
    delete process.env["LINKEDIN_SESSION_COOKIE"];
    expect((await readLinkedInProfile(URL, ctx, { remainingUsd: 1 })).skipped).toBe("no-cookie");
    process.env["LINKEDIN_SESSION_COOKIE"] = "cookie-value";
    cfg = { ...cfg, linkedinSessionCheckedAt: null };
    expect((await readLinkedInProfile(URL, ctx, { remainingUsd: 1 })).skipped).toBe(
      "session-unchecked",
    );
    cfg = { ...cfg, linkedinSessionCheckedAt: "x", linkedinSessionInvalidAt: "y" };
    expect((await readLinkedInProfile(URL, ctx, { remainingUsd: 1 })).skipped).toBe(
      "session-invalid",
    );
    cfg = { ...cfg, linkedinSessionInvalidAt: null };
    readsToday = 80;
    expect((await readLinkedInProfile(URL, ctx, { remainingUsd: 1 })).skipped).toBe("daily-limit");
    readsToday = 0;
    expect((await readLinkedInProfile(URL, ctx, { remainingUsd: 0.01 })).skipped).toBe("cost-cap");
    expect(calls.browser).toBe(0);
  });

  it("a login wall marks the session invalid and caches nothing", async () => {
    browserOutput = { loggedIn: false, experience: [] };
    browserSteps = [{ number: 1, goal: "open", url: "https://www.linkedin.com/authwall?trk=x" }];
    const read = await readLinkedInProfile(URL, ctx, { remainingUsd: 1 });
    expect(read.skipped).toBe("session-invalid");
    expect(typeof cfg["linkedinSessionInvalidAt"]).toBe("string");
    expect(cache.size).toBe(0);
    expect((await readLinkedInProfile(URL, ctx, { remainingUsd: 1 })).skipped).toBe(
      "session-invalid",
    );
    expect(calls.browser).toBe(1);
  });

  it("negative-caches a hard failure but not a transient one", async () => {
    browserError = new Error("Browser task initiation failed: 400 bad schema");
    expect((await readLinkedInProfile(URL, ctx, { remainingUsd: 1 })).skipped).toBe("failed");
    expect(cache.get(linkedinProfileCacheKey(URL))?.status).toBe("failed");
    cache.clear();
    _resetLinkedInReadGate();
    browserError = Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
    expect((await readLinkedInProfile(URL, ctx, { remainingUsd: 1 })).skipped).toBe("failed");
    expect(cache.size).toBe(0);
  });

  it("serializes reads and spaces them fifteen seconds apart", async () => {
    const started: number[] = [];
    const core = await import("@oneshot-gtm/core");
    (core as unknown as { browserTask: unknown }).browserTask = async () => {
      started.push(Date.now());
      calls.browser++;
      return { result: { output: ok(), steps: [], cost: 0.01 }, receiptId: 5 };
    };
    const a = readLinkedInProfile(URL, ctx, { remainingUsd: 1 });
    const b = readLinkedInProfile("https://www.linkedin.com/in/someone-else", ctx, {
      remainingUsd: 1,
    });
    await vi.advanceTimersByTimeAsync(16_000);
    await Promise.all([a, b]);
    expect(started).toHaveLength(2);
    expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(15_000);
  });
});
