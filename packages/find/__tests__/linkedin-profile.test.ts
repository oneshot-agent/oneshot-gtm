import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Live LinkedIn profile reads: cache first, every skip has a reason, a login
// wall invalidates the session, reads are serialized from the founder's
// account, and failures are negative-cached only when they are not transient.
// Connecting: a pasted cookie is imported into a fresh profile (never into a
// task), the hosted login flow is start → live URL → finish → verify.

const calls = {
  browser: 0,
  list: 0,
  create: 0,
  delete: 0,
  setupStart: 0,
  setupStatus: 0,
  setupFinish: 0,
};
let setupStatuses: string[] = [];
const cache = new Map<string, { result_json: string; fetched_at: string; status: string | null }>();
let readsToday = 0;
let cfg: Record<string, unknown> = {};
let browserOutput: unknown = null;
let browserSteps: Array<{ number: number; goal: string; url: string }> = [];
let browserFinalUrl: string | undefined;
let browserSuccess: boolean | undefined;
let browserError: Error | null = null;
let browserInputs: Array<Record<string, unknown>> = [];
let createOptions: Array<Record<string, unknown>> = [];
let platformProfiles: Array<{ id: string; name: string }> = [];
let storedCookies: Array<{ name: string; domain: string; path: string }> = [];
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
      return platformProfiles;
    },
    createBrowserProfile: async (name: string, _ctx: unknown, options: Record<string, unknown>) => {
      calls.create++;
      createOptions.push(options);
      const p = { id: `prof_new_${calls.create}`, name };
      platformProfiles.push(p);
      return p;
    },
    deleteBrowserProfile: async (id: string) => {
      calls.delete++;
      platformProfiles = platformProfiles.filter((p) => p.id !== id);
    },
    startBrowserProfileSetup: async (profileId: string) => {
      calls.setupStart++;
      return {
        profileId,
        status: setupStatuses.shift() ?? "idle",
        liveUrl: "https://live.example/session-secret",
        expiresAt: "2026-09-14T10:15:00.000Z",
        storedCookies: [],
      };
    },
    getBrowserProfileSetup: async (profileId: string) => {
      calls.setupStatus++;
      return {
        profileId,
        status: setupStatuses.shift() ?? "idle",
        liveUrl: "https://live.example/session-secret",
        expiresAt: "2026-09-14T10:15:00.000Z",
        storedCookies: [],
      };
    },
    finishBrowserProfileSetup: async (profileId: string) => {
      calls.setupFinish++;
      return { profileId, status: "finished", liveUrl: null, expiresAt: null, storedCookies };
    },
    browserTask: async (input: Record<string, unknown>) => {
      calls.browser++;
      browserInputs.push(input);
      if (browserError) throw browserError;
      return {
        result: {
          output: browserOutput,
          steps: browserSteps,
          cost: 0.012,
          ...(browserFinalUrl ? { final_url: browserFinalUrl } : {}),
          ...(browserSuccess === undefined
            ? {}
            : { success: browserSuccess, error_reason: "internal_error" }),
        },
        receiptId: 5,
      };
    },
  };
});

const {
  _resetLinkedInReadGate,
  connectLinkedInWithCookie,
  ensureLinkedInProfile,
  finishLinkedInLogin,
  linkedinProfileCacheKey,
  linkedinSessionState,
  readLinkedInProfile,
  startLinkedInLogin,
} = await import("../src/_linkedin-profile.ts");

