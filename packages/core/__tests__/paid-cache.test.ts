import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The one cache for paid lookups. The SDK and the ledger singleton are mocked
// (no wallet, no network); the shared DB is the per-file temp one
// vitest.setup.ts points ONESHOT_GTM_SHARED at, so two Ledgers here are two
// workspaces sharing one shared file.

const personProfileMock = vi.hoisted(() =>
  vi.fn(async (opts: Record<string, unknown>) => ({
    status: "completed",
    profile: { full_name: "Pat Lee", email: "pat@acme.com", best_work_email: "pat@acme.com" },
    request_id: "req_enrich",
    cost: 0.005,
    _opts: opts,
  })),
);
const personFindMock = vi.hoisted(() =>
  vi.fn(async (_opts: Record<string, unknown>) => ({
    status: "completed",
    results: [],
    total_found: 0,
    request_id: "req_people",
    cost: 0.01,
  })),
);
const h = vi.hoisted(() => ({ ledger: null as unknown as import("../src/ledger.ts").Ledger }));

vi.mock("@oneshot-agent/sdk", () => ({
  OneShot: class {
    personProfile = personProfileMock;
    personFind = personFindMock;
  },
  ValidationError: class extends Error {},
}));

vi.mock("../src/ledger.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/ledger.ts")>("../src/ledger.ts");
  return { ...actual, getLedger: () => h.ledger };
});

import { Ledger } from "../src/ledger.ts";
import { enrichProfile, peopleSearch } from "../src/oneshot.ts";
import {
  _resetPaidCache,
  CachedPaidFailureError,
  hasCached,
  importLegacyPaidResults,
  isNegativeCacheable,
  legacyKeyInput,
  PaidCacheMissError,
  paidCacheKey,
  paidCacheStats,
  prunePaidCache,
  readPaidCache,
  withPaidCache,
} from "../src/paid-cache.ts";
import { getSharedDb, SharedDb } from "../src/shared-db.ts";

