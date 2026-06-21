import { describe, expect, it } from "vitest";
import { extractInvocation, toKebabCase } from "../src/dispatch.ts";

/**
 * Structural fakes for commander's Command — extractInvocation only touches
 * name(), opts(), parent, and getOptionValueSource(), so we don't need a real
 * commander program (and can pin option sources precisely).
 */
interface FakeOpts {
  name: string;
  parent?: unknown;
  opts?: Record<string, unknown>;
  sources?: Record<string, string>; // "cli" | "default" | "env" | "THROW"
}

function fakeCmd({ name, parent = null, opts = {}, sources = {} }: FakeOpts): unknown {
  return {
    name: () => name,
    opts: () => opts,
    parent,
    getOptionValueSource: (k: string) => {
      const v = sources[k];
      if (v === "THROW") throw new Error("no such option");
      return v ?? "default";
    },
  };
}

const program = fakeCmd({ name: "oneshot-gtm", parent: null });

describe("toKebabCase", () => {
  it.each([
    ["dryRun", "dry-run"],
    ["skipSms", "skip-sms"],
    ["port", "port"],
    ["fromFileName", "from-file-name"],
  ])("%s → %s", (input, expected) => {
    expect(toKebabCase(input)).toBe(expected);
  });
});

describe("extractInvocation — command path", () => {
  it("returns 'unknown' when no Command-like arg is present", () => {
    expect(extractInvocation([{ dryRun: true }, "positional"])).toEqual({
      command: "unknown",
      flags: [],
    });
  });

  it("resolves a top-level command name (stops before the root program)", () => {
    const doctor = fakeCmd({ name: "doctor", parent: program });
    expect(extractInvocation([{}, doctor]).command).toBe("doctor");
  });

  it("joins a nested group path like 'motion show-hn'", () => {
    const motion = fakeCmd({ name: "motion", parent: program });
    const showHn = fakeCmd({ name: "show-hn", parent: motion });
    expect(extractInvocation([{}, showHn]).command).toBe("motion show-hn");
  });

  it("handles a three-level path 'discover icp interview-prep'", () => {
    const discover = fakeCmd({ name: "discover", parent: program });
    const icp = fakeCmd({ name: "icp", parent: discover });
    const prep = fakeCmd({ name: "interview-prep", parent: icp });
    expect(extractInvocation([prep]).command).toBe("discover icp interview-prep");
  });

  it("picks the LAST command-like arg (commander passes the Command last)", () => {
    const a = fakeCmd({ name: "wrong", parent: program });
    const b = fakeCmd({ name: "right", parent: program });
    // options object (no name/opts fns) between them must be ignored
    expect(extractInvocation([a, { some: "opts" }, b]).command).toBe("right");
  });
});

describe("extractInvocation — flags (names only, cli-sourced)", () => {
  it("keeps only flags whose source is 'cli', kebab-cased", () => {
    const cmd = fakeCmd({
      name: "show-hn",
      parent: program,
      opts: { dryRun: true, limit: 10, skipSms: false },
      sources: { dryRun: "cli", limit: "default", skipSms: "cli" },
    });
    expect(extractInvocation([cmd]).flags).toEqual(["dry-run", "skip-sms"]);
  });

  it("excludes default- and env-sourced options", () => {
    const cmd = fakeCmd({
      name: "x",
      parent: program,
      opts: { fromEnv: "v", fromDefault: "d" },
      sources: { fromEnv: "env", fromDefault: "default" },
    });
    expect(extractInvocation([cmd]).flags).toEqual([]);
  });

  it("drops a flag whose getOptionValueSource throws", () => {
    const cmd = fakeCmd({
      name: "x",
      parent: program,
      opts: { good: true, broken: true },
      sources: { good: "cli", broken: "THROW" },
    });
    expect(extractInvocation([cmd]).flags).toEqual(["good"]);
  });

  it("returns no flags when the command has none", () => {
    const cmd = fakeCmd({ name: "doctor", parent: program });
    expect(extractInvocation([cmd]).flags).toEqual([]);
  });
});