const URL = "https://www.linkedin.com/in/julia-zabrodska-akinci-cv/";
/** Cached profile rows only — the shared gate lease lives in the same map under another prefix. */
const profileRows = () => [...cache.keys()].filter((k) => k.startsWith("linkedin-profile:")).length;
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
  calls.browser =
    calls.list =
    calls.create =
    calls.delete =
    calls.setupStart =
    calls.setupFinish =
      0;
  cache.clear();
  saved.length = 0;
  readsToday = 0;
  browserOutput = ok();
  browserSteps = [];
  browserFinalUrl = undefined;
  browserSuccess = undefined;
  browserError = null;
  browserInputs = [];
  createOptions = [];
  platformProfiles = [{ id: "prof_existing", name: "oneshot-gtm linkedin" }];
  storedCookies = [{ name: "li_at", domain: ".linkedin.com", path: "/" }];
  delete process.env["LINKEDIN_SESSION_COOKIE"];
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
  it("unset without a profile or cookie, unchecked before a verify, invalid after a wall, ok otherwise", () => {
    expect(linkedinSessionState()).toBe("ok");
    cfg = { ...cfg, linkedinSessionInvalidAt: "x" };
    expect(linkedinSessionState()).toBe("invalid");
    cfg = { ...cfg, linkedinSessionInvalidAt: null, linkedinSessionCheckedAt: null };
    expect(linkedinSessionState()).toBe("unchecked");
    cfg = { ...cfg, linkedinBrowserProfileId: null };
    expect(linkedinSessionState()).toBe("unset");
    // a pasted cookie alone is something to connect with
    process.env["LINKEDIN_SESSION_COOKIE"] = "cookie-value";
    expect(linkedinSessionState()).toBe("unchecked");
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

describe("ensureLinkedInProfile", () => {
  it("reuses the platform profile with our name and persists its id", async () => {
    cfg = { ...cfg, linkedinBrowserProfileId: null };
    expect(await ensureLinkedInProfile(ctx)).toBe("prof_existing");
    expect(calls.create).toBe(0);
    expect(saved.at(-1)?.["linkedinBrowserProfileId"]).toBe("prof_existing");
  });

  it("fresh creates the new profile first and deletes only the one this workspace pointed at", async () => {
    platformProfiles.push({ id: "prof_other_ws", name: "oneshot-gtm linkedin" });
    const id = await ensureLinkedInProfile(ctx, { fresh: true });
    expect(id).toBe("prof_new_1");
    expect(calls.delete).toBe(1);
    expect(platformProfiles.map((p) => p.id)).toEqual(["prof_other_ws", "prof_new_1"]);
    expect(cfg["linkedinBrowserProfileId"]).toBe("prof_new_1");
  });

  it("a failed create leaves the working profile in place", async () => {
    const core = await import("@oneshot-gtm/core");
    const original = core.createBrowserProfile;
    (core as unknown as { createBrowserProfile: unknown }).createBrowserProfile = async () => {
      throw new Error("Failed to create browser profile");
    };
    try {
      await expect(ensureLinkedInProfile(ctx, { fresh: true })).rejects.toThrow(/create/);
      expect(calls.delete).toBe(0);
      expect(cfg["linkedinBrowserProfileId"]).toBe("prof_existing");
    } finally {
      (core as unknown as { createBrowserProfile: unknown }).createBrowserProfile = original;
    }
  });
});

describe("connectLinkedInWithCookie", () => {
  it("imports the cookie at profile creation, never into a task, then verifies the feed", async () => {
    process.env["LINKEDIN_SESSION_COOKIE"] = "cookie-value";
    browserOutput = { loggedIn: true, name: "Founder Name" };
    const r = await connectLinkedInWithCookie(ctx);
    expect(r).toMatchObject({ loggedIn: true, name: "Founder Name", profileId: "prof_new_1" });
    expect(createOptions[0]).toEqual({
      cookies: [
        expect.objectContaining({ name: "li_at", value: "cookie-value", domain: ".linkedin.com" }),
      ],
    });
    expect(JSON.stringify(browserInputs)).not.toContain("cookie-value");
    expect(browserInputs[0]?.["profileId"]).toBe("prof_new_1");
    expect(saved.at(-1)).toMatchObject({
      linkedinBrowserProfileId: "prof_new_1",
      linkedinSessionName: "Founder Name",
      linkedinSessionInvalidAt: null,
    });
  });

  it("marks the session invalid when the feed shows no signed-in member or the login page", async () => {
    process.env["LINKEDIN_SESSION_COOKIE"] = "cookie-value";
    browserOutput = { loggedIn: false, name: null };
    const failed = await connectLinkedInWithCookie(ctx);
    expect(failed.loggedIn).toBe(false);
    expect(failed.reason).toMatch(/no signed-in member/);
    expect(typeof cfg["linkedinSessionInvalidAt"]).toBe("string");

    browserOutput = { loggedIn: true, name: "x" };
    browserFinalUrl = "https://www.linkedin.com/login/?session_redirect=%2Ffeed%2F";
    const walled = await connectLinkedInWithCookie(ctx);
    expect(walled.loggedIn).toBe(false);
    expect(walled.reason).toMatch(/login page/);
  });

  it("a verify task the platform could not run throws and leaves the session untouched", async () => {
    process.env["LINKEDIN_SESSION_COOKIE"] = "cookie-value";
    browserSuccess = false;
    browserOutput = "";
    await expect(connectLinkedInWithCookie(ctx)).rejects.toThrow(/did not complete/);
    expect(cfg["linkedinSessionInvalidAt"]).toBeNull();
    expect(cfg["linkedinSessionCheckedAt"]).toBe("2026-09-11T20:00:00.000Z");
  });

  it("refuses without a cookie", async () => {
    await expect(connectLinkedInWithCookie(ctx)).rejects.toThrow(/LINKEDIN_SESSION_COOKIE/);
    expect(calls.create).toBe(0);
  });
});

describe("startLinkedInLogin / finishLinkedInLogin", () => {
  it("opens the hosted login in a fresh profile and returns its live URL", async () => {
    const started = await startLinkedInLogin(ctx);
    expect(started).toEqual({
      profileId: "prof_new_1",
      liveUrl: "https://live.example/session-secret",
      status: "idle",
      expiresAt: "2026-09-14T10:15:00.000Z",
    });
    expect(calls.delete).toBe(1);
    expect(calls.setupStart).toBe(1);
    expect(cfg["linkedinBrowserProfileId"]).toBe("prof_new_1");
  });

  it("waits for the hosted browser to be idle before handing out the URL, and fails fast on a failed boot", async () => {
    setupStatuses = ["created", "running", "idle"];
    const started = startLinkedInLogin(ctx);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await started).status).toBe("idle");
    expect(calls.setupStatus).toBe(2);

    setupStatuses = ["created", "failed"];
    const failed = startLinkedInLogin(ctx);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(failed).rejects.toThrow(/could not open the login browser/);
  });

  it("finish saves the session and verifies it when li_at was stored", async () => {
    await startLinkedInLogin(ctx);
    browserOutput = { loggedIn: true, name: "Founder Name" };
    const r = await finishLinkedInLogin(ctx);
    expect(calls.setupFinish).toBe(1);
    expect(r).toMatchObject({ loggedIn: true, name: "Founder Name", profileId: "prof_new_1" });
    expect(linkedinSessionState()).toBe("ok");
  });

  it("finish without a stored li_at spends nothing and marks the session invalid", async () => {
    await startLinkedInLogin(ctx);
    storedCookies = [{ name: "bcookie", domain: ".linkedin.com", path: "/" }];
    const r = await finishLinkedInLogin(ctx);
    expect(r.loggedIn).toBe(false);
    expect(r.reason).toMatch(/did not complete/);
    expect(calls.browser).toBe(0);
    expect(linkedinSessionState()).toBe("invalid");
  });

  it("finish without a login in progress refuses", async () => {
    cfg = { ...cfg, linkedinBrowserProfileId: null };
    await expect(finishLinkedInLogin(ctx)).rejects.toThrow(/start one first/);
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

  it("skips with a reason instead of reading: not LinkedIn, not connected, unchecked, invalid, daily limit, cost cap", async () => {
    expect(
      (await readLinkedInProfile("https://github.com/x", ctx, { remainingUsd: 1 })).skipped,
    ).toBe("not-linkedin");
    cfg = { ...cfg, linkedinBrowserProfileId: null };
    expect((await readLinkedInProfile(URL, ctx, { remainingUsd: 1 })).skipped).toBe(
      "not-connected",
    );
    cfg = { ...cfg, linkedinBrowserProfileId: "prof_existing", linkedinSessionCheckedAt: null };
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

  it("a login wall (final URL or a step) marks the session invalid and caches nothing", async () => {
    browserOutput = { loggedIn: true, experience: [] };
    browserFinalUrl = "https://www.linkedin.com/authwall?trk=x";
    const read = await readLinkedInProfile(URL, ctx, { remainingUsd: 1 });
    expect(read.skipped).toBe("session-invalid");
    expect(typeof cfg["linkedinSessionInvalidAt"]).toBe("string");
    expect(profileRows()).toBe(0);
    expect((await readLinkedInProfile(URL, ctx, { remainingUsd: 1 })).skipped).toBe(
      "session-invalid",
    );
    expect(calls.browser).toBe(1);
  });

  it("a task the platform reports unsuccessful is a transient failure: no negative cache, session kept", async () => {
    browserSuccess = false;
    browserOutput = "";
    const read = await readLinkedInProfile(URL, ctx, { remainingUsd: 1 });
    expect(read.skipped).toBe("failed");
    expect(profileRows()).toBe(0);
    expect(cfg["linkedinSessionInvalidAt"]).toBeNull();
  });

  it("fails closed on the daily cap when the shared cache cannot count", async () => {
    const core = await import("@oneshot-gtm/core");
    const original = core.getLedger;
    (core as unknown as { getLedger: unknown }).getLedger = () => ({
      getCachedEnrichment: () => null,
      countCachedEnrichmentSince: () => {
        throw new Error("database is locked");
      },
    });
    try {
      expect((await readLinkedInProfile(URL, ctx, { remainingUsd: 1 })).skipped).toBe(
        "daily-limit",
      );
      expect(calls.browser).toBe(0);
    } finally {
      (core as unknown as { getLedger: unknown }).getLedger = original;
    }
  });

  it("the platform's own budget stop is not negative-cached", async () => {
    browserError = new Error("Job failed: Browser task failed: cost_limit (ref: 3a960955)");
    expect((await readLinkedInProfile(URL, ctx, { remainingUsd: 1 })).skipped).toBe("failed");
    expect(profileRows()).toBe(0);
  });

  it("bounds the task's charge by the caller's remaining budget", async () => {
    await readLinkedInProfile(URL, ctx, { remainingUsd: 0.05 });
    expect(browserInputs[0]?.["maxCost"]).toBe(0.05);
  });

  it("negative-caches a hard failure but not a transient one", async () => {
    browserError = new Error("Browser task initiation failed: 400 bad schema");
    expect((await readLinkedInProfile(URL, ctx, { remainingUsd: 1 })).skipped).toBe("failed");
    expect(cache.get(linkedinProfileCacheKey(URL))?.status).toBe("failed");
    cache.clear();
    _resetLinkedInReadGate();
    browserError = Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
    expect((await readLinkedInProfile(URL, ctx, { remainingUsd: 1 })).skipped).toBe("failed");
    expect(profileRows()).toBe(0);
  });

  it("honours another process's lease from the shared gate row", async () => {
    cache.set("linkedin-gate:reads", {
      result_json: JSON.stringify({ nextAllowedAt: Date.now() + 10_000 }),
      fetched_at: new Date().toISOString(),
      status: null,
    });
    const t0 = Date.now();
    const read = readLinkedInProfile(URL, ctx, { remainingUsd: 1 });
    await vi.advanceTimersByTimeAsync(11_000);
    await read;
    expect(calls.browser).toBe(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(10_000);
    const lease = JSON.parse(cache.get("linkedin-gate:reads")!.result_json) as {
      nextAllowedAt: number;
    };
    expect(lease.nextAllowedAt).toBeGreaterThan(t0 + 10_000);
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