const paths: string[] = [];
function workspace(): Ledger {
  const path = join(
    tmpdir(),
    `oneshot-gtm-paid-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  paths.push(path);
  return new Ledger(path);
}

let a: Ledger;
let b: Ledger;

beforeEach(() => {
  a = workspace();
  b = workspace();
  h.ledger = a;
  process.env["AGENT_PRIVATE_KEY"] = "0xtest";
  personProfileMock.mockClear();
  personFindMock.mockClear();
  _resetPaidCache();
});

afterEach(() => {
  a.close();
  b.close();
  delete process.env["AGENT_PRIVATE_KEY"];
  for (const p of paths.splice(0)) rmSync(p, { force: true });
});

const ctx = { playName: "test-play" };
const receiptsFor = (ledger: Ledger, callType: string) =>
  ledger.listReceipts({ limit: 50 }).filter((r) => r.call_type === callType);

describe("a hit", () => {
  it("returns cost 0 and receiptId 0, writes no receipt, and counts the saving", async () => {
    const first = await enrichProfile({ email: "pat@acme.com" }, ctx);
    expect(first.receiptId).toBeGreaterThan(0);
    expect(first.result.cost).toBe(0.005);

    const second = await enrichProfile({ email: "pat@acme.com" }, ctx);
    expect(personProfileMock).toHaveBeenCalledTimes(1);
    expect(second.receiptId).toBe(0);
    expect(second.result.cost).toBe(0);
    expect(second.result.profile?.full_name).toBe("Pat Lee");
    expect(second.cached?.fetchedAt).toBeTruthy();
    expect(receiptsFor(a, "enrich.profile")).toHaveLength(1);

    const stat = paidCacheStats(7).find((s) => s.callType === "enrich.profile");
    expect(stat).toMatchObject({ hits: 1, purchases: 1 });
    expect(stat?.savedUsd).toBeCloseTo(0.005);
    expect(stat?.servedShare).toBe(0.5);
  });

  it("answers a second workspace from the first one's purchase", async () => {
    await peopleSearch({ companyDomains: ["acme.com"], jobTitles: ["CTO"] }, ctx);
    h.ledger = b;
    const again = await peopleSearch({ companyDomains: ["acme.com"], jobTitles: ["CTO"] }, ctx);
    expect(personFindMock).toHaveBeenCalledTimes(1);
    expect(again.receiptId).toBe(0);
    expect(receiptsFor(a, "research.people")).toHaveLength(1);
    expect(receiptsFor(b, "research.people")).toHaveLength(0);
  });

  it("files an enrich by LinkedIn URL under the email it surfaced", async () => {
    await enrichProfile({ linkedinUrl: "https://www.linkedin.com/in/pat-lee/" }, ctx);
    const byEmail = await enrichProfile({ email: "PAT@acme.com" }, ctx);
    expect(personProfileMock).toHaveBeenCalledTimes(1);
    expect(byEmail.receiptId).toBe(0);
  });
});

describe("the key", () => {
  it("ignores case, a canonical LinkedIn URL's spelling, array order, empties and timeouts", () => {
    expect(paidCacheKey("enrich.profile", { email: " Pat@Acme.COM " })).toBe(
      paidCacheKey("enrich.profile", { email: "pat@acme.com" }),
    );
    expect(
      paidCacheKey("research.person", {
        socialMediaUrl: "https://www.linkedin.com/in/Pat-Lee/?trk=feed",
      }),
    ).toBe(paidCacheKey("research.person", { socialMediaUrl: "linkedin.com/in/pat-lee" }));
    expect(
      paidCacheKey("research.people", { companyDomains: ["B.com", "www.a.com"], keywords: [] }),
    ).toBe(paidCacheKey("research.people", { companyDomains: ["a.com", "b.com"] }));
    expect(paidCacheKey("enrich.company", { domain: "acme.com", timeoutMs: 30_000 })).toBe(
      paidCacheKey("enrich.company", { domain: "https://acme.com/" }),
    );
    // A listing page's query is part of the page.
    expect(paidCacheKey("web.read", { url: "https://x.example/list?page=2" })).not.toBe(
      paidCacheKey("web.read", { url: "https://x.example/list?page=1" }),
    );
    // The strongest identifier names the person; hints do not split the key.
    expect(
      paidCacheKey("research.person", { socialMediaUrl: "https://github.com/pat", name: "Pat" }),
    ).toBe(paidCacheKey("research.person", { socialMediaUrl: "https://github.com/Pat" }));
    expect(
      paidCacheKey("email.find", { firstName: "Pat", lastName: "Lee", companyDomain: "a.com" }),
    ).toBe(paidCacheKey("email.find", { fullName: "pat lee", companyDomain: "A.com" }));
  });
});

describe("what is stored", () => {
  it("never stores a failed or error status", async () => {
    const buy = vi.fn(async () => ({ result: { status: "error", cost: 0.01 }, receiptId: 7 }));
    await withPaidCache("research.company", { name: "Acme" }, undefined, buy);
    await withPaidCache("research.company", { name: "Acme" }, undefined, buy);
    expect(buy).toHaveBeenCalledTimes(2);
    expect(readPaidCache("research.company", { name: "Acme" })).toBeNull();
  });

  it("keeps a genuine failure as a negative entry, never a transient one or a rate limit", async () => {
    const genuine = vi.fn(async () => {
      throw new Error("person not found");
    });
    await expect(
      withPaidCache("research.person", { email: "x@a.com" }, undefined, genuine),
    ).rejects.toThrow("person not found");
    await expect(
      withPaidCache("research.person", { email: "x@a.com" }, undefined, genuine),
    ).rejects.toBeInstanceOf(CachedPaidFailureError);
    expect(genuine).toHaveBeenCalledTimes(1);
    expect(hasCached("research.person", { email: "x@a.com" })).toBe(false);
    expect(hasCached("research.person", { email: "x@a.com" }, { includeFailures: true })).toBe(
      true,
    );

    for (const message of [
      "Tool execution failed",
      "HTTP 429",
      "payment rejected: invalid_payload",
    ]) {
      const transient = vi.fn(async () => {
        throw new Error(message);
      });
      await expect(
        withPaidCache("web.read", { url: "https://t.example" }, undefined, transient),
      ).rejects.toThrow();
      await expect(
        withPaidCache("web.read", { url: "https://t.example" }, undefined, transient),
      ).rejects.toThrow(message);
      expect(transient).toHaveBeenCalledTimes(2);
    }
    expect(isNegativeCacheable(Object.assign(new Error("bad"), { name: "ValidationError" }))).toBe(
      false,
    );
    expect(isNegativeCacheable(new Error("Agent wallet credentials missing"))).toBe(false);
    expect(isNegativeCacheable(Object.assign(new Error("nope"), { statusCode: 403 }))).toBe(false);
  });

  it("a failed refresh never erases a result that still answers", async () => {
    await withPaidCache("enrich.company", { domain: "acme.com" }, undefined, async () => ({
      result: { status: "completed", company: { name: "Acme" }, cost: 0.005 },
      receiptId: 1,
    }));
    await expect(
      withPaidCache("enrich.company", { domain: "acme.com" }, { fresh: true }, async () => {
        throw new Error("company not found");
      }),
    ).rejects.toThrow();
    expect(readPaidCache("enrich.company", { domain: "acme.com" })?.status).toBe("ok");
  });

  it("a linkedin.profile view error is never a negative entry", async () => {
    const view = vi.fn(async () => {
      throw new Error("Reconnect this LinkedIn account");
    });
    await expect(
      withPaidCache("linkedin.profile", { url: "https://linkedin.com/in/x" }, undefined, view),
    ).rejects.toThrow();
    await expect(
      withPaidCache("linkedin.profile", { url: "https://linkedin.com/in/x" }, undefined, view),
    ).rejects.toThrow("Reconnect");
    expect(view).toHaveBeenCalledTimes(2);
  });
});

describe("expiry and options", () => {
  const seed = (callType: "web.read" | "research.person", input: object, ageMs: number) =>
    getSharedDb().setPaidCache({
      key: paidCacheKey(callType, input),
      callType,
      status: "ok",
      resultJson: JSON.stringify({ status: "completed", markdown: "old", cost: 0.01 }),
      costUsd: 0.01,
      fetchedAt: new Date(Date.now() - ageMs).toISOString(),
    });
  const buy = () =>
    vi.fn(async () => ({
      result: { status: "completed", markdown: "new", cost: 0.01 },
      receiptId: 3,
    }));

  it("buys again past the type's expiry", async () => {
    seed("web.read", { url: "https://e.example" }, 13 * 3600 * 1000); // web.read keeps 12h
    const fn = buy();
    const out = await withPaidCache("web.read", { url: "https://e.example" }, undefined, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(out.receiptId).toBe(3);
  });

  it("answers inside the expiry, and maxAgeMs moves it either way", async () => {
    seed("research.person", { email: "p@a.com" }, 10 * 24 * 3600 * 1000);
    const fn = buy();
    expect(
      (await withPaidCache("research.person", { email: "p@a.com" }, undefined, fn)).receiptId,
    ).toBe(0);
    expect(
      (
        await withPaidCache(
          "research.person",
          { email: "p@a.com" },
          { maxAgeMs: 24 * 3600 * 1000 },
          fn,
        )
      ).receiptId,
    ).toBe(3);
    seed("web.read", { url: "https://f.example" }, 5 * 24 * 3600 * 1000);
    const read = buy();
    const out = await withPaidCache(
      "web.read",
      { url: "https://f.example" },
      { maxAgeMs: 30 * 24 * 3600 * 1000 },
      read,
    );
    expect(read).not.toHaveBeenCalled();
    expect(out.result).toMatchObject({ markdown: "old", cost: 0 });
  });

  it("fresh skips the read but still stores; cacheOnly never buys", async () => {
    seed("research.person", { email: "q@a.com" }, 1000);
    const fn = buy();
    const fresh = await withPaidCache("research.person", { email: "q@a.com" }, { fresh: true }, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fresh.receiptId).toBe(3);
    const entry = readPaidCache("research.person", { email: "q@a.com" });
    expect(entry?.status === "ok" && entry.result).toMatchObject({ markdown: "new" });

    const never = buy();
    await expect(
      withPaidCache("research.person", { email: "nobody@a.com" }, { cacheOnly: true }, never),
    ).rejects.toBeInstanceOf(PaidCacheMissError);
    expect(never).not.toHaveBeenCalled();
  });
});

describe("hostile input", () => {
  it("keys a long run of '#', '/' or '?' in linear time", () => {
    const started = performance.now();
    for (const c of ["#", "/", "?"]) {
      const run = c.repeat(200_000);
      paidCacheKey("enrich.company", { domain: `${c}${run}x` });
      paidCacheKey("research.people", { companyDomains: [`a.com${run}`] });
      paidCacheKey("web.read", { url: `https://e.example/${run}` });
    }
    expect(performance.now() - started).toBeLessThan(2000);
    expect(paidCacheKey("enrich.company", { domain: "acme.com#x?y/z" })).toBe(
      paidCacheKey("enrich.company", { domain: "acme.com" }),
    );
    expect(paidCacheKey("web.read", { url: "https://e.example/a///" })).toBe(
      paidCacheKey("web.read", { url: "https://e.example/a" }),
    );
  });
});

