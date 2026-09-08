import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffDelayMs, isRetryableLlmError, parseRetryAfter } from "../src/client.ts";

describe("isRetryableLlmError", () => {
  it("does NOT retry a bare Error — only the classified set is retryable", () => {
    // A TypeError here is a property access on a malformed body, not a socket
    // failure; postJson raises a classified error for the ones worth repeating.
    expect(isRetryableLlmError(new Error("network error"))).toBe(false);
    expect(isRetryableLlmError(new TypeError("Cannot read properties of undefined"))).toBe(false);
  });

  it("does NOT retry non-Error throws", () => {
    expect(isRetryableLlmError("boom")).toBe(false);
    expect(isRetryableLlmError(undefined)).toBe(false);
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

  it("clamps past dates to zero, and the backoff floor keeps them paced", () => {
    const pastDate = "Fri, 29 Aug 2026 09:59:00 GMT";
    const parsed = parseRetryAfter(pastDate, NOW);
    expect(parsed).toBe(0);
    // Parsing yields 0, but the honoured delay is never 0 — see the floor test.
    expect(backoffDelayMs(1, parsed, () => 0.5)).toBe(375);
  });
});

describe("backoffDelayMs", () => {
  it("honors Retry-After when provided", () => {
    expect(backoffDelayMs(1, 5000)).toBe(5000);
    expect(backoffDelayMs(3, 10_000)).toBe(10_000);
  });

  it("floors Retry-After at the exponential backoff", () => {
    const fixed = () => 0.5;

    // Retry-After: 0 and a past HTTP-date both parse to 0. Honouring them
    // literally would fire every attempt within milliseconds, unpaced.
    expect(backoffDelayMs(1, 0, fixed)).toBe(375);
    expect(backoffDelayMs(3, 0, fixed)).toBe(1500);

    // A hint shorter than our own backoff is raised to it; a longer one wins.
    expect(backoffDelayMs(3, 100, fixed)).toBe(1500);
    expect(backoffDelayMs(3, 9000, fixed)).toBe(9000);
  });

  it("no longer silently caps Retry-After — over-budget values are rejected by complete() before a delay is computed", () => {
    // Finding 1 (#87): a Retry-After beyond MAX_RETRY_AFTER_MS used to be
    // silently truncated here and then honoured as a real (guaranteed-failing)
    // wait. Capping is now complete()'s job — see the "gives up immediately on
    // an over-budget Retry-After" integration test below — so at this layer an
    // over-budget hint is honoured like any other, same as a hint under budget.
    expect(backoffDelayMs(1, 120_000)).toBe(120_000);
    expect(backoffDelayMs(1, 900_000)).toBe(900_000);
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
    // ONESHOT_GTM_HOME is not stubbed here: config.ts captures CONFIG_DIR at
    // module load, so a stub set now would do nothing. vitest.setup.ts already
    // points the whole suite at a temp data dir before any module loads.
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
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

    // Attach rejection handler immediately to prevent unhandled rejection
    const rejection = promise.catch((err) => err);

    // Advance timers to trigger all retry attempts
    await vi.runAllTimersAsync();

    // Verify the error matches expectations
    const error = await rejection;
    expect(error).toMatchObject({ status: 429 });
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

  it("does NOT retry a 200 whose message carries no text content", async () => {
    const { complete } = await import("../src/client.ts");

    // Finding 1: a refusal / tool-call-only message is an already-billed
    // success. Reading .length off its null content used to throw INSIDE the
    // retry try, so the paid-for response was discarded and the prompt re-sent.
    let attemptCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      attemptCount++;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: null }, finish_reason: "tool_calls" }],
          }),
      });
    }) as any;

    const promise = complete({
      messages: [{ role: "user", content: "test" }],
      maxAttempts: 3,
    });
    const rejection = promise.catch((err) => err);

    await vi.runAllTimersAsync();

    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("no text content");
    // The provider signal is named, so the failure is diagnosable.
    expect(error.message).toContain("tool_calls");
    expect(attemptCount).toBe(1);
  });

  it("does NOT retry a 200 error envelope with a non-retryable code", async () => {
    const { complete } = await import("../src/client.ts");

    // OpenRouter reports upstream faults with 200 + an error envelope. Touching
    // data.choices[0] on it throws a bare TypeError, which used to be retryable.
    // Non-retryable numeric codes (e.g. 400) are terminal.
    let attemptCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      attemptCount++;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ error: { message: "bad request", code: 400 } }),
      });
    }) as any;

    const promise = complete({
      messages: [{ role: "user", content: "test" }],
      maxAttempts: 3,
    });
    const rejection = promise.catch((err) => err);

    await vi.runAllTimersAsync();

    const error = await rejection;
    expect(error.message).toContain("bad request");
    expect(attemptCount).toBe(1);
  });

  it("does NOT retry a status-less truncation error", async () => {
    const { complete } = await import("../src/client.ts");

    // Finding 5: a truncated response reproduces exactly on a resend, so
    // retrying it just triples the bill for the same unusable output.
    let attemptCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      attemptCount++;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "half a js" }, finish_reason: "length" }],
          }),
      });
    }) as any;

    const promise = complete({
      messages: [{ role: "user", content: "test" }],
      maxTokens: 16,
      maxAttempts: 3,
    });
    const rejection = promise.catch((err) => err);

    await vi.runAllTimersAsync();

    const error = await rejection;
    expect(error.message).toContain("truncated at max_tokens=16");
    expect(error.status).toBeUndefined();
    expect(attemptCount).toBe(1);
  });

  it("waits at least the exponential backoff when Retry-After is 0", async () => {
    const { complete } = await import("../src/client.ts");

    // Finding 2: Retry-After: 0 (and past HTTP-dates, which parse to 0) must not
    // collapse the pacing — the honoured delay is floored at our own backoff.
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    let attemptCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      attemptCount++;
      if (attemptCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: new Headers({ "retry-after": "0" }),
          text: () => Promise.resolve("rate limited"),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "paced" }, finish_reason: "stop" }],
          }),
      });
    }) as any;

    const promise = complete({
      messages: [{ role: "user", content: "test" }],
      maxAttempts: 3,
    });

    // Attempt 1's backoff is 500/2 + 0.5 * 250 = 375ms. One tick short of it,
    // the retry must not have fired yet.
    await vi.advanceTimersByTimeAsync(374);
    expect(attemptCount).toBe(1);

    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.content).toBe("paced");
    expect(attemptCount).toBe(2);
  });

  it("keeps a 400 non-retryable when the timeout fires while reading its body", async () => {
    const { complete } = await import("../src/client.ts");

    // Finding 4: the status is already known, so it decides. Laundering this
    // into a timeout would make a permanent bad request retry three times.
    let attemptCount = 0;
    global.fetch = vi.fn().mockImplementation((_url: string, options: any) => {
      attemptCount++;
      return Promise.resolve({
        ok: false,
        status: 400,
        headers: new Headers(),
        // The error body never arrives; the per-request abort fires mid-read.
        text: () =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      });
    }) as any;

    const promise = complete({
      messages: [{ role: "user", content: "test" }],
      timeoutMs: 1000,
      maxAttempts: 3,
    });
    const rejection = promise.catch((err) => err);

    await vi.advanceTimersByTimeAsync(1100);
    await vi.runAllTimersAsync();

    const error = await rejection;
    expect(error).toMatchObject({ status: 400 });
    expect(error.name).toBe("LlmError");
    expect(attemptCount).toBe(1);
  });

  it("does NOT abort or retry slow calls when no explicit timeoutMs is provided", async () => {
    const { complete } = await import("../src/client.ts");

    // Regression fix: before the fix, a 90s default timeout applied to every
    // call site, so a slow legitimate generation was aborted, retried, and failed.
    // Now, no timeoutMs = no client-side abort = preserves existing behavior.
    let attemptCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      attemptCount++;
      // Simulate a slow response (e.g., strategist with maxTokens: 4096 on reasoning model)
      // that completes after 100 seconds — longer than the old 90s default.
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                choices: [{ message: { content: "slow but valid" }, finish_reason: "stop" }],
              }),
          });
        }, 100_000);
      });
    }) as any;

    const promise = complete({
      messages: [{ role: "user", content: "test" }],
      maxAttempts: 3,
      // No timeoutMs — should wait indefinitely
    });

    // Advance past the old 90s default that would have aborted
    await vi.advanceTimersByTimeAsync(95_000);
    expect(attemptCount).toBe(1); // Still waiting on first attempt

    // Complete the slow response
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.content).toBe("slow but valid");
    expect(attemptCount).toBe(1); // Exactly one attempt, no retry
  });

  it("retries OpenRouter 200 + {error:{code:429}} and stops on non-numeric codes", async () => {
    const { complete } = await import("../src/client.ts");

    // Finding 2: OpenRouter returns 200 with an error envelope for upstream faults.
    // Numeric codes (429, 5xx) should be retried; non-numeric/absent codes are terminal.
    let attemptCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      attemptCount++;
      if (attemptCount === 1) {
        // First call: 200 + {error:{code:429}} — should retry
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              error: { code: 429, message: "rate limited" },
            }),
        });
      }
      // Second call: success
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
      maxAttempts: 3,
    });

    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.content).toBe("recovered");
    expect(attemptCount).toBe(2); // Retried once
  });

  it("does NOT retry OpenRouter 200 + {error:{code:'INVALID_KEY'}} — non-numeric is terminal", async () => {
    const { complete } = await import("../src/client.ts");

    let attemptCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      attemptCount++;
      // 200 + non-numeric error code — should NOT retry
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            error: { code: "INVALID_KEY", message: "authentication failed" },
          }),
      });
    }) as any;

    const promise = complete({
      messages: [{ role: "user", content: "test" }],
      maxAttempts: 3,
    });
    const rejection = promise.catch((err) => err);

    await vi.runAllTimersAsync();

    const error = await rejection;
    expect(error.message).toContain("error envelope");
    expect(error.message).toContain("INVALID_KEY");
    expect(error.status).toBeUndefined(); // Non-numeric code = no status
    expect(attemptCount).toBe(1); // No retry
  });

  it("gives up immediately on a Retry-After beyond the retry budget, instead of burning attempts", async () => {
    const { complete } = await import("../src/client.ts");

    // Finding 1 (#87): Retry-After: 300 used to be silently capped to 60s and
    // then honoured as a real wait — two guaranteed-failing retries and ~120s
    // of dead time. It must now fail on the FIRST attempt, with no sleep.
    let attemptCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      attemptCount++;
      return Promise.resolve({
        ok: false,
        status: 429,
        headers: new Headers({ "retry-after": "300" }),
        text: () => Promise.resolve("rate limited"),
      });
    }) as any;

    const promise = complete({
      messages: [{ role: "user", content: "test" }],
      maxAttempts: 3,
    });
    const rejection = promise.catch((err) => err);

    await vi.runAllTimersAsync();

    const error = await rejection;
    expect(error.message).toContain("300s");
    expect(error.message).toContain("60s retry budget");
    expect(attemptCount).toBe(1); // No retries burned on a guaranteed-failing wait
  });

  it("preserves the original error for a non-retryable status with an over-budget Retry-After", async () => {
    const { complete } = await import("../src/client.ts");

    // Correction round 1 (#87): overRetryBudget used to be derived only from
    // retryAfterMs > MAX_RETRY_AFTER_MS, with no gate on isRetryableLlmError
    // or attempt < maxAttempts. A non-retryable 401 (bad API key) that happens
    // to carry a Retry-After over 60s would then be discarded and replaced
    // with the generic "giving up instead of burning attempts" message, even
    // though no retry was ever eligible for a 401. The real status + provider
    // body must survive unchanged, and no retry budget message must appear.
    let attemptCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      attemptCount++;
      return Promise.resolve({
        ok: false,
        status: 401,
        headers: new Headers({ "retry-after": "300" }),
        text: () => Promise.resolve("Invalid API key"),
      });
    }) as any;

    const promise = complete({
      messages: [{ role: "user", content: "test" }],
      maxAttempts: 3,
    });
    const rejection = promise.catch((err) => err);

    await vi.runAllTimersAsync();

    const error = await rejection;
    expect(error.status).toBe(401);
    expect(error.message).toContain("401");
    expect(error.message).toContain("Invalid API key");
    expect(error.message).not.toContain("retry budget");
    expect(attemptCount).toBe(1); // Non-retryable: no retry was ever eligible
  });

  it("still retries a Retry-After within the budget, waiting the full hint", async () => {
    const { complete } = await import("../src/client.ts");

    // A hint under MAX_RETRY_AFTER_MS is still honoured in full — only
    // over-budget hints are terminal.
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    let attemptCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      attemptCount++;
      if (attemptCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: new Headers({ "retry-after": "45" }),
          text: () => Promise.resolve("rate limited"),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          }),
      });
    }) as any;

    const promise = complete({
      messages: [{ role: "user", content: "test" }],
      maxAttempts: 3,
    });

    // Just under the 45s hint, the retry must not have fired yet.
    await vi.advanceTimersByTimeAsync(44_000);
    expect(attemptCount).toBe(1);

    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.content).toBe("ok");
    expect(attemptCount).toBe(2);
  });

  it("treats a 2xx JSON null body as a classified provider error, not a bare TypeError", async () => {
    const { complete } = await import("../src/client.ts");

    // Finding 2 (#87): postJson returned `unknown`, so a 2xx body that parses
    // to JSON `null` used to reach `data.choices?.[0]` and throw a bare
    // TypeError there instead of a named, classified LlmError.
    let attemptCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      attemptCount++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(null) });
    }) as any;

    const promise = complete({
      messages: [{ role: "user", content: "test" }],
      maxAttempts: 3,
    });
    const rejection = promise.catch((err) => err);

    await vi.runAllTimersAsync();

    const error = await rejection;
    expect(error.name).toBe("LlmError");
    expect(error.message).toContain("non-object JSON body");
    expect(attemptCount).toBe(1); // Terminal, not a TypeError worth retrying
  });

  it("clamps a non-positive timeoutMs instead of aborting every attempt instantly", async () => {
    const { complete } = await import("../src/client.ts");

    // Finding 3 (#87): timeoutMs: 0 survived `??` as "supplied", so the
    // AbortController fired on the same tick, on every attempt, without ever
    // reaching the provider. A clamp lets the request actually go out.
    let attemptCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      attemptCount++;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "reached the provider" }, finish_reason: "stop" }],
          }),
      });
    }) as any;

    const promise = complete({
      messages: [{ role: "user", content: "test" }],
      timeoutMs: 0,
      maxAttempts: 3,
    });

    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.content).toBe("reached the provider");
    expect(attemptCount).toBe(1);
  });
});
