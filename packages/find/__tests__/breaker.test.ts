import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, logEvent: () => {} };
});

const { recordResolutionOutcome, isCircuitOpen, _resetBreaker, COOLDOWN_MS } = await import(
  "../src/_breaker.ts"
);

const realNow = Date.now;
let clock = 1_000_000;

beforeEach(() => {
  _resetBreaker();
  clock = 1_000_000;
  Date.now = () => clock;
});
afterEach(() => {
  Date.now = realNow;
  _resetBreaker();
});

function trip(): void {
  for (let i = 0; i < 5; i++) recordResolutionOutcome(true);
}

describe("circuit breaker state machine", () => {
  it("opens only after 5 consecutive platform errors", () => {
    for (let i = 0; i < 4; i++) recordResolutionOutcome(true);
    expect(isCircuitOpen()).toBe(false);
    recordResolutionOutcome(true);
    expect(isCircuitOpen()).toBe(true);
  });

  it("a genuine outcome before the threshold resets the counter", () => {
    for (let i = 0; i < 4; i++) recordResolutionOutcome(true);
    recordResolutionOutcome(false); // backend answered
    for (let i = 0; i < 4; i++) recordResolutionOutcome(true);
    expect(isCircuitOpen()).toBe(false); // counter restarted, never hit 5 in a row
  });

  it("stays open during the cooldown, then half-opens to allow a probe", () => {
    trip();
    expect(isCircuitOpen()).toBe(true);
    clock += COOLDOWN_MS - 1;
    expect(isCircuitOpen()).toBe(true); // still cooling down
    clock += 2; // past cooldown
    expect(isCircuitOpen()).toBe(false); // half-open: next call probes
  });

  it("CLOSES when a half-open probe succeeds (the regression: must not latch open)", () => {
    trip();
    clock += COOLDOWN_MS + 1; // half-open
    expect(isCircuitOpen()).toBe(false);
    recordResolutionOutcome(false); // probe succeeded → close
    expect(isCircuitOpen()).toBe(false);
    // And it's truly closed: a single later error doesn't immediately re-open.
    recordResolutionOutcome(true);
    expect(isCircuitOpen()).toBe(false);
  });

  it("RE-ARMS the cooldown when a half-open probe fails (sustained outage)", () => {
    trip();
    clock += COOLDOWN_MS + 1; // half-open
    expect(isCircuitOpen()).toBe(false);
    recordResolutionOutcome(true); // probe failed → re-arm
    expect(isCircuitOpen()).toBe(true); // short-circuiting again
    clock += COOLDOWN_MS + 1;
    expect(isCircuitOpen()).toBe(false); // next probe window
  });
});
