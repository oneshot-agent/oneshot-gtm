import { beforeEach, describe, expect, it, vi } from "vitest";

// resolveAndVerifyContact composes the real safeFindEmail/safeVerifyEmail
// (which call the mocked core findEmail/verifyEmail) + a mocked prescreen.

let findFound = true;
let findCost = 0.01;
let verifyDeliverable = true;
let prescreenOk = true;
let findThrows = false;
let findRejectsInput = false;
let findCalls = 0;
let verifyCalls = 0;
let findInputs: Array<Record<string, unknown>> = [];
let nextPeople: Array<Record<string, unknown>> = [];
let peopleStatus: "ok" | "error" = "ok";
let peopleCalls: Array<Record<string, unknown>> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    logEvent: () => {},
    peopleSearch: async (input: Record<string, unknown>) => {
      peopleCalls.push(input);
      return {
        result: {
          status: peopleStatus,
          results: peopleStatus === "ok" ? nextPeople : [],
          total_found: nextPeople.length,
          cost: 0.01,
        },
        receiptId: 5,
      };
    },
    findEmail: async (input: Record<string, unknown>) => {
      findCalls++;
      findInputs.push(input);
      if (findThrows) throw new Error("Job failed: Tool execution failed. (ref: x)");
      if (findRejectsInput) {
        const err = new Error("Either full_name or both first_name and last_name required");
        err.name = "ValidationError";
        throw err;
      }
      return {
        result: {
          status: "ok",
          email: findFound ? "found@acme.dev" : null,
          found: findFound,
          full_name: "Found Name",
          cost: findCost,
        },
        receiptId: 1,
      };
    },
    verifyEmail: async ({ email }: { email: string }) => {
      verifyCalls++;
      return {
        result: {
          status: "ok",
          email,
          valid: verifyDeliverable,
          deliverable: verifyDeliverable,
          catch_all: false,
          disposable: false,
          cost: 0.005,
        },
        receiptId: 1,
      };
    },
  };
});
vi.mock("../src/_findemail-prescreen.ts", () => ({
  shouldSkipFindEmail: () => (prescreenOk ? { ok: true } : { ok: false, reason: "role-account" }),
}));

const { resolveAndVerifyContact } = await import("../src/_contact.ts");
const { _resetBreaker } = await import("../src/_breaker.ts");

beforeEach(() => {
  findFound = true;
  findCost = 0.01;
  verifyDeliverable = true;
  prescreenOk = true;
  findThrows = false;
  findRejectsInput = false;
  findCalls = 0;
  verifyCalls = 0;
  findInputs = [];
  nextPeople = [];
  peopleStatus = "ok";
  peopleCalls = [];
  _resetBreaker();
});

describe("resolveAndVerifyContact — no person on the record (SDK 0.32 needs one)", () => {
  const domainOnly = {
    playName: "t",
    fullName: null,
    companyDomain: "riverafamilydental.com",
    allowMissingFullName: true,
  };

  it("looks a person up at the domain, then resolves their email by name", async () => {
    nextPeople = [{ full_name: "Dana Rivera", title: "Owner" }];
    const res = await resolveAndVerifyContact(domainOnly);
    expect(peopleCalls).toHaveLength(1);
    expect(peopleCalls[0]).toMatchObject({ companyDomains: ["riverafamilydental.com"], limit: 5 });
    expect(findInputs[0]).toMatchObject({
      companyDomain: "riverafamilydental.com",
      fullName: "Dana Rivera",
    });
    expect(res).toMatchObject({ ok: true, email: "found@acme.dev", title: "Owner" });
    if (res.ok) expect(res.costUsd).toBeCloseTo(0.01 + 0.01 + 0.005, 6);
  });

  it("skips findEmail when the database already has a work email for the person, and still verifies", async () => {
    nextPeople = [
      { full_name: "Dana Rivera", title: "Owner", best_work_email: "dana@riverafamilydental.com" },
    ];
    const res = await resolveAndVerifyContact(domainOnly);
    expect(findCalls).toBe(0);
    expect(verifyCalls).toBe(1);
    expect(res).toMatchObject({
      ok: true,
      email: "dana@riverafamilydental.com",
      fullName: "Dana Rivera",
    });
  });

  it("drops with not-found — not platform-error — when nobody named is at the domain, without calling findEmail", async () => {
    nextPeople = [{ title: "Front desk" }];
    const res = await resolveAndVerifyContact(domainOnly);
    expect(res).toMatchObject({ ok: false, reason: "not-found" });
    expect(findCalls).toBe(0);
  });

  it("treats a peopleSearch outage as platform-error", async () => {
    peopleStatus = "error";
    const res = await resolveAndVerifyContact(domainOnly);
    expect(res).toMatchObject({ ok: false, reason: "platform-error" });
  });

  it("never runs the lookup when the caller supplied a name", async () => {
    await resolveAndVerifyContact({
      playName: "t",
      fullName: "Given Name",
      companyDomain: "acme.dev",
    });
    expect(peopleCalls).toHaveLength(0);
  });
});

describe("resolveAndVerifyContact — an SDK validation rejection is a miss, not an outage", () => {
  it("reports not-found and does not feed the circuit breaker, even five times over", async () => {
    findRejectsInput = true;
    for (let i = 0; i < 5; i++) {
      const res = await resolveAndVerifyContact({
        playName: "t",
        fullName: "X Y",
        companyDomain: "acme.dev",
      });
      expect(res).toMatchObject({ ok: false, reason: "not-found", costUsd: 0 });
    }
    // A sixth call still reaches the SDK: the breaker stayed closed.
    findRejectsInput = false;
    const res = await resolveAndVerifyContact({
      playName: "t",
      fullName: "X Y",
      companyDomain: "acme.dev",
    });
    expect(res.ok).toBe(true);
    expect(findCalls).toBe(6);
  });
});

