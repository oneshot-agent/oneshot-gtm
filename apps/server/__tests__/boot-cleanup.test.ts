import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, LEDGER_BUSY_TIMEOUT_MS } from "../../../packages/core/src/ledger.ts";

const boot = vi.hoisted(() => ({
  ledger: undefined as Ledger | undefined,
  logEvent: vi.fn(),
  startServer: vi.fn(),
  startScheduler: vi.fn(() => ({ stop: vi.fn() })),
}));
vi.mock("@oneshot-gtm/core", () => ({
  activeSendCount: () => 0,
  BASE_PORT: 3000,
  beginDraining: vi.fn(),
  configDir: () => "unused",
  getLedger: () => boot.ledger!,
  logEvent: boot.logEvent,
  portForHome: () => 3000,
  waitForSendsToDrain: vi.fn(),
}));
vi.mock("../src/args.ts", () => ({
  parseServerArgs: () => ({ kind: "ok", port: 3000, noBrowser: true }),
  SERVER_USAGE: "",
}));
vi.mock("../src/server.ts", () => ({
  startServer: boot.startServer,
  buildFetchHandler: vi.fn(),
  SERVER_BASE_OPTS: {},
}));
vi.mock("../src/scheduler.ts", () => ({ startScheduler: boot.startScheduler }));
vi.mock("open", () => ({ default: vi.fn() }));

let dir: string;
let writer: Database;
let ledger: Ledger;
let prospectIds: number[];
const cache = globalThis as typeof globalThis & {
  __oneshotGtmServer?: unknown;
  __oneshotGtmScheduler?: unknown;
};
let signalListeners: Record<"SIGINT" | "SIGTERM", NodeJS.SignalsListener[]>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  signalListeners = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  dir = mkdtempSync(join(tmpdir(), "boot-cleanup-"));
  const path = join(dir, "ledger.sqlite");
  ledger = new Ledger(path);
  boot.ledger = ledger;
  ledger.upsertTrigger({ name: "finder", configJson: "{}" });
  ledger.markTriggerRunning("finder", new Date().toISOString());
  prospectIds = ["stranded", "sent"].map((name) => {
    const id = ledger.upsertProspect({ name, email: `${name}@example.test`, source: "test" });
    ledger.enrollCadence({
      prospectId: id,
      playName: "motion",
      nextDueAt: new Date().toISOString(),
    });
    ledger.claimCadenceSendingMarker({
      prospectId: id,
      playName: "motion",
      startedAtIso: new Date().toISOString(),
    });
    if (name === "sent") {
      ledger.recordSequenceEvent({
        prospectId: id,
        playName: "motion",
        stepIndex: 1,
        channel: "email",
        status: "sent",
      });
    }
    return id;
  });
  writer = new Database(path);
  boot.startServer.mockResolvedValue({ url: "http://localhost:3000", server: { stop: vi.fn() } });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  writer.close();
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
  delete cache.__oneshotGtmServer;
  delete cache.__oneshotGtmScheduler;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const listener of process.listeners(signal)) {
      if (!signalListeners[signal]!.includes(listener)) process.removeListener(signal, listener);
    }
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["trigger", "cadence"] as const)(
  "waits out a real ledger lock beyond the busy timeout during the %s cleanup before serving or scheduling",
  async (lockedCleanup) => {
    if (lockedCleanup === "cadence") {
      ledger.sweepStaleRunningTriggers({ now: new Date(), maxAgeMs: 0 });
    }
    const sweep = vi.spyOn(
      ledger,
      lockedCleanup === "trigger" ? "sweepStaleRunningTriggers" : "sweepStaleCadenceSends",
    );
    writer.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    const starting = import("../src/bin.ts");
    await vi.waitFor(() => expect(sweep).toHaveBeenCalled(), { timeout: 15_000 });
    // The first synchronous write exhausted the real production busy timeout.
    expect(performance.now() - started).toBeGreaterThanOrEqual(LEDGER_BUSY_TIMEOUT_MS - 100);
    expect(boot.startServer).not.toHaveBeenCalled();
    expect(boot.startScheduler).not.toHaveBeenCalled();
    writer.exec("ROLLBACK");
    await vi.advanceTimersByTimeAsync(1_000);
    await starting;
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(sweep).toHaveBeenLastCalledWith({ now: expect.any(Date), maxAgeMs: 0 });
    expect(ledger.getTrigger("finder")!.running_started_at).toBeNull();
    for (const id of prospectIds)
      expect(ledger.getCadence(id, "motion")!.sending_started_at).toBeNull();
    const events = boot.logEvent.mock.calls.map(([kind]) => kind);
    if (lockedCleanup === "trigger") expect(events).toContain("trigger.killed_by_restart");
    expect(events).toContain("cadence.send.killed_by_restart");
    expect(events).toContain("cadence.send.cleared_marker");
    expect(events).not.toContain("trigger.sweep.failed");
    expect(events).not.toContain("cadence.send.sweep_failed");
    expect(boot.startServer).toHaveBeenCalledOnce();
    expect(boot.startScheduler).toHaveBeenCalledOnce();
  },
  30_000,
);

it("gives up on persistent locks, logs each final failure once, and still starts", async () => {
  // Real lock errors, with a short SQLite timeout and fake backoff time so
  // exhausting both 60-second retry budgets does not slow down the suite.
  (ledger as unknown as { db: Database }).db.exec("PRAGMA busy_timeout = 20");
  const sweep = vi.spyOn(ledger, "sweepStaleRunningTriggers");
  writer.exec("BEGIN IMMEDIATE");
  const startedAt = Date.now();
  const starting = import("../src/bin.ts");
  await vi.waitFor(() => expect(sweep).toHaveBeenCalled());
  await vi.runAllTimersAsync();
  await starting;
  expect(sweep.mock.calls.length).toBeGreaterThan(1);
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(120_000);
  expect(Date.now() - startedAt).toBeLessThan(121_000);
  const events = boot.logEvent.mock.calls.map(([kind]) => kind);
  expect(events.filter((kind) => kind === "trigger.sweep.failed")).toHaveLength(1);
  expect(events.filter((kind) => kind === "cadence.send.sweep_failed")).toHaveLength(1);
  expect(boot.startServer).toHaveBeenCalledOnce();
  expect(boot.startScheduler).toHaveBeenCalledOnce();
  writer.exec("ROLLBACK");
});

it("does not retry non-lock errors", async () => {
  const sweep = vi.spyOn(ledger, "sweepStaleRunningTriggers").mockImplementation(() => {
    throw new Error("disk I/O error");
  });
  await import("../src/bin.ts");
  expect(sweep).toHaveBeenCalledOnce();
  expect(boot.logEvent).toHaveBeenCalledWith(
    "trigger.sweep.failed",
    { message_120: "disk I/O error" },
    "error",
  );
  expect(boot.startServer).toHaveBeenCalledOnce();
});

it.each([
  Object.assign(new Error("writer busy"), { code: "SQLITE_BUSY" }),
  new Error("database is locked"),
])("retries a lock identified by code or message: %s", async (error) => {
  const sweep = vi.spyOn(ledger, "sweepStaleRunningTriggers").mockImplementationOnce(() => {
    throw error;
  });
  const starting = import("../src/bin.ts");
  await vi.waitFor(() => expect(sweep).toHaveBeenCalled());
  expect(boot.startServer).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_000);
  await starting;
  expect(sweep).toHaveBeenCalledTimes(2);
  expect(ledger.getTrigger("finder")!.running_started_at).toBeNull();
  expect(boot.startServer).toHaveBeenCalledOnce();
});
