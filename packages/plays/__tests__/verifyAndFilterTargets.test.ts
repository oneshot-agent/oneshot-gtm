import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface VerifyMockResult {
  status: string;
  email: string;
  valid: boolean;
  deliverable: boolean;
  catch_all: boolean;
  disposable: boolean;
  cost?: number;
}

const calls = {
  verifyEmail: [] as Array<{ email: string; playName: string }>,
};
let verifyResponseFor: (email: string) => VerifyMockResult = (email) => ({
  status: "ok",
  email,
  valid: true,
  deliverable: true,
  catch_all: false,
  disposable: false,
  cost: 0.005,
});

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    verifyEmail: async (input: { email: string }, ctx: { playName: string }) => {
      calls.verifyEmail.push({ email: input.email, playName: ctx.playName });
      return { result: verifyResponseFor(input.email), receiptId: calls.verifyEmail.length };
    },
  };
});

const { verifyAndFilterTargets } = await import("../src/_lib.ts");

interface T {
  email: string;
  name: string;
}

beforeEach(() => {
  calls.verifyEmail = [];
  verifyResponseFor = (email) => ({
    status: "ok",
    email,
    valid: true,
    deliverable: true,
    catch_all: false,
    disposable: false,
    cost: 0.005,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("verifyAndFilterTargets", () => {
  it("returns the input unchanged on dryRun without spending anything", async () => {
    const targets: T[] = [
      { email: "a@x.dev", name: "A" },
      { email: "b@y.dev", name: "B" },
    ];
    const r = await verifyAndFilterTargets(targets, (t) => t.email, {
      playName: "p",
      dryRun: true,
    });
    expect(r.verified).toEqual(targets);
    expect(r.dropped).toEqual([]);
    expect(r.costUsd).toBe(0);
    expect(r.receiptIds).toEqual([]);
    expect(calls.verifyEmail).toEqual([]);
  });

  it("returns empty results on empty input without calling verifyEmail", async () => {
    const r = await verifyAndFilterTargets([] as T[], (t) => t.email, {
      playName: "p",
      dryRun: false,
    });
    expect(r.verified).toEqual([]);
    expect(r.dropped).toEqual([]);
    expect(calls.verifyEmail).toEqual([]);
  });

  it("verifies each unique email exactly once even when input has duplicates", async () => {
    const targets: T[] = [
      { email: "a@x.dev", name: "A1" },
      { email: "a@x.dev", name: "A2" },
      { email: "b@y.dev", name: "B" },
    ];
    const r = await verifyAndFilterTargets(targets, (t) => t.email, {
      playName: "p",
      dryRun: false,
    });
    expect(calls.verifyEmail.map((c) => c.email).toSorted()).toEqual(["a@x.dev", "b@y.dev"]);
    // All three pass through because a@x.dev is verified once + applied to both rows.
    expect(r.verified).toHaveLength(3);
    expect(r.dropped).toEqual([]);
  });

  it("normalizes emails (trim + lowercase) before deduping", async () => {
    const targets: T[] = [
      { email: "  Alice@X.dev  ", name: "A1" },
      { email: "alice@x.dev", name: "A2" },
    ];
    await verifyAndFilterTargets(targets, (t) => t.email, {
      playName: "p",
      dryRun: false,
    });
    expect(calls.verifyEmail).toHaveLength(1);
    expect(calls.verifyEmail[0]?.email).toBe("alice@x.dev");
  });

  it("drops targets whose email is undeliverable", async () => {
    const targets: T[] = [
      { email: "good@x.dev", name: "Good" },
      { email: "bad@y.dev", name: "Bad" },
    ];
    verifyResponseFor = (email) => ({
      status: "ok",
      email,
      valid: true,
      deliverable: email === "good@x.dev",
      catch_all: false,
      disposable: false,
      cost: 0.01,
    });
    const r = await verifyAndFilterTargets(targets, (t) => t.email, {
      playName: "p",
      dryRun: false,
    });
    expect(r.verified.map((t) => t.name)).toEqual(["Good"]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]?.email).toBe("bad@y.dev");
    expect(r.dropped[0]?.reason).toBe("undeliverable");
  });

  it("drops targets with missing or empty email without calling verifyEmail for them", async () => {
    const targets = [
      { email: "ok@x.dev", name: "OK" },
      { email: "", name: "Blank" },
      { email: "   ", name: "Whitespace" },
    ] as T[];
    const r = await verifyAndFilterTargets(targets, (t) => t.email, {
      playName: "p",
      dryRun: false,
    });
    expect(calls.verifyEmail).toHaveLength(1); // only "ok@x.dev" got verified
    expect(r.verified.map((t) => t.name)).toEqual(["OK"]);
    expect(r.dropped.map((d) => d.reason).toSorted()).toEqual(["missing email", "missing email"]);
  });

  it("aggregates cost + receiptIds from each verifyEmail call", async () => {
    const targets: T[] = [
      { email: "a@x.dev", name: "A" },
      { email: "b@y.dev", name: "B" },
    ];
    verifyResponseFor = (email) => ({
      status: "ok",
      email,
      valid: true,
      deliverable: true,
      catch_all: false,
      disposable: false,
      cost: 0.012,
    });
    const r = await verifyAndFilterTargets(targets, (t) => t.email, {
      playName: "p",
      dryRun: false,
    });
    expect(r.receiptIds).toHaveLength(2);
    expect(r.costUsd).toBeCloseTo(0.024, 5);
  });

  it("falls back to a default cost when the SDK doesn't return one", async () => {
    verifyResponseFor = (email) => ({
      status: "ok",
      email,
      valid: true,
      deliverable: true,
      catch_all: false,
      disposable: false,
      // no cost field
    });
    const r = await verifyAndFilterTargets([{ email: "a@x.dev", name: "A" }] as T[], (t) => t.email, {
      playName: "p",
      dryRun: false,
    });
    expect(r.costUsd).toBe(0.01);
  });

  it("forwards the playName to verifyEmail so receipts are tagged correctly", async () => {
    await verifyAndFilterTargets([{ email: "a@x.dev", name: "A" }] as T[], (t) => t.email, {
      playName: "post-funding",
      dryRun: false,
    });
    expect(calls.verifyEmail[0]?.playName).toBe("post-funding");
  });
});
