import { describe, expect, it } from "vitest";
import { sqliteToIso } from "../src/time.ts";

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