describe("pickNamedPerson", () => {
  it("prefers a person with a work email, then one with a title, then anyone named", async () => {
    const { pickNamedPerson } = await import("../src/_contact.ts");
    expect(
      pickNamedPerson([
        { full_name: "No Title" },
        { full_name: "Has Title", title: "Owner" },
        { first_name: "Has", last_name: "Email", best_work_email: "x@y.z" },
      ] as never),
    ).toEqual({ fullName: "Has Email", title: null, bestWorkEmail: "x@y.z" });
    expect(
      pickNamedPerson([
        { full_name: "No Title" },
        { full_name: "Has Title", title: "Owner" },
      ] as never)?.fullName,
    ).toBe("Has Title");
    expect(pickNamedPerson([{ title: "Nameless" }, null] as never)).toBeNull();
  });
});

describe("resolveAndVerifyContact", () => {
  it("resolves, verifies, and accumulates find + verify cost on the happy path", async () => {
    const res = await resolveAndVerifyContact({
      playName: "t",
      fullName: "Input Name",
      companyDomain: "acme.dev",
    });
    expect(res).toEqual({
      ok: true,
      email: "found@acme.dev",
      fullName: "Found Name",
      costUsd: 0.015,
    });
  });

  it("drops with no-domain when neither knownEmail nor companyDomain is given", async () => {
    const res = await resolveAndVerifyContact({
      playName: "t",
      fullName: "A",
      companyDomain: null,
    });
    expect(res).toEqual({ ok: false, reason: "no-domain", costUsd: 0 });
    expect(findCalls).toBe(0);
  });

  it("drops with prescreen (and skips findEmail) when the prescreen gate fails", async () => {
    prescreenOk = false;
    const res = await resolveAndVerifyContact({
      playName: "t",
      fullName: "A",
      companyDomain: "acme.dev",
    });
    expect(res).toEqual({ ok: false, reason: "prescreen", costUsd: 0 });
    expect(findCalls).toBe(0);
  });

  it("drops with not-found but still reports the find cost", async () => {
    findFound = false;
    const res = await resolveAndVerifyContact({
      playName: "t",
      fullName: "A",
      companyDomain: "acme.dev",
    });
    expect(res).toEqual({ ok: false, reason: "not-found", costUsd: 0.01 });
    expect(verifyCalls).toBe(0);
  });

  it("drops a duplicate BEFORE verify (no verify spend)", async () => {
    const res = await resolveAndVerifyContact({
      playName: "t",
      fullName: "A",
      companyDomain: "acme.dev",
      isDuplicate: () => true,
    });
    expect(res).toEqual({ ok: false, reason: "duplicate", costUsd: 0.01 });
    expect(verifyCalls).toBe(0);
  });

  it("drops with undeliverable when verify says so", async () => {
    verifyDeliverable = false;
    const res = await resolveAndVerifyContact({
      playName: "t",
      fullName: "A",
      companyDomain: "acme.dev",
    });
    expect(res).toEqual({ ok: false, reason: "undeliverable", costUsd: 0.015 });
  });

  it("skips findEmail when knownEmail is supplied and keeps the caller's fullName", async () => {
    const res = await resolveAndVerifyContact({
      playName: "t",
      fullName: "Caller Name",
      knownEmail: "known@acme.dev",
    });
    expect(res).toEqual({
      ok: true,
      email: "known@acme.dev",
      fullName: "Caller Name",
      costUsd: 0.005,
    });
    expect(findCalls).toBe(0);
    expect(verifyCalls).toBe(1);
  });
});

describe("resolveAndVerifyContact — circuit breaker on platform errors", () => {
  const call = () =>
    resolveAndVerifyContact({ playName: "t", fullName: "A", companyDomain: "acme.dev" });

  it("a backend throw → reason 'platform-error' (not 'not-found'), with find cost 0", async () => {
    findThrows = true;
    const res = await call();
    expect(res).toEqual({ ok: false, reason: "platform-error", costUsd: 0 });
  });

  it("opens after 5 consecutive platform errors and then short-circuits (no SDK call)", async () => {
    findThrows = true;
    for (let i = 0; i < 5; i++) {
      const r = await call();
      expect(r.ok === false && r.reason).toBe("platform-error");
    }
    expect(findCalls).toBe(5);
    // 6th call: breaker open → short-circuit, no new findEmail call.
    const res = await call();
    expect(res).toEqual({ ok: false, reason: "platform-error", costUsd: 0 });
    expect(findCalls).toBe(5); // unchanged — short-circuited
  });

  it("a genuine outcome resets the breaker (isolated errors don't trip it)", async () => {
    findThrows = true;
    for (let i = 0; i < 3; i++) await call(); // 3 errors, below threshold
    findThrows = false; // backend answers
    const ok = await call();
    expect(ok.ok).toBe(true);
    // Counter reset: a fresh error after a success starts over, doesn't carry 3.
    findThrows = true;
    await call();
    expect(findCalls).toBe(5); // 3 + 1 success + 1 error, all real calls (never short-circuited)
  });
});
