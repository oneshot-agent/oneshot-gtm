import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffDelayMs, isRetryableLlmError, parseRetryAfter } from "../src/client.ts";

describe("isRetryableLlmError", () => {
  it("retries generic Error (network/DNS failures)", () => {
    expect(isRetryableLlmError(new Error("network error"))).toBe(true);
    expect(isRetryableLlmError(new TypeError("fetch failed"))).toBe(true);
  });
});

describe("parseRetryAfter", () => {
  const NOW = Date.parse("2026-08-29T10:00:00Z");

  it("parses delta-seconds", () => {
    expect(parseRetryAfter("30", NOW)).toBe(30_000);
    expect(parseRetryAfter("  60  ", NOW)).toBe(60_000);
  });

  it("parses HTTP-date", () => {
    const futureDate = "Fri, 29 Aug 2026 10:01:00 GMT";
    expect(parseRetryAfter(futureDate, NOW)).toBe(60_000);
  });

  it("returns undefined for unparseable input", () => {
    expect(parseRetryAfter("invalid", NOW)).toBeUndefined();
    expect(parseRetryAfter("not-a-number", NOW)).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
  });

  it("clamps past dates to zero", () => {
    const pastDate = "Fri, 29 Aug 2026 09:59:00 GMT";
    expect(parseRetryAfter(pastDate, NOW)).toBe(0);
  });
});

describe("backoffDelayMs", () => {
  it("honors Retry-After when provided", () => {
    expect(backoffDelayMs(1, 5000)).toBe(5000);
    expect(backoffDelayMs(3, 10_000)).toBe(10_000);
  });

  it("caps Retry-After at MAX_RETRY_AFTER_MS (60s)", () => {
    expect(backoffDelayMs(1, 120_000)).toBe(60_000);
    expect(backoffDelayMs(1, 900_000)).toBe(60_000);
  });

  it("uses exponential backoff without Retry-After", () => {
    const fixed = () => 0.5;

    // Attempt 1: 500 * 2^0 = 500, half fixed (250) + half jitter (250 * 0.5 = 125) = 375
    expect(backoffDelayMs(1, undefined, fixed)).toBe(375);

    // Attempt 2: 500 * 2^1 = 1000, 500 + 250 = 750
    expect(backoffDelayMs(2, undefined, fixed)).toBe(750);

    // Attempt 3: 500 * 2^2 = 2000, 1000 + 500 = 1500
    expect(backoffDelayMs(3, undefined, fixed)).toBe(1500);
  });

  it("caps backoff at MAX_DELAY_MS (20s)", () => {
    const fixed = () => 0.5;

    // Attempt 10: 500 * 2^9 = 256000 > 20000, capped to 20000, 10000 + 5000 = 15000
    expect(backoffDelayMs(10, undefined, fixed)).toBe(15_000);
  });

  it("adds jitter to prevent thundering herd", () => {
    const delays = new Set<number>();
    for (let i = 0; i < 20; i++) {
      delays.add(backoffDelayMs(1));
    }
    // With random jitter, we should get different delays
    expect(delays.size).toBeGreaterThan(1);
  });

  it("jitter is bounded correctly", () => {
    // For attempt 1, base is 500, so delay should be [250, 500]
    for (let i = 0; i < 50; i++) {
      const delay = backoffDelayMs(1);
      expect(delay).toBeGreaterThanOrEqual(250);
      expect(delay).toBeLessThanOrEqual(500);
    }
  });
});

describe("complete() retry integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("ONESHOT_GTM_HOME", "/tmp/test-home");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("retries 429 with backoff and succeeds on second attempt", async () => {
    const { complete } = await import("../src/client.ts");

    let attemptCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      attemptCount++;
      if (attemptCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: new Headers({ "retry-after": "2" }),
          text: () => Promise.resolve("rate limited"),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "success" }, finish_reason: "stop" }],
          }),
      });
    }) as any;

    const promise = complete({
      messages: [{ role: "user", content: "test" }],
      maxAttempts: 3,
    });

    // Fast-forward through the retry delay
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.content).toBe("success");
    expect(attemptCount).toBe(2);
  });

  it("retries 5xx errors and succeeds on third attempt", async () => {
    const { complete } = await import("../src/client.ts");

    let attemptCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      attemptCount++;
      if (attemptCount <= 2) {
        return Promise.resolve({
          ok: false,
          status: 503,
          headers: new Headers(),
          text: () => Promise.resolve("service unavailable"),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "recovered" }, finish_reason: "stop" }],
          }),
      });
    }) as any;

    const promise = complete({
      messages: [{ role: "user", content: "test" }],
      maxAttempts: 5,
    });

    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.content).toBe("recovered");
    expect(attemptCount).toBe(3);
  });

  it("does NOT retry 400 bad request", async () => {
    const { complete } = await import("../src/client.ts");

    let attemptCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      attemptCount++;
      return Promise.resolve({
        ok: false,
        status: 400,
        headers: new Headers(),
        text: () => Promise.resolve("bad request"),
      });
    }) as any;

    await expect(
      complete({
        messages: [{ role: "user", content: "test" }],
        maxAttempts: 3,
      }),
    ).rejects.toThrow("400");

    expect(attemptCount).toBe(1);
  });

  it("gives up after maxAttempts retries", async () => {
    const { complete } = await import("../src/client.ts");

    let attemptCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      attemptCount++;
      return Promise.resolve({
        ok: false,
        status: 429,
        headers: new Headers(),
        text: () => Promise.resolve("rate limited"),
      });
    }) as any;

    const promise = complete({
      messages: [{ role: "user", content: "test" }],
      maxAttempts: 3,
    });

    await vi.runAllTimersAsync();

    try {
      await promise;
      throw new Error("Should have thrown");
    } catch (err) {
      expect(err).toMatchObject({ status: 429 });
    }
    expect(attemptCount).toBe(3);
  });

  it("retries network errors (fetch throws)", async () => {
    const { complete } = await import("../src/client.ts");

    let attemptCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      attemptCount++;
      if (attemptCount === 1) {
        return Promise.reject(new TypeError("network error"));
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "recovered from network error" } }],
          }),
      });
    }) as any;

    const promise = complete({
      messages: [{ role: "user", content: "test" }],
      maxAttempts: 3,
    });

    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.content).toBe("recovered from network error");
    expect(attemptCount).toBe(2);
  });

  it("aborts on timeout and retries", async () => {
    const { complete } = await import("../src/client.ts");

    let attemptCount = 0;
    global.fetch = vi.fn().mockImplementation((_url: string, options: any) => {
      attemptCount++;

      if (attemptCount === 1) {
        // Simulate a slow response that triggers timeout
        return new Promise((resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        });
      }

      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "success after timeout" } }],
          }),
      });
    }) as any;

    const promise = complete({
      messages: [{ role: "user", content: "test" }],
      timeoutMs: 1000,
      maxAttempts: 3,
    });

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(1100);
    // Then advance through retry delay
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.content).toBe("success after timeout");
    expect(attemptCount).toBe(2);
  });
});
