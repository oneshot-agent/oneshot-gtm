import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinderResult, TriggerRunOutcome } from "@oneshot-gtm/find";

/**
 * Tests for #99: --json output on read-only commands
 * Verifies:
 * - stdout is parseable JSON with no ANSI codes
 * - schemaVersion exists in all payloads
 * - human/progress output goes to stderr, not stdout
 * - exit codes unchanged (find watch --once still exits 1 on error)
 */

// Local type mirror since CheckResult isn't exported from @oneshot-gtm/doctor
interface CheckResult {
  name: string;
  group: string;
  severity: "ok" | "warn" | "fail";
  message: string;
  hint?: string;
}

// Track what was written to stdout/stderr separately
let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

// Doctor mocks
let doctorResults: CheckResult[] = [];

vi.mock("@oneshot-gtm/doctor", () => ({
  runDoctor: async () => doctorResults,
}));

// Find mocks
let findTriggerOutcomes: TriggerRunOutcome[] = [];
let drainResult = {
  drained: 0,
  sent: 0,
  deferred: 0,
  errors: [] as { id: string; message: string }[],
};

vi.mock("@oneshot-gtm/find", () => ({
  runDueTriggers: async () => findTriggerOutcomes,
  drainQueue: async () => drainResult,
  nextSleepMs: () => 60_000,
}));

// Import commands after mocks are set up
const { commandDoctor } = await import("../src/commands/doctor.ts");
const { commandFindWatch, commandFindDrain } = await import("../src/commands/find.ts");
const { CommandExit } = await import("../src/output.ts");

