import { describe, expect, it } from "vitest";
import { sqliteToIso, toIsoUtc, toSqliteUtc } from "../src/time.ts";

describe("sqliteToIso", () => {
  it("converts SQLite datetime('now') form to ISO with a Z suffix", () => {
    expect(sqliteToIso("2026-09-08 10:00:00")).toBe("2026-09-08T10:00:00Z");
  });

  it("returns an already-ISO string unchanged", () => {
    expect(sqliteToIso("2026-09-08T10:00:00Z")).toBe("2026-09-08T10:00:00Z");
  });

  it("does not double-suffix an ISO string into the ZZ trap", () => {
    const iso = "2026-09-08T10:00:00Z";
    expect(sqliteToIso(iso)).not.toBe(`${iso}Z`);
    expect(sqliteToIso(iso)).toBe(iso);
  });

  it("leaves an ISO string with an explicit offset unchanged", () => {
    expect(sqliteToIso("2026-09-08T10:00:00+02:00")).toBe("2026-09-08T10:00:00+02:00");
  });
});

describe("toSqliteUtc", () => {
  it("passes SQLite form through unchanged", () => {
    expect(toSqliteUtc("2026-09-08 10:00:00")).toBe("2026-09-08 10:00:00");
  });

  it("converts ISO Z, offsets and Dates to UTC SQLite form", () => {
    expect(toSqliteUtc("2026-09-08T10:00:00.123Z")).toBe("2026-09-08 10:00:00");
    expect(toSqliteUtc("2026-09-08T03:00:00-07:00")).toBe("2026-09-08 10:00:00");
    expect(toSqliteUtc(new Date("2026-09-08T10:00:00Z"))).toBe("2026-09-08 10:00:00");
  });

  it("reads a zone-less ISO date-time as UTC, not local time", () => {
    expect(toSqliteUtc("2026-09-08T10:00:00")).toBe("2026-09-08 10:00:00");
    expect(toIsoUtc("2026-09-08T10:00:00.5")).toBe("2026-09-08T10:00:00.500Z");
  });

  it("returns unparseable input as-is instead of throwing", () => {
    expect(toSqliteUtc("not a date")).toBe("not a date");
  });
});

describe("toIsoUtc", () => {
  it("normalizes every accepted form to toISOString() form", () => {
    for (const input of [
      "2026-09-08 10:00:00",
      "2026-09-08T10:00:00Z",
      "2026-09-08T03:00:00-07:00",
      new Date("2026-09-08T10:00:00Z"),
    ]) {
      expect(toIsoUtc(input)).toBe("2026-09-08T10:00:00.000Z");
    }
  });
});
