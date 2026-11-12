import { Database } from "bun:sqlite";
import { logEvent } from "../src/events.ts";
vi.mock("../src/events.ts", () => ({ logEvent: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SharedDb, getSharedDb, sharedDbPath } from "../src/shared-db.ts";
import {
  protectPayments,
  withPaymentOperation,
  PaymentHeldError,
  listPaymentHolds,
  resolvePaymentHold,
} from "../src/payment-holds.ts";
import { isNegativeCacheable, paidCacheKey, withPaidCache } from "../src/paid-cache.ts";
import { isTransientToolError } from "../src/send-routing.ts";
import { assertEmailSent, EmailSetupRequiredError } from "../src/oneshot.ts";
import { validateDomainSetup } from "../src/domain-setup.ts";

beforeEach(() => {
  for (const h of listPaymentHolds()) getSharedDb().releasePayment(h.key, h.claim_token);
});
function ambiguous() {
  return Object.assign(new Error("settlement_ambiguous HTTP 500"), {
    name: "SettlementAmbiguousError",
    settlementId: "st_123",
  });
}

describe("payment settlement holds", () => {
  it.each(["email", "personFind", "buyDomain", "voice", "sms", "browser", "build"])(
    "holds %s across agent recreation and a second database connection",
    async (method) => {
      const call = vi.fn().mockRejectedValue(ambiguous());
      const args =
        method === "buyDomain" ? ["example.com", "quote_1"] : [{ to: "a@example.com", limit: 25 }];
      const agent = protectPayments({ [method]: call }, "0xABC");
      await expect(agent[method]!(...args)).rejects.toMatchObject({
        name: "PaymentHeldError",
        settlementId: "st_123",
      });
      const secondDb = new SharedDb(sharedDbPath());
      expect(secondDb.paymentHolds()).toHaveLength(1);
      secondDb.close();
      const restarted = protectPayments({ [method]: call }, "0xabc");
      await expect(restarted[method]!(...args)).rejects.toBeInstanceOf(PaymentHeldError);
      if (method === "buyDomain")
        await expect(restarted[method]!("example.com", "quote_2")).rejects.toBeInstanceOf(
          PaymentHeldError,
        );
      expect(call).toHaveBeenCalledTimes(1);
      expect(logEvent).toHaveBeenLastCalledWith(
        "payment.held",
        { key: listPaymentHolds()[0]!.key, method },
        "warn",
      );
      const hold = listPaymentHolds()[0]!;
      expect(() => resolvePaymentHold(hold.key, "")).toThrow();
      resolvePaymentHold(hold.key, "Confirmed credit received");
      call.mockResolvedValue({ status: "completed" });
      await restarted[method]!(...args);
      expect(call).toHaveBeenCalledTimes(2);
      expect(listPaymentHolds()).toEqual([]);
    },
  );
  it.each(["success", "ambiguous", "failure"])(
    "a late %s cannot clear or overwrite a replacement hold",
    async (outcome) => {
      let finish!: (value?: unknown) => void;
      let fail!: (err: unknown) => void;
      const call = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve, reject) => {
              finish = resolve;
              fail = reject;
            }),
        )
        .mockRejectedValueOnce(Object.assign(ambiguous(), { settlementId: "st_new" }));
      const agent = protectPayments({ personFind: call }, "wallet");
      const first = agent.personFind({ limit: 25 });
      const firstOutcome = first.catch(() => undefined);
      resolvePaymentHold(listPaymentHolds()[0]!.key, "Reconciled first attempt");
      await expect(agent.personFind({ limit: 25 })).rejects.toBeInstanceOf(PaymentHeldError);
      const replacement = listPaymentHolds()[0]!;
      if (outcome === "success") finish({ status: "completed" });
      else
        fail(
          outcome === "ambiguous"
            ? ambiguous()
            : Object.assign(new Error("invalid input"), { name: "ValidationError" }),
        );
      await firstOutcome;
      expect(listPaymentHolds()).toEqual([replacement]);
      expect(listPaymentHolds()[0]!.settlement_id).toBe("st_new");
    },
  );
  it.each(["JobTimeoutError", "RequestTimeoutError"])(
    "retains accepted execution after %s across polling changes",
    async (name) => {
      const call = vi.fn().mockRejectedValue(
        Object.assign(new Error("polling timed out"), {
          name,
          jobId: "job_accepted",
          idempotencyKey: "idem_accepted",
        }),
      );
      const agent = protectPayments({ email: call }, "wallet");
      await expect(
        agent.email({ to: "a@example.com", totalTimeoutMs: 10, wait: true }),
      ).rejects.toMatchObject({
        name: "PaymentHeldError",
        requestId: "job_accepted",
        executionUncertain: true,
        localPaymentRefusal: false,
      });
      const db = new SharedDb(sharedDbPath());
      expect(db.paymentHolds()[0]).toMatchObject({
        request_id: "job_accepted",
        idempotency_key: "idem_accepted",
        execution_uncertain: 1,
      });
      db.close();
      await expect(
        agent.email({ to: "a@example.com", totalTimeoutMs: 100, wait: false }),
      ).rejects.toMatchObject({
        requestId: "job_accepted",
        executionUncertain: true,
        localPaymentRefusal: true,
      });
      expect(call).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["OneShotError", "ToolError"])(
    "retains an accepted job after a polling %s",
    async (name) => {
      const call = vi.fn().mockRejectedValue(
        Object.assign(new Error("Polling failed"), {
          name,
          phase: "polling",
          requestId: "req_accepted",
          idempotencyKey: "idem_accepted",
        }),
      );
      const agent = protectPayments({ personFind: call }, "wallet");
      await expect(agent.personFind({ limit: 25 })).rejects.toMatchObject({
        name: "PaymentHeldError",
        executionUncertain: true,
        requestId: "req_accepted",
      });
      expect(listPaymentHolds()[0]).toMatchObject({
        request_id: "req_accepted",
        idempotency_key: "idem_accepted",
        execution_uncertain: 1,
      });
      await expect(agent.personFind({ limit: 25 })).rejects.toBeInstanceOf(PaymentHeldError);
      expect(call).toHaveBeenCalledTimes(1);
    },
  );
  it("releases a terminal job failure reported while polling", async () => {
    const error = Object.assign(new Error("Job failed"), {
      name: "JobError",
      phase: "polling",
      requestId: "req_failed",
    });
    const agent = protectPayments({ personFind: vi.fn().mockRejectedValue(error) }, "wallet");
    await expect(agent.personFind({ limit: 25 })).rejects.toBe(error);
    expect(listPaymentHolds()).toEqual([]);
  });
  it.each(["voice", "sms", "browser", "build"])(
    "holds %s when a paid response is lost without metadata",
    async (method) => {
      const call = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      const agent = protectPayments({ [method]: call }, "wallet");
      await expect(agent[method]!({ input: "same" })).rejects.toMatchObject({
        executionUncertain: true,
      });
      await expect(agent[method]!({ input: "same" })).rejects.toBeInstanceOf(PaymentHeldError);
      expect(call).toHaveBeenCalledTimes(1);
    },
  );
  it("records reconciliation durably without writing the note to diagnostics", async () => {
    const agent = protectPayments({ sms: vi.fn().mockRejectedValue(ambiguous()) }, "wallet");
    await agent.sms({}).catch(() => {});
    const hold = listPaymentHolds()[0]!;
    resolvePaymentHold(hold.key, "private reconciliation detail");
    const db = new Database(sharedDbPath(), { readonly: true });
    try {
      expect(
        db
          .query("SELECT note,hold_json FROM payment_resolutions WHERE claim_token=?")
          .get(hold.claim_token),
      ).toEqual({ note: "private reconciliation detail", hold_json: JSON.stringify(hold) });
    } finally {
      db.close();
    }
    expect(logEvent).toHaveBeenLastCalledWith("payment.hold_resolved", { key: hold.key });
    expect(listPaymentHolds()).toEqual([]);
  });
  it("rolls back the audit record when releasing the hold fails", async () => {
    const agent = protectPayments({ sms: vi.fn().mockRejectedValue(ambiguous()) }, "wallet");
    await agent.sms({}).catch(() => {});
    const hold = listPaymentHolds()[0]!;
    const release = vi.spyOn(getSharedDb(), "releasePayment").mockImplementationOnce(() => {
      throw new Error("write failed");
    });
    try {
      expect(() => resolvePaymentHold(hold.key, "reconciled")).toThrow("write failed");
    } finally {
      release.mockRestore();
    }
    expect(listPaymentHolds()).toEqual([hold]);
    const db = new Database(sharedDbPath(), { readonly: true });
    try {
      expect(
        db.query("SELECT 1 FROM payment_resolutions WHERE claim_token=?").get(hold.claim_token),
      ).toBeNull();
    } finally {
      db.close();
    }
  });
  it("equivalent lookup inputs cannot bypass a held payment", async () => {
    const call = vi.fn().mockRejectedValue(ambiguous());
    const agent = protectPayments({ personFind: call }, "wallet");
    for (const keywords of [
      ["AI", "Cloud"],
      ["cloud", "ai"],
    ]) {
      await expect(
        withPaidCache("research.people", { keywords }, { fresh: true }, async () => ({
          result: await agent.personFind({ keywords }),
          receiptId: 0,
        })),
      ).rejects.toBeInstanceOf(PaymentHeldError);
    }
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("preserves a successful result and its hold when cleanup fails", async () => {
    const out = { status: "completed" };
    const agent = protectPayments({ personFind: vi.fn().mockResolvedValue(out) }, "wallet");
    const release = vi.spyOn(getSharedDb(), "releasePayment").mockImplementationOnce(() => {
      throw new Error("database locked");
    });
    try {
      await expect(agent.personFind({ limit: 25 })).resolves.toBe(out);
      expect(release).toHaveBeenCalledTimes(1);
      expect(listPaymentHolds()).toHaveLength(1);
    } finally {
      release.mockRestore();
    }
  });
  it("a redrafted email cannot bypass the same operation's hold", async () => {
    const email = vi.fn().mockRejectedValue(ambiguous());
    const agent = protectPayments({ email }, "wallet");
    await expect(
      withPaymentOperation("cadence:1", () => agent.email({ body: "first" })),
    ).rejects.toBeInstanceOf(PaymentHeldError);
    await expect(
      withPaymentOperation("cadence:1", () => agent.email({ body: "revised" })),
    ).rejects.toBeInstanceOf(PaymentHeldError);
    expect(email).toHaveBeenCalledTimes(1);
  });
  it("neither retries nor caches ambiguous errors as lookup verdicts", () => {
    for (const e of [ambiguous(), new PaymentHeldError("key", "st_123")]) {
      expect(isTransientToolError(e)).toBe(false);
      expect(isNegativeCacheable(e)).toBe(false);
    }
  });
  it("blocks simultaneous duplicate dispatch, without holding successful or definite failures", async () => {
    let finish!: (value: unknown) => void;
    const call = vi.fn(
      (_opts: unknown) =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const agent = protectPayments({ personFind: call }, "wallet");
    const first = agent.personFind({ limit: 25 });
    await expect(agent.personFind({ limit: 25, memo: "another workspace" })).rejects.toBeInstanceOf(
      PaymentHeldError,
    );
    finish({ status: "completed" });
    await first;
    expect(listPaymentHolds()).toEqual([]);
    const bad = protectPayments(
      {
        email: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error("invalid input"), { name: "ValidationError" }),
          ),
      },
      "wallet",
    );
    await expect(bad.email({})).rejects.toThrow("invalid input");
    expect(listPaymentHolds()).toEqual([]);
  });
});

it.each(["confirmation_required", "setup_required", "setup_pending"])(
  "%s is never a sent email",
  (status) => {
    expect(() => assertEmailSent({ status })).toThrow(EmailSetupRequiredError);
  },
);
it("accepts normal sends", () => expect(() => assertEmailSent({ status: "sent" })).not.toThrow());
it("uses the same cache identity for omitted and explicit default limits", () => {
  expect(paidCacheKey("research.people", { keywords: ["ai"] })).toBe(
    paidCacheKey("research.people", { keywords: ["ai"], limit: 25 }),
  );
  expect(paidCacheKey("research.people", { limit: 100 })).not.toBe(
    paidCacheKey("research.people", { limit: 25 }),
  );
});
it("validates and normalizes domain setup choices", () => {
  expect(validateDomainSetup(" Example.COM ")).toEqual({
    domain: "example.com",
    options: { addresses: ["agent"] },
  });
  expect(
    validateDomainSetup("example.com", { mailbox_mode: "mailbox", addresses: ["SALES", "support"] })
      .options.addresses,
  ).toEqual(["sales", "support"]);
  for (const addresses of [
    [],
    ["sales", "SALES"],
    ["a@example.com"],
    Array.from({ length: 11 }, (_, i) => `a${i}`),
  ]) {
    expect(() => validateDomainSetup("example.com", { addresses })).toThrow();
  }
});
