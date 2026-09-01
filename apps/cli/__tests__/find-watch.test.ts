import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinderResult, TriggerRunOutcome } from "@oneshot-gtm/find";

/**
 * Stubbed registry: the exit code has to be provable without running a single
 * real finder, so `runDueTriggers` just replays whatever outcomes the case set.
 */
let nextOutcomes: TriggerRunOutcome[] = [];
const calls = { runDueTriggers: 0 };

vi.mock("@oneshot-gtm/find", () => ({
  runDueTriggers: async () => {
    calls.runDueTriggers++;
    return nextOutcomes;
  },
  nextSleepMs: () => 60_000,
  // Imported by the module under test (find drain); never called here.
  drainQueue: async () => {
    throw new Error("drainQueue must not run in these tests");
  },
}));

const { commandFindWatch } = await import("../src/commands/find.ts");
const { CommandExit } = await import("../src/output.ts");

const RESULT: FinderResult = {
  source: "stub",
  candidates: 3,
  droppedIcp: 1,
  droppedDuplicate: 0,
  droppedEnrichment: 0,
  enqueued: 2,
  costUsd: 0.12,
};

/** Fired, scanned candidates, kept none — the ledger is exactly as it was. */
const EMPTY_RESULT: FinderResult = {
  source: "stub",
  candidates: 4,
  droppedIcp: 1,
  droppedDuplicate: 3,
  droppedEnrichment: 0,
  enqueued: 0,
  costUsd: 0.04,
};

function ran(name: string): TriggerRunOutcome {
  return { name, fired: true, result: RESULT, nextDueInMs: 3600_000 };
}

function ranEmpty(name: string): TriggerRunOutcome {
  return { name, fired: true, result: EMPTY_RESULT, nextDueInMs: 3600_000 };
}

function errored(name: string, error = "boom"): TriggerRunOutcome {
  return { name, fired: true, error, nextDueInMs: 3600_000 };
}

function notDue(name: string): TriggerRunOutcome {
  return { name, fired: false, nextDueInMs: 3600_000 };
}

let stdout: string[] = [];
let stderr: string[] = [];
let writeSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  calls.runDueTriggers = 0;
  nextOutcomes = [];
  stdout = [];
  stderr = [];
  writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  writeSpy.mockRestore();
  errSpy.mockRestore();
});

describe("commandFindWatch --once", () => {
  it("exits 0 when every due trigger succeeds", async () => {
    nextOutcomes = [ran("show-hn"), ran("github-stars")];
    await expect(commandFindWatch({ once: true, quiet: true })).resolves.toBeUndefined();
    expect(calls.runDueTriggers).toBe(1);
  });

  it("exits 1 when a due trigger errors", async () => {
    nextOutcomes = [ran("show-hn"), errored("github-stars", "GitHub 403")];
    const err = await commandFindWatch({ once: true, quiet: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandExit);
    expect((err as InstanceType<typeof CommandExit>).code).toBe(1);
    // The per-trigger detail still prints — the exit code is additive signal.
    expect(stdout.join("")).toContain("GitHub 403");
  });

  it("exits 0 when no trigger is due", async () => {
    nextOutcomes = [notDue("show-hn"), notDue("github-stars")];
    await expect(commandFindWatch({ once: true, quiet: true })).resolves.toBeUndefined();
  });

  it("exits 0 on an empty run without the flag", async () => {
    nextOutcomes = [ranEmpty("show-hn"), notDue("github-stars")];
    await expect(commandFindWatch({ once: true, quiet: true })).resolves.toBeUndefined();
    expect(stderr.join("")).toBe("");
  });

  it("leaves no signal handlers behind", async () => {
    const before = process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");
    nextOutcomes = [ran("show-hn")];
    await commandFindWatch({ once: true, quiet: true });
    nextOutcomes = [errored("show-hn")];
    await commandFindWatch({ once: true, quiet: true }).catch(() => {});
    expect(process.listenerCount("SIGTERM") + process.listenerCount("SIGINT")).toBe(before);
  });
});

describe("commandFindWatch --once --fail-on-empty", () => {
  it("exits 2 and names the triggers when nothing was queued", async () => {
    nextOutcomes = [ranEmpty("show-hn"), ranEmpty("github-stars")];
    const err = await commandFindWatch({ once: true, quiet: true, failOnEmpty: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CommandExit);
    expect((err as InstanceType<typeof CommandExit>).code).toBe(2);
    const line = stderr.join("");
    expect(line).toContain("0 candidates queued");
    expect(line).toContain("show-hn");
    expect(line).toContain("github-stars");
    // One line, on stderr — stdout keeps the human report.
    expect(line.trimEnd().split("\n")).toHaveLength(1);
    expect(stdout.join("")).toContain("candidates=4");
  });

  it("exits 2 when no trigger was even due", async () => {
    nextOutcomes = [notDue("show-hn")];
    const err = await commandFindWatch({ once: true, quiet: true, failOnEmpty: true }).catch(
      (e: unknown) => e,
    );
    expect((err as InstanceType<typeof CommandExit>).code).toBe(2);
    expect(stderr.join("")).toContain("no triggers due");
  });

  it("exits 0 when at least one candidate was queued", async () => {
    nextOutcomes = [ranEmpty("show-hn"), ran("github-stars")];
    await expect(
      commandFindWatch({ once: true, quiet: true, failOnEmpty: true }),
    ).resolves.toBeUndefined();
    expect(stderr.join("")).toBe("");
  });

  it("exits 1, not 2, when a trigger errored on an otherwise empty run", async () => {
    nextOutcomes = [ranEmpty("show-hn"), errored("github-stars", "GitHub 403")];
    const err = await commandFindWatch({ once: true, quiet: true, failOnEmpty: true }).catch(
      (e: unknown) => e,
    );
    expect((err as InstanceType<typeof CommandExit>).code).toBe(1);
    expect(stderr.join("")).toBe("");
  });

  it("counts kept candidates, not raw ones scanned", async () => {
    // 4 scanned, 0 kept: nothing reached the queue, so this is an empty run.
    nextOutcomes = [ranEmpty("show-hn")];
    const err = await commandFindWatch({ once: true, quiet: true, failOnEmpty: true }).catch(
      (e: unknown) => e,
    );
    expect((err as InstanceType<typeof CommandExit>).code).toBe(2);
  });
});

describe("commandFindWatch daemon", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps polling after an errored trigger and exits 0 on shutdown", async () => {
    nextOutcomes = [errored("show-hn"), ran("github-stars")];
    const done = commandFindWatch({ once: false, quiet: true });

    vi.advanceTimersByTime(0);
    await new Promise(process.nextTick);
    expect(calls.runDueTriggers).toBe(1);
    vi.advanceTimersByTime(60_000);
    await new Promise(process.nextTick);
    expect(calls.runDueTriggers).toBe(2);
    vi.advanceTimersByTime(60_000);
    await new Promise(process.nextTick);
    expect(calls.runDueTriggers).toBe(3);

    // Call the loop's own SIGTERM handler rather than emitting the signal, so
    // the test never touches vitest's runner-level handlers.
    const handlers = process.listeners("SIGTERM");
    (handlers[handlers.length - 1] as () => void)();
    vi.advanceTimersByTime(0);
    await new Promise(process.nextTick);

    // Resolves — errors during a daemon tick never abort the loop.
    await expect(done).resolves.toBeUndefined();
  });
});
