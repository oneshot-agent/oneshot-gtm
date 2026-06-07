import { afterEach, describe, expect, it } from "vitest";
import {
  __resetInflight,
  activeSendCount,
  beginDraining,
  beginSend,
  endSend,
  isDraining,
  trackSend,
  waitForSendsToDrain,
} from "../src/inflight.ts";

afterEach(() => __resetInflight());

describe("inflight send tracker", () => {
  it("counts begin/end and never drops below zero", () => {
    expect(activeSendCount()).toBe(0);
    beginSend();
    beginSend();
    expect(activeSendCount()).toBe(2);
    endSend();
    expect(activeSendCount()).toBe(1);
    endSend();
    endSend(); // over-decrement is clamped
    expect(activeSendCount()).toBe(0);
  });

  it("trackSend increments for the span and decrements after resolve", async () => {
    let seenDuring = -1;
    const p = trackSend(async () => {
      seenDuring = activeSendCount();
      return "ok";
    });
    expect(await p).toBe("ok");
    expect(seenDuring).toBe(1);
    expect(activeSendCount()).toBe(0);
  });

  it("trackSend decrements even when the body throws", async () => {
    await expect(
      trackSend(async () => {
        throw new Error("send blew up");
      }),
    ).rejects.toThrow("send blew up");
    expect(activeSendCount()).toBe(0);
  });

  it("reflects concurrent in-flight sends", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = trackSend(() => gate);
    const b = trackSend(() => gate);
    expect(activeSendCount()).toBe(2);
    release();
    await Promise.all([a, b]);
    expect(activeSendCount()).toBe(0);
  });

  it("waitForSendsToDrain resolves immediately when idle", async () => {
    const res = await waitForSendsToDrain({ timeoutMs: 1000, pollMs: 5 });
    expect(res).toEqual({ drained: true, remaining: 0 });
  });

  it("waitForSendsToDrain waits for an in-flight send to finish", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const send = trackSend(() => gate);
    // Release shortly; the drain should observe count → 0 and report drained.
    setTimeout(() => release(), 20);
    const res = await waitForSendsToDrain({ timeoutMs: 1000, pollMs: 5 });
    await send;
    expect(res).toEqual({ drained: true, remaining: 0 });
  });

  it("waitForSendsToDrain reports not-drained on timeout, with the remaining count", async () => {
    beginSend(); // never ends — simulates a stuck send
    const res = await waitForSendsToDrain({ timeoutMs: 30, pollMs: 5 });
    expect(res.drained).toBe(false);
    expect(res.remaining).toBe(1);
  });

  it("isDraining flips after beginDraining", () => {
    expect(isDraining()).toBe(false);
    beginDraining();
    expect(isDraining()).toBe(true);
  });
});
