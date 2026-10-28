import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Live reads through the connected LinkedIn account: a silent profile view
// with the Experience list, run as the workspace that owns the account. It
// wins over the browser session, maps open positions to current whatever the
// view's own flag says, keeps a held-back section from counting as proof, and
// sorts failures into "reconnect", "out of views", "this profile" and
// "try again".

const cache = new Map<string, { result_json: string; fetched_at: string; status: string | null }>();
let readsToday = 0;
let cfg: Record<string, unknown> = {};
let account: { workspace: string; accountId: string } | null = null;
let browserCalls = 0;
let countedSince: string | null = null;
let identities: Array<{ accountKey: string; identity: Record<string, unknown> }> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), ...cfg }),
    logEvent: () => {},
    linkedInProfileReadAccount: () => account,
    browserTask: async () => {
      browserCalls++;
      throw new Error("the browser path must not run");
    },
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
      countCachedEnrichmentSince: (_prefix: string, since: string) => {
        countedSince = since;
        return readsToday;
      },
    }),
    getLinkedInInboxStore: () => ({
      accounts: () => [{ key: "wallet:acct-1", account: { id: "acct-1" } }],
      saveIdentity: (accountKey: string, identity: Record<string, unknown>) =>
        identities.push({ accountKey, identity }),
    }),
  };
});

const {
  _setLinkedInCall,
  experienceFromAccountView,
  liveReadConfigured,
  liveReadReady,
  readLinkedInProfile,
} = await import("../src/_linkedin-profile.ts");

const { _resetPaidCache, getSharedDb, paidCacheKey, readPaidCache } =
  await import("@oneshot-gtm/core");

const URL_A = "https://www.linkedin.com/in/ada-quill";
/** The stored read (or negative entry) for a profile in the paid cache. */
const stored = (url: string) => readPaidCache("linkedin.profile_read", { url });
const ctx = { playName: "luma-events" };
const fail = (fields: Record<string, unknown>) =>
  Object.assign(new Error(String(fields["message"] ?? "Tool request failed")), fields);

const view = (experience: unknown, complete: boolean | null = true) => ({
  status: "completed",
  result: {
    profile: {
      provider_id: "ACoAAAda",
      public_identifier: "ada-quill",
      name: "Ada Quill",
      headline: "Builds things at Acme",
      location: "Lisbon",
      experience,
      experience_complete: complete,
    },
    cost: 0.01,
  },
});

const ADA_EXPERIENCE = [
  // An open position the view marks not current (it does that for all of them).
  { company: "Acme", title: "Head of Platform", start: "5/1/2026", end: null, current: false },
  { company: "Side Project", title: "Co-Founder", start: "1/1/2024", end: null, current: false },
  { company: "Old Co", title: "Engineer", start: "3/1/2023", end: "12/1/2025", current: false },
  { company: "", title: "dropped: no company" },
];

let ops: Array<{ workspace: string; operation: Record<string, unknown> }> = [];
let answers: Array<unknown> = [];

function script(...next: unknown[]) {
  answers = next;
  _setLinkedInCall(async (workspace, operation) => {
    ops.push({ workspace, operation: operation as unknown as Record<string, unknown> });
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  }, 0);
}

beforeEach(() => {
  cache.clear();
  _resetPaidCache();
  readsToday = 0;
  browserCalls = 0;
  countedSince = null;
  identities = [];
  ops = [];
  account = { workspace: "beta", accountId: "acct-1" };
  // A browser session that a read once found walled: the account read does not care.
  cfg = {
    linkedinBrowserProfileId: "prof_1",
    linkedinSessionCheckedAt: "2026-09-14T10:18:52.694Z",
    linkedinSessionInvalidAt: "2026-10-09T00:00:00.000Z",
    linkedinReadsPerDay: 80,
  };
});
afterEach(() => {
  _setLinkedInCall(null);
});

