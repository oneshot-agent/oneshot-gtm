import { describe, expect, it } from "vitest";
import {
  hasQueueFilters,
  loadQueueFilters,
  queueFiltersKey,
  saveQueueFilters,
  validateQueueSearch,
} from "./queueSearch.ts";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

describe("validateQueueSearch", () => {
  it("keeps known filters, including all", () => {
    expect(validateQueueSearch({ status: "all", play: "show-hn", order: "ranked" })).toEqual({
      status: "all",
      play: "show-hn",
      order: "ranked",
    });
  });

  it("keeps the no-strong-offer view in the URL", () => {
    expect(validateQueueSearch({ status: "no-offer" })).toEqual({ status: "no-offer" });
    expect(hasQueueFilters({ status: "no-offer" })).toBe(true);
  });

  it("keeps the sort, show and channel filters", () => {
    expect(
      validateQueueSearch({ order: "oldest", show: "offer-ready", channel: "linkedin" }),
    ).toEqual({ order: "oldest", show: "offer-ready", channel: "linkedin" });
    expect(hasQueueFilters({ show: "has-draft" })).toBe(true);
    expect(hasQueueFilters({ channel: "email" })).toBe(true);
  });

  it("keeps the role and size filters", () => {
    expect(validateQueueSearch({ role: "operations", size: "sites:2-5" })).toEqual({
      role: "operations",
      size: "sites:2-5",
    });
    expect(validateQueueSearch({ role: "boss", size: "huge" })).toEqual({});
    expect(hasQueueFilters({ role: "leader" })).toBe(true);
    expect(hasQueueFilters({ size: "unknown" })).toBe(true);
    expect(queueFiltersKey({ role: "leader" })).not.toBe(queueFiltersKey({}));
    const storage = memoryStorage();
    saveQueueFilters({ role: "technology", size: "staff:1000+" }, storage);
    expect(loadQueueFilters(storage)).toEqual({ role: "technology", size: "staff:1000+" });
  });

  it("drops unknown or malformed values", () => {
    expect(validateQueueSearch({ status: "bogus", play: "", order: "oldest-ish" })).toEqual({});
    expect(validateQueueSearch({ status: 1, play: 2 })).toEqual({});
    expect(validateQueueSearch({ show: "drafts", channel: "fax" })).toEqual({});
  });

  it("reports whether any filter is set", () => {
    expect(hasQueueFilters({})).toBe(false);
    expect(hasQueueFilters({ play: "luma" })).toBe(true);
  });
});

describe("queue filter memory", () => {
  it("round-trips the last filters", () => {
    const storage = memoryStorage();
    saveQueueFilters({ status: "approved", play: "luma" }, storage);
    expect(loadQueueFilters(storage)).toEqual({ status: "approved", play: "luma" });
  });

  it("remembers the sort, show and channel, never the learning deep link", () => {
    const storage = memoryStorage();
    saveQueueFilters(
      {
        status: "approved",
        order: "oldest",
        show: "ready",
        channel: "email",
        learning: "icp",
        prospectId: 4,
      },
      storage,
    );
    expect(loadQueueFilters(storage)).toEqual({
      status: "approved",
      order: "oldest",
      show: "ready",
      channel: "email",
    });
  });

  it("ignores junk and throwing storage", () => {
    const storage = memoryStorage();
    storage.setItem("oneshot-gtm:queue-filters", "not json");
    expect(loadQueueFilters(storage)).toEqual({});
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadQueueFilters(broken)).toEqual({});
    expect(() => saveQueueFilters({ status: "sent" }, broken)).not.toThrow();
  });

  it("keys scroll offsets by filter set", () => {
    expect(queueFiltersKey({ play: "luma" })).not.toBe(queueFiltersKey({ play: "show-hn" }));
    expect(queueFiltersKey({})).toBe(queueFiltersKey({ status: undefined }));
    expect(queueFiltersKey({ show: "held" })).not.toBe(queueFiltersKey({ show: "ready" }));
    expect(queueFiltersKey({ channel: "email" })).not.toBe(queueFiltersKey({}));
  });
});
