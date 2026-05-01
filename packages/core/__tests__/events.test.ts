import { describe, expect, it } from "vitest";
import { buildEventLine } from "../src/events.ts";

const FIXED_NOW = new Date("2026-04-24T12:00:00.000Z");

function parseLine(line: string): Record<string, unknown> {
  expect(line.endsWith("\n")).toBe(true);
  return JSON.parse(line.slice(0, -1)) as Record<string, unknown>;
}

describe("buildEventLine — required shape", () => {
  it("always includes ts + kind + level + trailing newline", () => {
    const line = buildEventLine("test.kind", undefined, "info", null, null, FIXED_NOW);
    const parsed = parseLine(line);
    expect(parsed["ts"]).toBe("2026-04-24T12:00:00.000Z");
    expect(parsed["kind"]).toBe("test.kind");
    expect(parsed["level"]).toBe("info");
  });

  it("emits one valid JSON object per line", () => {
    const line = buildEventLine("k", { a: 1, b: "x" }, "warn", null, null, FIXED_NOW);
    expect(line.split("\n").length).toBe(2); // payload + trailing newline
    expect(() => JSON.parse(line.trim())).not.toThrow();
  });
});

describe("buildEventLine — optional fields are conditional", () => {
  it("omits ctx when undefined", () => {
    const parsed = parseLine(buildEventLine("k", undefined, "info", null, null, FIXED_NOW));
    expect("ctx" in parsed).toBe(false);
  });

  it("includes ctx when provided", () => {
    const parsed = parseLine(
      buildEventLine("k", { trigger: "show-hn", count: 3 }, "info", null, null, FIXED_NOW),
    );
    expect(parsed["ctx"]).toEqual({ trigger: "show-hn", count: 3 });
  });

  it("omits client_id when null", () => {
    const parsed = parseLine(buildEventLine("k", undefined, "info", "run-1", null, FIXED_NOW));
    expect("client_id" in parsed).toBe(false);
  });

  it("includes client_id when provided", () => {
    const parsed = parseLine(buildEventLine("k", undefined, "info", null, "abc-123", FIXED_NOW));
    expect(parsed["client_id"]).toBe("abc-123");
  });

  it("omits run_id when null", () => {
    const parsed = parseLine(buildEventLine("k", undefined, "info", null, "cid", FIXED_NOW));
    expect("run_id" in parsed).toBe(false);
  });

  it("includes run_id when provided", () => {
    const parsed = parseLine(buildEventLine("k", undefined, "info", "run-7", null, FIXED_NOW));
    expect(parsed["run_id"]).toBe("run-7");
  });
});

describe("buildEventLine — every level is honored verbatim", () => {
  it.each(["debug", "info", "warn", "error"] as const)("preserves level=%s", (level) => {
    const parsed = parseLine(buildEventLine("k", undefined, level, null, null, FIXED_NOW));
    expect(parsed["level"]).toBe(level);
  });
});

describe("buildEventLine — failure modes", () => {
  it("throws on a BigInt in ctx (caller's try/catch swallows; logEvent never crashes)", () => {
    expect(() => buildEventLine("k", { n: BigInt(42) }, "info", null, null, FIXED_NOW)).toThrow();
  });

  it("throws on a circular ref in ctx", () => {
    const c: Record<string, unknown> = { name: "loop" };
    c["self"] = c;
    expect(() => buildEventLine("k", c, "info", null, null, FIXED_NOW)).toThrow();
  });
});
