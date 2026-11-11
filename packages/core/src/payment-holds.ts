import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { getSharedDb } from "./shared-db.ts";
import { logEvent } from "./events.ts";

export function isSettlementAmbiguous(err: unknown): boolean {
  const e = err as { name?: string } | null;
  return e?.name === "SettlementAmbiguousError" || e?.name === "PaymentHeldError";
}

export class PaymentHeldError extends Error {
  constructor(
    readonly holdKey: string,
    readonly settlementId?: string,
  ) {
    super(
      `Payment unresolved${settlementId ? ` (${settlementId})` : ""}; operation not retried. Reconcile the payment, then resolve hold ${holdKey} with 'oneshot-gtm payments resolve'.`,
    );
    this.name = "PaymentHeldError";
  }
}

// Audit and polling controls do not make a new purchase. Object order must not either.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k, v]) =>
            !["memo", "decisionContext", "signal", "timeout", "fresh", "maxCost"].includes(k) &&
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
        const input =
          prop === "email" && operation.getStore()
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
          throw new PaymentHeldError(key, hold?.settlement_id ?? undefined);
        }
        try {
          const out: unknown = await value.apply(target, args);
          db.releasePayment(key, claimToken);
          return out;
        } catch (err) {
          if (isSettlementAmbiguous(err)) {
            const settlementId = (err as { settlementId?: string }).settlementId;
            db.holdPayment(key, claimToken, settlementId);
            logEvent("payment.held", { key, method: prop, settlementId }, "warn");
            throw new PaymentHeldError(key, settlementId);
          }
          db.releasePayment(key, claimToken);
          throw err;
        }
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
