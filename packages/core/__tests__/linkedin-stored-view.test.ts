import { describe, expect, it } from "vitest";
import { mergeStoredView, storedDistanceReadAt } from "../src/linkedin-connection.ts";

const OLD = "2026-10-01T00:00:00.000Z";
const NEW = "2026-10-20T00:00:00.000Z";

describe("mergeStoredView", () => {
  it("with nothing stored, the new view stands, its distance timed by its read", () => {
    expect(mergeStoredView(null, { readAt: NEW, networkDistance: "FIRST_DEGREE" })).toEqual({
      readAt: NEW,
      networkDistance: "FIRST_DEGREE",
      networkDistanceReadAt: NEW,
    });
  });

  it("a newer view without a distance keeps the older distance and when it was read", () => {
    const merged = mergeStoredView(
      { result: { headline: "Old", networkDistance: "FIRST_DEGREE" }, fetchedAt: OLD },
      { headline: "New", networkDistance: null },
    );
    expect(merged).toMatchObject({
      headline: "New",
      networkDistance: "FIRST_DEGREE",
      networkDistanceReadAt: OLD,
    });
    expect(storedDistanceReadAt(merged, NEW)).toBe(OLD);
  });

  it("a newer distance wins", () => {
    const merged = mergeStoredView(
      { result: { readAt: OLD, networkDistance: "SECOND_DEGREE" }, fetchedAt: OLD },
      { readAt: NEW, networkDistance: "FIRST_DEGREE" },
    );
    expect(merged).toMatchObject({ networkDistance: "FIRST_DEGREE", networkDistanceReadAt: NEW });
  });

  it("a partial view over a complete one keeps its Experience list and is not partial", () => {
    const merged = mergeStoredView(
      {
        result: { headline: "Founder", experience: [{ company: "Tavora", period: "Present" }] },
        fetchedAt: OLD,
      },
      { readAt: NEW, partial: true, name: "Dana Lee", networkDistance: null, experience: [] },
    );
    expect(merged).toEqual({
      headline: "Founder",
      name: "Dana Lee",
      readAt: NEW,
      experience: [{ company: "Tavora", period: "Present" }],
    });
  });

  it("a complete view over a partial one is complete", () => {
    const merged = mergeStoredView(
      {
        result: { partial: true, networkDistance: "FIRST_DEGREE", experience: [] },
        fetchedAt: OLD,
      },
      { headline: "Founder", experience: [{ company: "Tavora" }] },
    );
    expect(merged["partial"]).toBeUndefined();
    expect(merged).toMatchObject({
      networkDistance: "FIRST_DEGREE",
      networkDistanceReadAt: OLD,
      experience: [{ company: "Tavora" }],
    });
  });
});

describe("storedDistanceReadAt", () => {
  it("prefers the distance's own time, then the read's, then when it was stored", () => {
    expect(storedDistanceReadAt({ networkDistanceReadAt: OLD, readAt: NEW }, "x")).toBe(OLD);
    expect(storedDistanceReadAt({ readAt: NEW }, "x")).toBe(NEW);
    expect(storedDistanceReadAt({}, "x")).toBe("x");
    expect(storedDistanceReadAt(null, "x")).toBe("x");
  });
});