describe("status codes", () => {
  it("a 5xx, 408 or 429 status is never a negative entry, whatever the message", async () => {
    for (const statusCode of [500, 502, 503, 504, 520, 408, 429]) {
      const err = Object.assign(new Error("Service Unavailable"), { statusCode });
      expect(isNegativeCacheable(err), String(statusCode)).toBe(false);
    }
    const outage = vi.fn(async () => {
      throw Object.assign(new Error("Bad Gateway"), { statusCode: 502 });
    });
    const input = { domain: "outage.example" };
    await expect(withPaidCache("enrich.company", input, undefined, outage)).rejects.toThrow();
    await expect(withPaidCache("enrich.company", input, undefined, outage)).rejects.toThrow(
      "Bad Gateway",
    );
    expect(outage).toHaveBeenCalledTimes(2);
    expect(isNegativeCacheable(Object.assign(new Error("gone"), { statusCode: 404 }))).toBe(true);
  });
});

const at = (ageMs: number) => new Date(Date.now() - ageMs).toISOString();

describe("pruning", () => {
  it("deletes rows past their keep window and never a fresh one", () => {
    const shared = getSharedDb();
    const put = (
      callType: "web.read" | "research.person",
      input: object,
      status: "ok" | "failed",
      ageMs: number,
    ) =>
      shared.setPaidCache({
        key: paidCacheKey(callType, input),
        callType,
        status,
        resultJson: JSON.stringify(status === "ok" ? { status: "completed" } : { message: "x" }),
        costUsd: 0.01,
        fetchedAt: at(ageMs),
      });
    const H = 3600 * 1000;
    const D = 24 * H;
    put("web.read", { url: "https://old.example" }, "ok", 13 * H); // past 12h
    put("web.read", { url: "https://new.example" }, "ok", 11 * H);
    put("web.read", { url: "https://bad.example" }, "failed", 13 * H);
    put("research.person", { email: "stale@a.com" }, "ok", 120 * D); // expired, kept for display
    put("research.person", { email: "ancient@a.com" }, "ok", 400 * D);
    put("research.person", { email: "nope@a.com" }, "failed", 4 * D);
    put("research.person", { email: "recent-fail@a.com" }, "failed", 1 * D);

    expect(prunePaidCache(shared)).toBe(4);
    const has = (callType: "web.read" | "research.person", input: object) =>
      shared.getPaidCache(paidCacheKey(callType, input)) !== null;
    expect(has("web.read", { url: "https://old.example" })).toBe(false);
    expect(has("web.read", { url: "https://new.example" })).toBe(true);
    expect(has("web.read", { url: "https://bad.example" })).toBe(false);
    expect(has("research.person", { email: "stale@a.com" })).toBe(true);
    expect(has("research.person", { email: "ancient@a.com" })).toBe(false);
    expect(has("research.person", { email: "nope@a.com" })).toBe(false);
    expect(has("research.person", { email: "recent-fail@a.com" })).toBe(true);
    // Nothing left to prune.
    expect(prunePaidCache(shared)).toBe(0);
  });
});

