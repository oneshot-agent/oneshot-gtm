import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The wallet balance is read at most once a day: the masthead polls the
// doctor every minute, and a chain read does not change minute to minute.
// Real ledger (vitest.setup points ONESHOT_GTM_HOME at a temp dir); only the
// SDK balance call is mocked, counted so the cache can be proven to hold.

let reads = 0;
let balanceValue = "26.890849";

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getBalance: async () => {
      reads += 1;
      return { balance: balanceValue, raw: balanceValue };
    },
  };
});

const { cachedBalance, BALANCE_CACHE_MS } = await import("../src/check.ts");
const { getLedger } = await import("@oneshot-gtm/core");

beforeEach(() => {
  reads = 0;
  // Start every test without a cached read.
  getLedger().setProductResearchCache("wallet-balance", "");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cachedBalance", () => {
  it("reads once, then serves the cached value with its original timestamp", async () => {
    const first = await cachedBalance();
    expect(first).toMatchObject({ balance: "26.890849", cached: false });
    const second = await cachedBalance();
    expect(second).toEqual({ balance: "26.890849", checkedAt: first.checkedAt, cached: true });
    expect(reads).toBe(1);
  });

  it("re-reads on refresh and after the day-old cache expires", async () => {
    await cachedBalance();
    balanceValue = "0.0";
    const forced = await cachedBalance(true);
    expect(forced).toMatchObject({ balance: "0.0", cached: false });
    expect(reads).toBe(2);
    // Now the cache holds "0.0"; a plain read serves it…
    expect((await cachedBalance()).cached).toBe(true);
    // …until it is older than a day.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + BALANCE_CACHE_MS + 60_000);
    balanceValue = "40.00";
    const stale = await cachedBalance();
    expect(stale).toMatchObject({ balance: "40.00", cached: false });
    expect(reads).toBe(3);
  });
});
