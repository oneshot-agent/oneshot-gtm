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

  it("drops unknown or malformed values", () => {
    expect(validateQueueSearch({ status: "bogus", play: "", order: "oldest" })).toEqual({});
    expect(validateQueueSearch({ status: 1, play: 2 })).toEqual({});
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
  });
});
