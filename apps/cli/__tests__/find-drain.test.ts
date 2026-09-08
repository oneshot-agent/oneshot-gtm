import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DrainOutcome } from "@oneshot-gtm/find";

/**
 * Stubbed drain: `--fail-on-empty`'s exit code has to be provable without a
 * ledger, an LLM call or a send, so `drainQueue` just replays whatever outcome
 * the case set (or throws, for the failure path).
 */
let nextOutcome: DrainOutcome = { drained: 0, sent: 0, deferred: 0, errors: [] };
let nextThrow: Error | null = null;

vi.mock("@oneshot-gtm/find", () => ({
  drainQueue: async () => {
    if (nextThrow) throw nextThrow;
    return nextOutcome;
  },
  // Imported by the module under test (find watch); never called here.
  runDueTriggers: async () => {
    throw new Error("runDueTriggers must not run in these tests");
  },
  nextSleepMs: () => 60_000,
}));

const { commandFindDrain } = await import("../src/commands/find.ts");
const { CommandExit } = await import("../src/output.ts");

function outcome(over: Partial<DrainOutcome> = {}): DrainOutcome {
  return { drained: 0, sent: 0, deferred: 0, errors: [], ...over };
}

let stdout: string[] = [];
let stderr: string[] = [];
let writeSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  nextOutcome = outcome();
  nextThrow = null;
  stdout = [];
  stderr = [];
  writeSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(
      (
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error | undefined) => void),
        callback?: (error?: Error | undefined) => void,
      ) => {
        stdout.push(String(chunk));
        if (typeof encodingOrCallback === "function") encodingOrCallback();
        else callback?.();
        return true;
      },
    );
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  writeSpy.mockRestore();
  errSpy.mockRestore();
});

describe("commandFindDrain without --fail-on-empty", () => {
  it("exits 0 when nothing was drained", async () => {
    nextOutcome = outcome({ drained: 0 });
    await expect(
      commandFindDrain({ play: "podcast-guest", dryRun: true }),
    ).resolves.toBeUndefined();
    expect(stdout.join("")).toContain("No approved rows");
    expect(stderr.join("")).toBe("");
  });

  it("exits 0 even when rows errored", async () => {
    nextOutcome = outcome({ drained: 2, sent: 1, errors: [{ id: 7, message: "send failed" }] });
    await expect(
      commandFindDrain({ play: "podcast-guest", dryRun: false }),
    ).resolves.toBeUndefined();
    expect(stdout.join("")).toContain("send failed");
  });
});

describe("commandFindDrain --fail-on-empty", () => {
  it("exits 2 and names the play when nothing was drained", async () => {
    nextOutcome = outcome({ drained: 0 });
    const err = await commandFindDrain({
      play: "podcast-guest",
      dryRun: true,
      failOnEmpty: true,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandExit);
    expect((err as InstanceType<typeof CommandExit>).code).toBe(2);
    const line = stderr.join("");
    expect(line).toContain("find drain podcast-guest");
    expect(line).toContain("0 rows drained");
    expect(line.trimEnd().split("\n")).toHaveLength(1);
  });

  it("exits 0 when at least one row was drained", async () => {
    nextOutcome = outcome({ drained: 3, sent: 3 });
    await expect(
      commandFindDrain({ play: "podcast-guest", dryRun: false, failOnEmpty: true }),
    ).resolves.toBeUndefined();
    expect(stderr.join("")).toBe("");
  });

  it("exits 1 when a row errored", async () => {
    nextOutcome = outcome({ drained: 2, sent: 1, errors: [{ id: 7, message: "send failed" }] });
    const err = await commandFindDrain({
      play: "podcast-guest",
      dryRun: false,
      failOnEmpty: true,
    }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof CommandExit>).code).toBe(1);
    // The empty-run line is for empty runs only; this one is broken, not idle.
    expect(stderr.join("")).toBe("");
  });

  it("propagates a drain failure as a thrown error (exit 1 at the top level)", async () => {
    nextThrow = new Error("ledger locked");
    await expect(
      commandFindDrain({ play: "podcast-guest", dryRun: false, failOnEmpty: true }),
    ).rejects.toThrow("ledger locked");
  });

  it("exits 1 (not 2) when an invalid play has no approved rows", async () => {
    // Regression test for finding PRRT_kwDOSKzrBs6dhQnV: drainQueue validates
    // the play before checking if rows are empty, so the CLI sees the error
    // first and exits 1 (invalid play) instead of 2 (empty drain).
    nextOutcome = outcome({
      drained: 0,
      errors: [{ id: -1, message: "drain: unsupported play 'no-such-play'" }],
    });
    const err = await commandFindDrain({
      play: "no-such-play",
      dryRun: false,
      failOnEmpty: true,
    }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof CommandExit>).code).toBe(1);
    expect(stdout.join("")).toContain("unsupported play");
  });
});