beforeEach(() => {
  stdoutChunks = [];
  stderrChunks = [];
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

/** Check if a string contains ANSI escape codes */
function hasAnsiCodes(s: string): boolean {
  return /\x1b\[|\u001b\[/.test(s);
}

describe("doctor --json", () => {
  const PASS: CheckResult = {
    name: "GitHub token",
    group: "Deliverability",
    severity: "ok",
    message: "Valid",
  };
  const WARN: CheckResult = {
    name: "X credentials",
    group: "Deliverability",
    severity: "warn",
    message: "Missing",
    hint: "Set TWITTER_USERNAME and TWITTER_PASSWORD",
  };
  const FAIL: CheckResult = {
    name: "Gmail placement",
    group: "Deliverability",
    severity: "fail",
    message: "No Gmail accounts",
  };

  it("emits valid JSON with schemaVersion on stdout", async () => {
    doctorResults = [PASS];
    await commandDoctor({ json: true });

    const stdout = stdoutChunks.join("");
    expect(stdout.trim()).toBeTruthy();
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("schemaVersion");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.command).toBe("doctor");
    expect(parsed.ok).toBe(true);
    expect(parsed.failed).toBe(0);
    expect(parsed.warned).toBe(0);
    expect(parsed.checks).toHaveLength(1);
  });

  it("stdout has no ANSI codes in --json mode", async () => {
    doctorResults = [PASS, WARN];
    await commandDoctor({ json: true });

    const stdout = stdoutChunks.join("");
    expect(hasAnsiCodes(stdout)).toBe(false);
  });

  it("human output goes to stderr, not stdout", async () => {
    doctorResults = [PASS];
    await commandDoctor({ json: true });

    const stdout = stdoutChunks.join("");
    const stderr = stderrChunks.join("");

    // Stdout should be ONLY the JSON document
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(() => JSON.parse(stdout)).not.toThrow();

    // Human headers/progress should be on stderr
    expect(stderr).toContain("doctor");
  });

  it("exit code unchanged on failure", async () => {
    doctorResults = [FAIL];
    const err = await commandDoctor({ json: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandExit);
    expect((err as InstanceType<typeof CommandExit>).code).toBe(1);

    // JSON still emitted before bail
    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.failed).toBe(1);
  });

  it("includes all check fields in JSON payload", async () => {
    doctorResults = [PASS, WARN, FAIL];
    const err = await commandDoctor({ json: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandExit); // fails due to FAIL

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed.checks).toHaveLength(3);
    expect(parsed.checks[0]).toMatchObject({
      name: "GitHub token",
      group: "Deliverability",
      severity: "ok",
      message: "Valid",
    });
    expect(parsed.checks[1]).toMatchObject({
      name: "X credentials",
      severity: "warn",
      hint: "Set TWITTER_USERNAME and TWITTER_PASSWORD",
    });
  });

  it("warnings go to stderr, stdout is still clean JSON", async () => {
    doctorResults = [WARN];
    await commandDoctor({ json: true });

    const stdout = stdoutChunks.join("");
    const stderr = stderrChunks.join("");

    // Stdout should be ONLY the JSON document, parseable with no extra lines
    expect(stdout.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.warned).toBe(1);

    // Warning detail should be on stderr
    expect(stderr).toContain("Missing");
  });
});

describe("find watch --once --json", () => {
  const RESULT: FinderResult = {
    source: "stub",
    candidates: 5,
    droppedIcp: 1,
    droppedDuplicate: 1,
    droppedEnrichment: 0,
    enqueued: 3,
    costUsd: 0.25,
  };

  it("emits valid JSON with schemaVersion", async () => {
    findTriggerOutcomes = [
      { name: "trigger-a", fired: true, result: RESULT, nextDueInMs: 3600_000, duration_ms: 1234 },
    ];
    await commandFindWatch({ once: true, quiet: true, json: true });

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("schemaVersion", 1);
    expect(parsed.command).toBe("find watch");
    expect(parsed.ok).toBe(true);
    expect(parsed.errored).toBe(0);
    expect(parsed.triggers).toHaveLength(1);
    expect(parsed.triggers[0]).toMatchObject({
      name: "trigger-a",
      fired: true,
      nextDueInMs: 3600_000,
      durationMs: 1234,
    });
  });

  it("stdout has no ANSI codes", async () => {
    findTriggerOutcomes = [
      { name: "trigger-a", fired: true, result: RESULT, nextDueInMs: 3600_000 },
    ];
    await commandFindWatch({ once: true, quiet: true, json: true });

    const stdout = stdoutChunks.join("");
    expect(hasAnsiCodes(stdout)).toBe(false);
  });

  it("exits 1 on error, JSON still emitted", async () => {
    findTriggerOutcomes = [
      { name: "trigger-a", fired: true, result: RESULT, nextDueInMs: 3600_000 },
      { name: "trigger-b", fired: true, error: "API 403", nextDueInMs: 3600_000 },
    ];
    const err = await commandFindWatch({ once: true, quiet: true, json: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CommandExit);
    expect((err as InstanceType<typeof CommandExit>).code).toBe(1);

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.errored).toBe(1);
    expect(parsed.triggers[1]).toMatchObject({
      name: "trigger-b",
      fired: true,
      error: "API 403",
    });
  });

  it("includes finder result fields in trigger payload", async () => {
    const richResult: FinderResult = {
      source: "github-stars",
      candidates: 12,
      droppedIcp: 3,
      droppedRole: 2,
      droppedDuplicate: 1,
      droppedEnrichment: 1,
      droppedLowSignal: 1,
      enqueued: 4,
      costUsd: 0.5,
      halted: "budget cap",
    };
    findTriggerOutcomes = [
      { name: "gh", fired: true, result: richResult, nextDueInMs: 7200_000 },
    ];
    await commandFindWatch({ once: true, quiet: true, json: true });

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed.triggers[0].result).toMatchObject({
      source: "github-stars",
      candidates: 12,
      enqueued: 4,
      droppedIcp: 3,
      droppedRole: 2,
      droppedDuplicate: 1,
      droppedEnrichment: 1,
      droppedLowSignal: 1,
      costUsd: 0.5,
      halted: "budget cap",
    });
  });
});

describe("find drain --dry-run --json", () => {
  it("emits valid JSON with schemaVersion", async () => {
    drainResult = { drained: 10, sent: 0, deferred: 10, errors: [] };
    await commandFindDrain({ play: "demo", dryRun: true, json: true });

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("schemaVersion", 1);
    expect(parsed.command).toBe("find drain");
    expect(parsed.play).toBe("demo");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.drained).toBe(10);
    expect(parsed.sent).toBe(0);
    expect(parsed.deferred).toBe(10);
  });

  it("stdout has no ANSI codes", async () => {
    drainResult = { drained: 5, sent: 5, deferred: 0, errors: [] };
    await commandFindDrain({ play: "demo", dryRun: false, json: true });

    const stdout = stdoutChunks.join("");
    expect(hasAnsiCodes(stdout)).toBe(false);
  });

  it("includes error details in JSON", async () => {
    drainResult = {
      drained: 2,
      sent: 1,
      deferred: 0,
      errors: [{ id: "row-123", message: "Enrichment failed" }],
    };
    await commandFindDrain({ play: "demo", dryRun: false, json: true });

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toMatchObject({ id: "row-123", message: "Enrichment failed" });
  });
});
