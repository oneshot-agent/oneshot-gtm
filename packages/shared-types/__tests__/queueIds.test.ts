import { describe, expect, it } from "vitest";
import { parseQueueIds } from "../src/index";

// The distinction this function exists to preserve: "no pick" (undefined →
// list normally) vs "a pick that resolved to nothing" ([] → list nothing).
// Collapsing the second into the first turns a drain-selected URL into an
// unscoped drain of rows the founder never selected — which they could then send.
describe("parseQueueIds", () => {
  it("returns undefined only when the parameter is absent", () => {
    expect(parseQueueIds(null)).toBeUndefined();
    expect(parseQueueIds(undefined)).toBeUndefined();
  });

  it("returns an explicit empty pick for a present-but-empty value", () => {
    expect(parseQueueIds("")).toEqual([]);
    expect(parseQueueIds("   ")).toEqual([]);
    expect(parseQueueIds(",,")).toEqual([]);
  });

  it("returns an explicit empty pick when every token is junk", () => {
    expect(parseQueueIds("abc")).toEqual([]);
    expect(parseQueueIds("-1,0,abc")).toEqual([]);
  });

  it("rejects numeric-prefixed tokens instead of truncating them", () => {
    // parseInt("123abc") would yield 123 and load an unintended row.
    expect(parseQueueIds("123abc")).toEqual([]);
    expect(parseQueueIds("12.9")).toEqual([]);
    expect(parseQueueIds("7,123abc,9")).toEqual([7, 9]);
  });

  it("parses a normal pick, trimming whitespace", () => {
    expect(parseQueueIds("7,9,11")).toEqual([7, 9, 11]);
    expect(parseQueueIds(" 7 , 9 ")).toEqual([7, 9]);
  });

  it("caps the pick so a hand-crafted URL can't build unbounded SQL", () => {
    const raw = Array.from({ length: 600 }, (_, i) => i + 1).join(",");
    expect(parseQueueIds(raw)).toHaveLength(500);
  });
});
