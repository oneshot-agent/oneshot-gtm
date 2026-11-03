import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One place decides when OneShot itself is failing (2026-11-02: an hour of
// `settlement_pending` with successes in between) and stops lookups, while
// sends always go through. The event log is captured to check what is kept
// for the OneShot team.

const events = vi.hoisted(() => [] as Array<{ kind: string; ctx: Record<string, unknown> }>);
vi.mock("../src/events.ts", () => ({
  logEvent: (kind: string, ctx: Record<string, unknown>) => events.push({ kind, ctx }),
}));

const {
  _resetPlatformHealth,
  classifyPlatformError,
  inPlatformScope,
  isPlatformPaused,
  newPlatformScope,
  PLATFORM_COOLDOWN_MS,
  PlatformUnavailableError,
  platformPauseReason,
  runOutage,
  watchAgent,
} = await import("../src/platform-health.ts");
const { isNegativeCacheable } = await import("../src/paid-cache.ts");
const { isTransientToolError } = await import("../src/send-routing.ts");

const SETTLEMENT =
  "payment rejected: settlement_pending: transaction did not confirm in time: context deadline exceeded — expected $0.01 (The payment did not settle) [payment attempt pa_123]";

class PaymentError extends Error {
  override name = "PaymentError";
  constructor(
    message: string,
    readonly reason: string,
    readonly expected?: { amount?: string; network?: string },
    readonly quoteId?: string,
    readonly paymentAttemptId?: string,
    readonly stage?: string,
  ) {
    super(message);
  }
}

function settlementError(): PaymentError {
  return new PaymentError(
    SETTLEMENT,
    "settlement_pending: transaction did not confirm in time: context deadline exceeded",
    { amount: "0.01", network: "base" },
    "q_9",
    "pa_123",
    "settle",
  );
}

function fakeAgent(fail: () => boolean) {
  return {
    companyFind: vi.fn(async () => {
      if (fail()) throw settlementError();
      return { results: [] };
    }),
    email: vi.fn(async () => ({ id: "sent" })),
    personPosts: vi.fn(async () => {
      throw new Error("Job failed: This tool is temporarily unavailable. Contact support");
    }),
    address: "0xabc",
  };
}

beforeEach(() => {
  _resetPlatformHealth();
  events.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("classifyPlatformError", () => {
  it("reads the payment rail failure and keeps the ids the OneShot team asks for", () => {
    expect(classifyPlatformError(settlementError())).toEqual({
      kind: "payment",
      reason: "settlement_pending: transaction did not confirm in time: context deadline exceeded",
      paymentAttemptId: "pa_123",
      quoteId: "q_9",
      stage: "settle",
      amount: "0.01",
      network: "base",
    });
  });

  it("parses a serialized message when the fields are gone", () => {
    expect(classifyPlatformError(new Error(SETTLEMENT))).toMatchObject({
      kind: "payment",
      reason: "settlement_pending",
      paymentAttemptId: "pa_123",
      amount: "0.01",
    });
  });

  it("calls an empty wallet a wallet problem", () => {
    const err = new Error("payment rejected: invalid_payload — expected $0.02, signed $0.02");
    expect(classifyPlatformError(err)?.kind).toBe("wallet");
  });

  it("calls one tool's outage a tool outage, and 5xx or no network unreachable", () => {
    expect(
      classifyPlatformError(new Error("Job failed: Upstream service temporarily unavailable.")),
    ).toEqual({ kind: "tool", reason: "tool temporarily unavailable" });
    expect(classifyPlatformError(Object.assign(new Error("bad"), { statusCode: 503 }))?.kind).toBe(
      "unavailable",
    );
    expect(classifyPlatformError(new TypeError("fetch failed"))?.kind).toBe("unavailable");
  });

  it("leaves answers about the input alone", () => {
    expect(
      classifyPlatformError(
        new Error("Job failed: insufficient information to research this person"),
      ),
    ).toBeNull();
    expect(
      classifyPlatformError(
        new Error("Job failed: Could not find data for this person or company."),
      ),
    ).toBeNull();
    expect(
      classifyPlatformError(Object.assign(new Error("name required"), { name: "ValidationError" })),
    ).toBeNull();
    expect(classifyPlatformError(null)).toBeNull();
  });
});

describe("watchAgent", () => {
  it("passes results and errors through and logs each failure in full", async () => {
    const agent = watchAgent(fakeAgent(() => true));
    await expect(agent.companyFind()).rejects.toThrow(/settlement_pending/);
    const failed = events.find((e) => e.kind === "oneshot.call_failed");
    expect(failed?.ctx).toMatchObject({
      method: "companyFind",
      kind: "payment",
      paymentAttemptId: "pa_123",
      quoteId: "q_9",
      amount: "0.01",
    });
    expect(String(failed?.ctx["message_500"])).toContain("[payment attempt pa_123]");
    expect(agent.address).toBe("0xabc");
  });

  it("pauses on a bad patch even with successes in between", async () => {
    let n = 0;
    // fail, fail, ok, fail, fail, ok, fail, fail: six failures in eight calls.
    const agent = watchAgent(fakeAgent(() => ++n % 3 !== 0));
    for (let i = 0; i < 8; i++) await agent.companyFind().catch(() => {});
    expect(isPlatformPaused()).toBe(true);
    expect(platformPauseReason()).toBe("OneShot payments not settling");
    expect(events.some((e) => e.kind === "oneshot.platform_paused")).toBe(true);
  });

  it("stays running when failures are the minority", async () => {
    let n = 0;
    const agent = watchAgent(fakeAgent(() => ++n % 2 === 0));
    for (let i = 0; i < 10; i++) await agent.companyFind().catch(() => {});
    expect(isPlatformPaused()).toBe(false);
  });

  it("skips lookups while paused but still sends", async () => {
    const raw = fakeAgent(() => true);
    const agent = watchAgent(raw);
    for (let i = 0; i < 6; i++) await agent.companyFind().catch(() => {});
    expect(raw.companyFind).toHaveBeenCalledTimes(6);
    const skipped = await agent.companyFind().catch((e: unknown) => e);
    expect(skipped).toBeInstanceOf(PlatformUnavailableError);
    expect(raw.companyFind).toHaveBeenCalledTimes(6);
    expect(isTransientToolError(skipped)).toBe(true);
    await expect(agent.email()).resolves.toEqual({ id: "sent" });
    expect(raw.email).toHaveBeenCalledTimes(1);
  });

  it("probes after the cooldown and resumes when the probe works", async () => {
    vi.useFakeTimers();
    let failing = true;
    const raw = fakeAgent(() => failing);
    const agent = watchAgent(raw);
    for (let i = 0; i < 6; i++) await agent.companyFind().catch(() => {});
    expect(isPlatformPaused()).toBe(true);
    vi.setSystemTime(Date.now() + PLATFORM_COOLDOWN_MS + 1);
    expect(isPlatformPaused()).toBe(false);
    failing = false;
    await agent.companyFind();
    expect(events.some((e) => e.kind === "oneshot.platform_resumed")).toBe(true);
    // The window was cleared: one more failure does not pause again.
    failing = true;
    await agent.companyFind().catch(() => {});
    expect(isPlatformPaused()).toBe(false);
  });

  it("a success inside the cooldown does not end the pause", async () => {
    vi.useFakeTimers();
    const agent = watchAgent(fakeAgent(() => true));
    for (let i = 0; i < 6; i++) await agent.companyFind().catch(() => {});
    await agent.email();
    expect(isPlatformPaused()).toBe(true);
  });

  it("lets one probe out after the cooldown and holds the rest until it answers", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    let slow = false;
    const raw = {
      companyFind: vi.fn(async () => {
        if (slow) {
          await new Promise<void>((r) => (release = r));
          return { results: [] };
        }
        throw settlementError();
      }),
    };
    const agent = watchAgent(raw);
    for (let i = 0; i < 6; i++) await agent.companyFind().catch(() => {});
    vi.setSystemTime(Date.now() + PLATFORM_COOLDOWN_MS + 1);
    slow = true;
    const probe = agent.companyFind();
    await expect(agent.companyFind()).rejects.toBeInstanceOf(PlatformUnavailableError);
    expect(raw.companyFind).toHaveBeenCalledTimes(7);
    release?.();
    await probe;
    expect(isPlatformPaused()).toBe(false);
    slow = false;
    await expect(agent.companyFind()).rejects.toThrow(/settlement_pending/);
    expect(raw.companyFind).toHaveBeenCalledTimes(8);
  });

  it("a probe that fails pauses for another cooldown", async () => {
    vi.useFakeTimers();
    const agent = watchAgent(fakeAgent(() => true));
    for (let i = 0; i < 6; i++) await agent.companyFind().catch(() => {});
    vi.setSystemTime(Date.now() + PLATFORM_COOLDOWN_MS + 1);
    await agent.companyFind().catch(() => {});
    expect(isPlatformPaused()).toBe(true);
  });

  it("pauses only the tool that is down, not OneShot", async () => {
    const raw = fakeAgent(() => false);
    const agent = watchAgent(raw);
    for (let i = 0; i < 6; i++) await agent.personPosts().catch(() => {});
    expect(isPlatformPaused()).toBe(false);
    await expect(agent.personPosts()).rejects.toBeInstanceOf(PlatformUnavailableError);
    expect(raw.personPosts).toHaveBeenCalledTimes(6);
    await expect(agent.companyFind()).resolves.toEqual({ results: [] });
  });
});

describe("probes", () => {
  it("a tool outage answering the platform probe ends the platform pause", async () => {
    vi.useFakeTimers();
    const raw = fakeAgent(() => true);
    const agent = watchAgent(raw);
    for (let i = 0; i < 6; i++) await agent.companyFind().catch(() => {});
    vi.setSystemTime(Date.now() + PLATFORM_COOLDOWN_MS + 1);
    await agent.personPosts().catch(() => {});
    expect(isPlatformPaused()).toBe(false);
  });

  it("an answer about the input ends the tool pause too", async () => {
    vi.useFakeTimers();
    let unavailable = true;
    const raw = {
      personPosts: vi.fn(async () => {
        throw new Error(
          unavailable
            ? "Job failed: This tool is temporarily unavailable."
            : "Job failed: Could not find data for this person or company.",
        );
      }),
    };
    const agent = watchAgent(raw);
    for (let i = 0; i < 6; i++) await agent.personPosts().catch(() => {});
    vi.setSystemTime(Date.now() + PLATFORM_COOLDOWN_MS + 1);
    unavailable = false;
    await agent.personPosts().catch(() => {});
    await agent.personPosts().catch(() => {});
    expect(raw.personPosts).toHaveBeenCalledTimes(8);
  });
});

describe("run scope", () => {
  it("marks a run hit when OneShot paused during it", async () => {
    const agent = watchAgent(fakeAgent(() => true));
    const scope = newPlatformScope();
    await inPlatformScope(scope, async () => {
      for (let i = 0; i < 8; i++) await agent.companyFind().catch(() => {});
    });
    expect(scope).toMatchObject({ errors: 8, paused: true, kind: "payment" });
    expect(runOutage(scope)).toBe("OneShot payments not settling");
  });

  it("does not mark a run for a few failures or for one tool being down", async () => {
    let n = 0;
    const agent = watchAgent(fakeAgent(() => ++n <= 2));
    const scope = newPlatformScope();
    await inPlatformScope(scope, async () => {
      for (let i = 0; i < 5; i++) await agent.companyFind().catch(() => {});
      for (let i = 0; i < 8; i++) await agent.personPosts().catch(() => {});
    });
    expect(scope.errors).toBe(2);
    expect(runOutage(scope)).toBeNull();
  });
});

describe("paid cache", () => {
  it("never remembers a OneShot outage as an answer about the input", () => {
    expect(
      isNegativeCacheable(
        new Error("Job failed: This tool is temporarily unavailable. Contact support with the ref"),
      ),
    ).toBe(false);
    expect(
      isNegativeCacheable(new Error("Job failed: Upstream service temporarily unavailable.")),
    ).toBe(false);
    expect(
      isNegativeCacheable(new Error("Job failed: Could not find data for this person or company.")),
    ).toBe(true);
  });
});
