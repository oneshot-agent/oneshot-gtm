import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../../core/src/ledger.ts";

// runPendingRetries() drains the pending_resolution table via registered
// per-finder handlers. Point the core singleton at a temp Ledger and drive the
// runner with a scripted fake handler.

let dbPath: string;
let ledger: Ledger;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, getLedger: () => ledger, logEvent: () => {} };
});

const { runPendingRetries, persistPending, registerPendingRetry, _clearPendingHandlers } =
  await import("../src/_pending.ts");
const { _resetBreaker, recordResolutionOutcome } = await import("../src/_breaker.ts");

let nextOutcome: "enqueued" | "dropped" | "platform-error" = "enqueued";
let handlerCalls = 0;

beforeEach(() => {
  dbPath = join(tmpdir(), `oneshot-pending-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  ledger = new Ledger(dbPath);
  _clearPendingHandlers();
  _resetBreaker();
  nextOutcome = "enqueued";
  handlerCalls = 0;
  registerPendingRetry("luma-events", async () => {
    handlerCalls++;
    return nextOutcome;
  });
});

afterEach(() => {
  ledger.close();
  for (const s of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${s}`);
    } catch {
      // ignore
    }
  }
});

function seed(dedupeKey: string, playName = "luma-events"): void {
  persistPending({ playName, dedupeKey, source: "luma", raw: { dedupeKey } });
}

describe("runPendingRetries", () => {
  it("enqueued outcome removes the row", async () => {
    seed("a");
    nextOutcome = "enqueued";
    const out = await runPendingRetries();
    expect(out.retried).toBe(1);
    expect(out.enqueued).toBe(1);
    expect(ledger.isPendingResolution("luma-events", "a")).toBe(false);
  });

  it("platform-error keeps the row for the next tick (and bumps attempts)", async () => {
    seed("b");
    nextOutcome = "platform-error";
    const out = await runPendingRetries();
    expect(out.deferred).toBe(1);
    expect(ledger.isPendingResolution("luma-events", "b")).toBe(true);
    expect(ledger.listPendingResolution({ playName: "luma-events" })[0]!.attempts).toBe(1);
  });

  it("dropped outcome removes the row (genuine negative on retry)", async () => {
    seed("c");
    nextOutcome = "dropped";
    await runPendingRetries();
    expect(ledger.isPendingResolution("luma-events", "c")).toBe(false);
  });

  it("a row with no registered handler is left untouched (re-scannable finder)", async () => {
    seed("d", "github-stars"); // no handler registered for this play
    const out = await runPendingRetries();
    expect(out.retried).toBe(0);
    expect(ledger.isPendingResolution("github-stars", "d")).toBe(true);
  });

  it("defers everything while the breaker is open (no handler calls)", async () => {
    seed("e");
    for (let i = 0; i < 5; i++) recordResolutionOutcome(true); // trip the breaker
    const out = await runPendingRetries();
    expect(handlerCalls).toBe(0);
    expect(out.deferred).toBe(1);
    expect(ledger.isPendingResolution("luma-events", "e")).toBe(true);
  });
});
