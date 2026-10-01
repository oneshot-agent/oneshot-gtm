import { describe, expect, it } from "vitest";
import { parseSince } from "../src/commands/sends.ts";

describe("sends check --since", () => {
  const now = Date.parse("2026-09-30T12:00:00.000Z");
  it("reads day, hour and minute windows", () => {
    expect(parseSince("7d", now)).toBe("2026-09-23T12:00:00.000Z");
    expect(parseSince("48h", now)).toBe("2026-09-28T12:00:00.000Z");
    expect(parseSince("90m", now)).toBe("2026-09-30T10:30:00.000Z");
  });
  it("defaults to 7 days and accepts a date", () => {
    expect(parseSince(undefined, now)).toBe("2026-09-23T12:00:00.000Z");
    expect(parseSince("2026-09-28", now)).toBe("2026-09-28T00:00:00.000Z");
  });
  it("rejects nonsense", () => {
    expect(() => parseSince("soon", now)).toThrow(/--since/);
  });
});
