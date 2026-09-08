import { afterEach, describe, expect, it } from "vitest";
import {
  RunCancelledError,
  abortRun,
  cancelReasonOf,
  isRunCancelled,
  isRunInFlight,
  registerRunController,
  releaseRunController,
  throwIfCancelled,
} from "../src/run-cancel.ts";

// The registry is module-global by design (one process, one set of live runs),
// so every test cleans up after itself or the next one inherits a controller.
const registered: number[] = [];
function track(runId: number, controller: AbortController): void {
  registerRunController(runId, controller);
  registered.push(runId);
}

afterEach(() => {
  for (const id of registered.splice(0)) releaseRunController(id);
});

describe("isRunCancelled", () => {
  it("recognizes a RunCancelledError", () => {
    expect(isRunCancelled(new RunCancelledError("stop"))).toBe(true);
  });

  it("recognizes one by name across a module boundary, where instanceof lies", () => {
    // What a second copy of the class (dual-bundled package, worker thread)
    // produces. The name check is the whole reason the class sets it.
    const alien = new Error("stop");
    alien.name = "RunCancelledError";
    expect(alien instanceof RunCancelledError).toBe(false);
    expect(isRunCancelled(alien)).toBe(true);
  });

  it("does not mistake an ordinary failure — or a non-Error — for a cancellation", () => {
    expect(isRunCancelled(new Error("Tool request failed"))).toBe(false);
    expect(isRunCancelled("run cancelled")).toBe(false);
    expect(isRunCancelled(null)).toBe(false);
    expect(isRunCancelled(undefined)).toBe(false);
    expect(isRunCancelled({ name: "RunCancelledError" })).toBe(false);
  });
});

describe("cancelReasonOf", () => {
  it("reads back the string an abort was given", () => {
    const c = new AbortController();
    c.abort("client disconnected");
    expect(cancelReasonOf(c.signal)).toBe("client disconnected");
  });

  it("falls back to the default rather than persisting a DOMException's shape", () => {
    const c = new AbortController();
    c.abort(); // reason defaults to an AbortError DOMException
    // Either the exception's own message or the default — never "[object Object]".
    expect(cancelReasonOf(c.signal)).not.toContain("[object");
    expect(cancelReasonOf(c.signal).length).toBeGreaterThan(0);
  });

  it("defaults on an un-aborted or absent signal, and on a blank reason", () => {
    expect(cancelReasonOf(undefined)).toBe("run cancelled");
    expect(cancelReasonOf(new AbortController().signal)).toBe("run cancelled");
    const blank = new AbortController();
    blank.abort("   ");
    expect(cancelReasonOf(blank.signal)).toBe("run cancelled");
  });

  it("trims the reason it stores", () => {
    const c = new AbortController();
    c.abort("  cancelled by user  ");
    expect(cancelReasonOf(c.signal)).toBe("cancelled by user");
  });
});

describe("throwIfCancelled", () => {
  it("is a no-op before the abort — the guard must not cost a live run anything", () => {
    const c = new AbortController();
    expect(() => throwIfCancelled(c.signal, "show-hn send")).not.toThrow();
    expect(() => throwIfCancelled(undefined, "show-hn send")).not.toThrow();
  });

  it("throws a RunCancelledError naming the phase that was about to bill", () => {
    const c = new AbortController();
    c.abort("cancelled by user");
    try {
      throwIfCancelled(c.signal, "show-hn send");
      expect.unreachable("guard should have thrown");
    } catch (err) {
      expect(isRunCancelled(err)).toBe(true);
      expect((err as Error).message).toBe("show-hn send: cancelled by user");
    }
  });
});

describe("the in-flight registry", () => {
  it("aborts the controller the run registered, with the caller's reason", () => {
    const c = new AbortController();
    track(1001, c);
    expect(isRunInFlight(1001)).toBe(true);
    expect(abortRun(1001, "cancelled by user")).toBe(true);
    expect(c.signal.aborted).toBe(true);
    expect(cancelReasonOf(c.signal)).toBe("cancelled by user");
  });

  it("reports false for a run this process is not executing", () => {
    // The orphan case: the row says 'running', but the process that owned it
    // is gone. The route needs to tell that apart from a live abort.
    expect(isRunInFlight(4242)).toBe(false);
    expect(abortRun(4242, "cancelled by user")).toBe(false);
  });

  it("is idempotent, and the first reason wins", () => {
    const c = new AbortController();
    track(1002, c);
    expect(abortRun(1002, "first")).toBe(true);
    expect(abortRun(1002, "second")).toBe(true);
    expect(cancelReasonOf(c.signal)).toBe("first");
  });

  it("stops reaching a released run, so a finished run can't be aborted", () => {
    const c = new AbortController();
    registerRunController(1003, c);
    releaseRunController(1003);
    expect(isRunInFlight(1003)).toBe(false);
    expect(abortRun(1003, "too late")).toBe(false);
    expect(c.signal.aborted).toBe(false);
  });

  it("releasing an unknown run is a no-op, not a throw", () => {
    expect(() => releaseRunController(999999)).not.toThrow();
  });

  it("keeps runs independent — cancelling one leaves the others running", () => {
    const a = new AbortController();
    const b = new AbortController();
    track(1004, a);
    track(1005, b);
    abortRun(1004, "cancelled by user");
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
  });
});