const boom = () => {
  throw new Error("database is locked");
};

describe("a broken cache", () => {
  it("never fails the lookup: a read error is a miss, a write error is logged", async () => {
    const shared = getSharedDb();
    vi.spyOn(shared, "getPaidCache").mockImplementation(boom);
    vi.spyOn(shared, "setPaidCache").mockImplementation(boom);
    vi.spyOn(shared, "recordPaidCachePurchase").mockImplementation(boom);
    try {
      const out = await withPaidCache("research.deep", { topic: "x" }, undefined, async () => ({
        result: { status: "completed", cost: 0.1 },
        receiptId: 4,
      }));
      expect(out.receiptId).toBe(4);
      await expect(
        withPaidCache("research.deep", { topic: "y" }, undefined, async () => {
          throw new Error("topic not found");
        }),
      ).rejects.toThrow("topic not found");
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("in flight", () => {
  it("two concurrent calls for one key make one purchase; the joiner pays nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fn = vi.fn(async () => {
      await gate;
      return { result: { status: "completed", results: [], cost: 0.01 }, receiptId: 9 };
    });
    const one = withPaidCache("local.search", { location: ["Austin, TX"] }, undefined, fn);
    const two = withPaidCache("local.search", { location: ["austin, tx"] }, undefined, fn);
    release();
    const [x, y] = await Promise.all([one, two]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(x.receiptId).toBe(9);
    expect(y.receiptId).toBe(0);
    expect(y.result).toMatchObject({ cost: 0 });
  });
});

describe("legacy import", () => {
  it("maps the old per-site keys to the central keys, keeps fetched_at, and runs once", () => {
    const path = join(tmpdir(), `oneshot-gtm-paid-import-${Date.now()}.sqlite`);
    paths.push(path);
    const shared = new SharedDb(path);
    const old = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    const raw = (email: string, json: unknown, status: string | null = null) => ({
      email,
      result_json: JSON.stringify(json),
      fetched_at: old,
      status,
    });
    vi.spyOn(shared, "allCachedEnrichment").mockReturnValue([
      raw("person:https://www.linkedin.com/in/pat-lee", { status: "completed", cost: 0.05 }),
      raw("person:pat@acme.com", { failed: true, message: "no person" }, "failed"),
      raw("newsfeed:https://www.linkedin.com/in/pat-lee", { result: [], cost: 0.07 }),
      raw("pat@acme.com", { profile: { full_name: "Pat" }, cost: 0.005 }),
      raw("linkedin-profile:https://linkedin.com/in/pat-lee", { url: "u", experience: [] }),
      raw("linkedin-profile:incomplete:abc:1", { incomplete: true }),
      raw("linkedin-gate:reads", { nextAllowedAt: 1 }),
      raw("webread:acme.com", { text: "hi" }),
    ]);
    try {
      const expected = {
        "research.person": { ok: 1, failed: 1 },
        "research.newsfeed": { ok: 1, failed: 0 },
        "enrich.profile": { ok: 1, failed: 0 },
        "linkedin.profile_read": { ok: 1, failed: 0 },
      };
      const dry = importLegacyPaidResults(shared, { dryRun: true });
      expect(dry).toMatchObject({ byType: expected, skipped: 3, existing: 0 });
      const key = paidCacheKey("research.person", {
        socialMediaUrl: "https://linkedin.com/in/Pat-Lee/",
      });
      expect(shared.getPaidCache(key)).toBeNull();

      expect(importLegacyPaidResults(shared)).toMatchObject({ byType: expected, skipped: 3 });
      expect(shared.getPaidCache(key)).toMatchObject({
        call_type: "research.person",
        status: "ok",
        fetched_at: old,
        cost_usd: 0.05,
      });
      expect(
        shared.getPaidCache(paidCacheKey("research.person", { email: "pat@acme.com" }))?.status,
      ).toBe("failed");
      expect(
        shared.getPaidCache(paidCacheKey("enrich.profile", { email: "Pat@Acme.com" }))?.call_type,
      ).toBe("enrich.profile");
      // Once per shared file.
      expect(importLegacyPaidResults(shared)).toBeNull();
    } finally {
      vi.restoreAllMocks();
      shared.close();
    }
    expect(legacyKeyInput("linkedin-profile:incomplete:abc:1")).toBeNull();
    expect(legacyKeyInput("webread:acme.com")).toBeNull();
  });
});
