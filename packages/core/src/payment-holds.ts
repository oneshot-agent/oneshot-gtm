import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { getSharedDb } from "./shared-db.ts";
import { logEvent } from "./events.ts";

export function isSettlementAmbiguous(err: unknown): boolean {
  const e = err as { name?: string } | null;
  return e?.name === "SettlementAmbiguousError" || e?.name === "PaymentHeldError";
}

interface HeldExecution {
  requestId?: string;
  idempotencyKey?: string;
  executionUncertain?: boolean;
  localRefusal?: boolean;
}
export class PaymentHeldError extends Error {
  readonly requestId?: string;
  readonly idempotencyKey?: string;
  readonly executionUncertain: boolean;
  readonly localPaymentRefusal: boolean;
  constructor(
    readonly holdKey: string,
    readonly settlementId?: string,
    execution: HeldExecution = {},
  ) {
    super(
      `${execution.executionUncertain ? "Paid call outcome unresolved" : "Payment unresolved"}${settlementId ? ` (${settlementId})` : ""}${execution.requestId ? ` (request ${execution.requestId})` : ""}; operation not retried. Reconcile it, then resolve hold ${holdKey} with 'oneshot-gtm payments resolve'.`,
    );
    this.name = "PaymentHeldError";
    this.requestId = execution.requestId;
    this.idempotencyKey = execution.idempotencyKey;
    this.executionUncertain = execution.executionUncertain ?? false;
    this.localPaymentRefusal = execution.localRefusal ?? false;
  }
}
export function isLocalPaymentRefusal(err: unknown): boolean {
  return (err as { localPaymentRefusal?: unknown } | null)?.localPaymentRefusal === true;
}
export function isPaymentExecutionUncertain(err: unknown): boolean {
  return (err as { executionUncertain?: unknown } | null)?.executionUncertain === true;
}
function timedOutExecution(err: unknown): HeldExecution | null {
  const e = err as {
    name?: string;
    jobId?: string;
    requestId?: string;
    idempotencyKey?: string;
  } | null;
  if (e?.name !== "JobTimeoutError" && e?.name !== "RequestTimeoutError") return null;
  return {
    requestId: e.requestId ?? e.jobId,
    idempotencyKey: e.idempotencyKey,
    executionUncertain: true,
  };
}

// Audit and polling controls do not make a new purchase. Object order must not either.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k, v]) =>
            ![
              "memo",
              "decisionContext",
              "signal",
              "timeout",
              "totalTimeoutMs",
              "wait",
              "fresh",
              "maxCost",
            ].includes(k) &&
            typeof v !== "function" &&
            v !== undefined,
        )
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

const operation = new AsyncLocalStorage<string>();
export function withPaymentOperation<T>(key: string, run: () => Promise<T>): Promise<T> {
  return operation.run(key, run);
}
const guarded = new Set([
  "email",
  "voice",
  "sms",
  "browser",
  "build",
  "buyDomain",
  "personProfile",
  "personFind",
  "personEmail",
  "personEmailStatus",
  "personDossier",
  "personPosts",
  "companyFind",
  "companyProfile",
  "research",
  "webRead",
  "webSearch",
  "businessFind",
  "businessResolve",
  "recordSolicitationsFind",
  "tool",
]);

/** Persist before dispatch. A crash leaves a hold for explicit reconciliation, never a timed retry. */
export function protectPayments<T extends object>(agent: T, wallet: string): T {
  return new Proxy(agent, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (typeof prop !== "string" || !guarded.has(prop)) return value.bind(target);
      return async (...args: unknown[]) => {
        // A replacement domain quote must not bypass an unresolved purchase.
        const input = operation.getStore()
          ? { operation: operation.getStore() }
          : prop === "buyDomain"
            ? [args[0]]
            : args;
        const key = createHash("sha256")
          .update(JSON.stringify([wallet.toLowerCase(), prop, canonical(input)]))
          .digest("hex");
        const db = getSharedDb();
        const claimToken = randomUUID();
        if (!db.claimPayment(key, wallet.toLowerCase(), prop, claimToken)) {
          const hold = db.paymentHolds().find((h) => h.key === key);
          throw new PaymentHeldError(key, hold?.settlement_id ?? undefined, {
            requestId: hold?.request_id ?? undefined,
            idempotencyKey: hold?.idempotency_key ?? undefined,
            executionUncertain: hold?.execution_uncertain === 1,
            localRefusal: true,
          });
        }
        let out: unknown;
        try {
          out = await value.apply(target, args);
        } catch (err) {
          const execution = timedOutExecution(err);
          if (isSettlementAmbiguous(err) || execution) {
            const settlementId = (err as { settlementId?: string }).settlementId;
            db.holdPayment(key, claimToken, { settlementId, ...execution });
            logEvent(
              "payment.held",
              { key, method: prop, settlementId, requestId: execution?.requestId },
              "warn",
            );
            throw new PaymentHeldError(key, settlementId, execution ?? undefined);
          }
          db.releasePayment(key, claimToken);
          throw err;
        }
        // A local cleanup failure must not turn a completed paid call into a
        // provider failure or attempt a second release. Leave it held for reconciliation.
        try {
          db.releasePayment(key, claimToken);
        } catch {
          logEvent("payment.hold_cleanup_failed", { key, method: prop }, "warn");
        }
        return out;
      };
    },
  });
}

export function listPaymentHolds() {
  return getSharedDb().paymentHolds();
}
export function resolvePaymentHold(key: string, note: string): void {
  if (!note.trim()) throw new Error("A reconciliation note is required");
  const hold = listPaymentHolds().find((h) => h.key === key);
  if (!hold) throw new Error("Unknown payment hold");
  if (!getSharedDb().releasePayment(key, hold.claim_token))
    throw new Error("Payment hold changed; inspect it again before resolving");
  logEvent("payment.hold_resolved", { key, note });
}