describe("experienceFromAccountView", () => {
  it("writes periods the way the page shows them; an open position is current", () => {
    expect(experienceFromAccountView(ADA_EXPERIENCE)).toEqual([
      { company: "Acme", title: "Head of Platform", period: "May 2026 - Present" },
      { company: "Side Project", title: "Co-Founder", period: "Jan 2024 - Present" },
      { company: "Old Co", title: "Engineer", period: "Mar 2023 - Dec 2025" },
    ]);
  });

  it("keeps an end with no start out of the period, and tolerates junk", () => {
    expect(
      experienceFromAccountView([
        { company: "Gamma Labs", end: "6/1/2019", location: "Porto" },
        { company: "Delta", start: null, end: null },
        "not an entry",
        null,
      ]),
    ).toEqual([
      { company: "Gamma Labs", endDate: "Jun 2019", location: "Porto" },
      { company: "Delta" },
    ]);
    expect(experienceFromAccountView(null)).toEqual([]);
  });
});

describe("readLinkedInProfile through the connected account", () => {
  it("is configured and ready with an account even when the browser session is walled", () => {
    expect(liveReadConfigured()).toBe(true);
    expect(liveReadReady()).toBe(true);
    account = null;
    expect(liveReadReady()).toBe(false);
  });

  it("starts a silent view as the account's workspace, waits for the job, and caches the read", async () => {
    const timeout = Object.assign(new Error("still running"), { name: "JobTimeoutError" });
    script({ status: "pending", request_id: "req-1" }, timeout, view(ADA_EXPERIENCE));
    const read = await readLinkedInProfile(URL_A, ctx, { remainingUsd: 1 });
    expect(browserCalls).toBe(0);
    expect(ops.map((o) => o.workspace)).toEqual(["beta", "beta", "beta"]);
    expect(ops[0]!.operation).toMatchObject({
      kind: "profile-read",
      accountId: "acct-1",
      identifier: URL_A,
      playName: "luma-events",
    });
    // The platform takes only [A-Za-z0-9_.:-] in a key: the profile is a hash, stable per day.
    expect(String(ops[0]!.operation["idempotencyKey"])).toMatch(
      /^gtm:profile-read:[0-9a-f]{32}:\d{4}-\d{2}-\d{2}$/,
    );
    // The day is the UTC day: the account's view cap resets at 00:00 UTC.
    const utcDay = new Date().toISOString().slice(0, 10);
    expect(String(ops[0]!.operation["idempotencyKey"]).endsWith(`:${utcDay}`)).toBe(true);
    // The view named the member id and public profile: saved for reply matching.
    expect(identities).toEqual([
      {
        accountKey: "wallet:acct-1",
        identity: expect.objectContaining({
          providerId: "ACoAAAda",
          profile: "linkedin.com/in/ada-quill",
        }),
      },
    ]);
    expect(ops[1]!.operation).toEqual({ kind: "wait", requestId: "req-1" });
    expect(read.skipped).toBeUndefined();
    expect(read.costUsd).toBe(0.01);
    expect(read.profile).toMatchObject({
      url: URL_A,
      name: "Ada Quill",
      headline: "Builds things at Acme",
      location: "Lisbon",
    });
    expect(read.profile?.experience[0]).toEqual({
      company: "Acme",
      title: "Head of Platform",
      period: "May 2026 - Present",
    });
    expect(stored(URL_A)?.status).toBe("ok");

    // The second ask is the cache: no view, no charge.
    const again = await readLinkedInProfile(URL_A, ctx, { remainingUsd: 1 });
    expect(again).toMatchObject({ cached: true, costUsd: 0 });
    expect(ops).toHaveLength(3);
  });

  it("reads again past a caller's max age", async () => {
    getSharedDb().setPaidCache({
      key: paidCacheKey("linkedin.profile_read", { url: URL_A }),
      callType: "linkedin.profile_read",
      status: "ok",
      resultJson: JSON.stringify({ url: URL_A, readAt: "x", experience: [] }),
      costUsd: 0.01,
      fetchedAt: new Date(Date.now() - 15 * 86_400_000).toISOString(),
    });
    script(view(ADA_EXPERIENCE));
    const fresh = await readLinkedInProfile(URL_A, ctx, { remainingUsd: 1 });
    expect(fresh.cached).toBe(true);
    const aged = await readLinkedInProfile(URL_A, ctx, {
      remainingUsd: 1,
      maxAgeMs: 14 * 86_400_000,
    });
    expect(aged.cached).toBe(false);
    expect(aged.profile?.experience).toHaveLength(3);
  });

  it("keeps the view's network distance on the read and in the cache; a view without one is unknown", async () => {
    const connected = view(ADA_EXPERIENCE);
    (connected.result.profile as Record<string, unknown>)["network_distance"] = "FIRST_DEGREE";
    script(connected);
    const read = await readLinkedInProfile(URL_A, ctx, { remainingUsd: 1 });
    expect(read.profile?.networkDistance).toBe("FIRST_DEGREE");
    const entry = stored(URL_A);
    expect(entry?.status === "ok" && (entry.result as { networkDistance?: unknown })).toMatchObject(
      { networkDistance: "FIRST_DEGREE" },
    );

    const URL_B = "https://www.linkedin.com/in/bo-reyes";
    script(view(ADA_EXPERIENCE));
    const unknown = await readLinkedInProfile(URL_B, ctx, { remainingUsd: 1 });
    expect(unknown.profile?.networkDistance).toBeNull();
  });

  it("a section LinkedIn held back is not proof: nothing cached, read again later", async () => {
    script(view([], false));
    const read = await readLinkedInProfile(URL_A, ctx, { remainingUsd: 1 });
    expect(read).toMatchObject({ profile: null, skipped: "interrupted" });
    // Nothing cached for the profile, but the charged view counts toward the day.
    expect(stored(URL_A)).toBeNull();
    expect([...cache.keys()]).toEqual([expect.stringMatching(/^linkedin-profile:incomplete:/)]);
    // A row without a failure status: the kind the daily budget counts.
    expect([...cache.values()][0]!.status).toBeNull();
  });

  it("sorts failures: reconnect, out of views, this profile (negative-cached), try again", async () => {
    script(fail({ statusCode: 409, code: "not_connected" }));
    expect((await readLinkedInProfile(URL_A, ctx, { remainingUsd: 1 })).skipped).toBe(
      "session-invalid",
    );
    script({
      status: "failed",
      error: "Daily profile-view limit reached",
      error_code: "rate_limited",
    });
    expect((await readLinkedInProfile(URL_A, ctx, { remainingUsd: 1 })).skipped).toBe(
      "daily-limit",
    );
    script(fail({ statusCode: 500, message: "Tool execution failed" }));
    expect((await readLinkedInProfile(URL_A, ctx, { remainingUsd: 1 })).skipped).toBe(
      "interrupted",
    );
    expect(cache.size).toBe(0);
    expect(stored(URL_A)).toBeNull();

    script(fail({ statusCode: 404, code: "profile_not_found" }));
    expect((await readLinkedInProfile(URL_A, ctx, { remainingUsd: 1 })).skipped).toBe("failed");
    expect(stored(URL_A)?.status).toBe("failed");
    // The negative entry answers the next ask without a view.
    const before = ops.length;
    expect(await readLinkedInProfile(URL_A, ctx, { remainingUsd: 1 })).toMatchObject({
      skipped: "failed",
      cached: true,
    });
    expect(ops).toHaveLength(before);
  });

  it("two reads at once with one view left: one reads, the other stops at the cap", async () => {
    readsToday = 79;
    _setLinkedInCall(async (workspace, operation) => {
      ops.push({ workspace, operation: operation as unknown as Record<string, unknown> });
      // The read's stored row in the paid cache is what the cap counts next.
      return view(ADA_EXPERIENCE);
    }, 0);
    const [a, b] = await Promise.all([
      readLinkedInProfile(URL_A, ctx, { remainingUsd: 1 }),
      readLinkedInProfile("https://www.linkedin.com/in/bo-quill", ctx, { remainingUsd: 1 }),
    ]);
    expect([a.skipped ?? "read", b.skipped ?? "read"].toSorted()).toEqual(["daily-limit", "read"]);
    expect(ops).toHaveLength(1);
  });

  it("stops at the daily read cap and the cost cap before asking", async () => {
    script(view(ADA_EXPERIENCE));
    readsToday = 80;
    expect((await readLinkedInProfile(URL_A, ctx, { remainingUsd: 1 })).skipped).toBe(
      "daily-limit",
    );
    // Counted from 00:00 UTC, when the account's view cap resets.
    expect(countedSince).toMatch(/T00:00:00\.000Z$/);
    readsToday = 0;
    expect((await readLinkedInProfile(URL_A, ctx, { remainingUsd: 0.001 })).skipped).toBe(
      "cost-cap",
    );
    expect(ops).toEqual([]);
  });
});
