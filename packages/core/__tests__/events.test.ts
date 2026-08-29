import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../src/config.ts";
import { buildEventLine, logEvent } from "../src/events.ts";

const FIXED_NOW = new Date("2026-04-24T12:00:00.000Z");

// vitest.setup.ts points ONESHOT_GTM_HOME at a fresh temp dir per test file,
// so these paths never touch a real ~/.oneshot-gtm.
const eventsPath = join(configDir(), "events.jsonl");
const genPath = (gen: number): string => join(configDir(), `events.${gen}.jsonl`);

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

describe("logEvent — rotation", () => {
  const CEILING = 200;

  beforeEach(() => {
    mkdirSync(configDir(), { recursive: true });
    for (const p of [eventsPath, genPath(1), genPath(2), genPath(3), genPath(4)]) {
      rmSync(p, { recursive: true, force: true });
    }
    process.env["ONESHOT_GTM_MAX_EVENT_LOG_BYTES"] = String(CEILING);
  });

  afterEach(() => {
    delete process.env["ONESHOT_GTM_MAX_EVENT_LOG_BYTES"];
  });

  it("appends in place while the file is under the ceiling", () => {
    writeFileSync(eventsPath, "x".repeat(CEILING - 1));
    logEvent("rotate.under");

    expect(existsSync(genPath(1))).toBe(false);
    expect(readFileSync(eventsPath, "utf8")).toContain("rotate.under");
  });

  it("rotates once the file reaches the ceiling exactly", () => {
    writeFileSync(eventsPath, "x".repeat(CEILING));
    logEvent("rotate.at");

    expect(readFileSync(genPath(1), "utf8")).toBe("x".repeat(CEILING));
    // The live file restarts with just the new event.
    const live = readFileSync(eventsPath, "utf8");
    expect(live).toContain("rotate.at");
    expect(live.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("rotates when the file is over the ceiling", () => {
    writeFileSync(eventsPath, "x".repeat(CEILING * 3));
    logEvent("rotate.over");

    expect(existsSync(genPath(1))).toBe(true);
    expect(readFileSync(eventsPath, "utf8")).toContain("rotate.over");
  });

  it("keeps a bounded number of generations, dropping the oldest", () => {
    writeFileSync(genPath(1), "gen-1");
    writeFileSync(genPath(2), "gen-2");
    writeFileSync(genPath(3), "gen-3");
    writeFileSync(eventsPath, "x".repeat(CEILING));

    logEvent("rotate.prune");

    expect(readFileSync(genPath(2), "utf8")).toBe("gen-1");
    expect(readFileSync(genPath(3), "utf8")).toBe("gen-2");
    expect(existsSync(genPath(4))).toBe(false); // gen-3 dropped, not promoted
  });

  it("drops the event silently when rotation fails", () => {
    // A directory in the oldest slot makes the non-recursive rm throw, which
    // aborts rotation before any rename lands.
    mkdirSync(genPath(3), { recursive: true });
    writeFileSync(eventsPath, "x".repeat(CEILING));

    expect(() => logEvent("rotate.fails")).not.toThrow();
    expect(readFileSync(eventsPath, "utf8")).toBe("x".repeat(CEILING));
    expect(existsSync(genPath(1))).toBe(false);
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
