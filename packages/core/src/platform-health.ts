import { isSettlementAmbiguous } from "./payment-holds.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { logEvent } from "./events.ts";

/**
 * Whether OneShot itself is failing, as opposed to one lookup having no
 * answer. On 2026-11-02 the payment rail stopped confirming for an hour: about
 * 70% of paid calls failed with `settlement_pending`, the finders kept going
 * through every source and company, and the failed work waited a full trigger
 * interval to be tried again. Every SDK call reports here (`watchAgent`), so
 * one place decides when to stop calling and when a run was hit.
 *
 * - `payment`: the payment rail refused or could not settle the charge.
 * - `wallet`: the wallet cannot pay (empty, unfunded). The founder fixes it.
 * - `unavailable`: OneShot could not be reached or answered 5xx.
 * - `tool`: one tool is down ("temporarily unavailable"); others still work.
 */
export type PlatformErrorKind = "payment" | "wallet" | "unavailable" | "tool";

export interface PlatformError {
  kind: PlatformErrorKind;
  /** The provider's reason code when it gave one (`settlement_pending`), else a short label. */
  reason: string;
  paymentAttemptId?: string;
  quoteId?: string;
  stage?: string;
  amount?: string;
  network?: string;
}

/** Thrown instead of calling OneShot while it is paused. Nothing is sent or paid for. */
export class PlatformUnavailableError extends Error {
  constructor(
    readonly kind: PlatformErrorKind,
    readonly reason: string,
    readonly method: string,
  ) {
    super(`OneShot unavailable: ${pauseReason(kind)} (${reason}); ${method} not called`);
    this.name = "PlatformUnavailableError";
  }
}

/** A payment rejection's own reason code that means the wallet cannot pay. */
const WALLET_REASONS = /invalid_payload|insufficient|credit balance does not cover/i;
/** Any other error: only explicit wallet wording ("insufficient information" is an answer). */
const WALLET_MESSAGE = /insufficient[ _](credits|funds|balance)|credit balance does not cover/i;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** The kind of OneShot failure an error is, or null when it is an answer about the input. */
export function classifyPlatformError(err: unknown): PlatformError | null {
  if (!err) return null;
  if (isSettlementAmbiguous(err)) return { kind: "payment", reason: "settlement_ambiguous" };
  if (err instanceof PlatformUnavailableError) return { kind: err.kind, reason: err.reason };
  const e = err as {
    name?: unknown;
    message?: unknown;
    reason?: unknown;
    statusCode?: unknown;
    status?: unknown;
    paymentAttemptId?: unknown;
    quoteId?: unknown;
    stage?: unknown;
    expected?: { amount?: unknown; network?: unknown };
  };
  const name = str(e.name) ?? "";
  const message = err instanceof Error ? err.message : String(str(e.message) ?? err);
  const lower = message.toLowerCase();

  if (name === "PaymentError" || lower.includes("payment rejected")) {
    const reason =
      str(e.reason) ?? /payment rejected:\s*([a-z0-9_]+)/i.exec(message)?.[1] ?? "payment rejected";
    const ids: Omit<PlatformError, "kind" | "reason"> = {};
    const attempt = str(e.paymentAttemptId) ?? /\[payment attempt ([^\]\s]+)\]/.exec(message)?.[1];
    if (attempt) ids.paymentAttemptId = attempt;
    const quote = str(e.quoteId);
    if (quote) ids.quoteId = quote;
    const stage = str(e.stage);
    if (stage) ids.stage = stage;
    const amount = str(e.expected?.amount) ?? /expected \$([\d.]+)/.exec(message)?.[1];
    if (amount) ids.amount = amount;
    const network = str(e.expected?.network);
    if (network) ids.network = network;
    return { kind: WALLET_REASONS.test(reason) ? "wallet" : "payment", reason, ...ids };
  }
  if (name === "InsufficientCreditsError" || WALLET_MESSAGE.test(lower)) {
    return { kind: "wallet", reason: "insufficient credits" };
  }
  if (lower.includes("temporarily unavailable")) {
    return { kind: "tool", reason: "tool temporarily unavailable" };
  }
  const status = typeof e.statusCode === "number" ? e.statusCode : e.status;
  if (typeof status === "number" && status >= 500) {
    return { kind: "unavailable", reason: `http ${status}` };
  }
  if (
    name === "RequestTimeoutError" ||
    /fetch failed|econnreset|econnrefused|etimedout|socket hang up|network (error|unreachable)/.test(
      lower,
    )
  ) {
    return { kind: "unavailable", reason: "unreachable" };
  }
  return null;
}

/** What a paused run says, in words. */
export function pauseReason(kind: PlatformErrorKind): string {
  switch (kind) {
    case "payment":
      return "OneShot payments not settling";
    case "wallet":
      return "OneShot wallet refused payment (check the balance)";
    case "tool":
      return "a OneShot tool is temporarily unavailable";
    default:
      return "OneShot unreachable";
  }
}

/** The calls in the window that decides a pause. */
export const PLATFORM_WINDOW = 10;
/** Failures in the window that pause calls. Not "in a row": successes interleave in a bad patch. */
export const PLATFORM_TRIP = 6;
/** How long a pause lasts before one call probes. */
export const PLATFORM_COOLDOWN_MS = 60_000;

interface Breaker {
  outcomes: boolean[];
  open: boolean;
  openedAt: number;
  /** The one probe after a cooldown, while it is out: which call, and when it went. */
  probe: { id: number; at: number } | null;
  kind: PlatformErrorKind;
  reason: string;
}

/** "platform" for the payment rail and reachability; one key per method for a tool outage. */
const breakers = new Map<string, Breaker>();

function breakerFor(key: string): Breaker {
  let b = breakers.get(key);
  if (!b) {
    b = { outcomes: [], open: false, openedAt: 0, probe: null, kind: "unavailable", reason: "" };
    breakers.set(key, b);
  }
  return b;
}

/**
 * Whether this call's answer decides an open breaker: it is the probe, or no
 * probe is out and the cooldown is over. A call that started before the
 * pause, or a send inside it, does not.
 */
function decides(b: Breaker, now: number, probeId: number): boolean {
  if (b.probe) return b.probe.id === probeId;
  return now - b.openedAt >= PLATFORM_COOLDOWN_MS;
}

function record(key: string, failed: PlatformError | null, now: number, probeId = 0): void {
  const b = breakerFor(key);
  if (!failed) {
    if (b.open && decides(b, now, probeId)) {
      logEvent("oneshot.platform_resumed", { key, kind: b.kind, reason: b.reason });
      b.open = false;
      b.openedAt = 0;
      b.probe = null;
      b.outcomes = [];
    }
    b.outcomes.push(false);
  } else {
    b.outcomes.push(true);
    b.kind = failed.kind;
    b.reason = failed.reason;
    if (b.open) {
      // The probe failed: wait another cooldown before the next one.
      if (decides(b, now, probeId)) {
        b.openedAt = now;
        b.probe = null;
      }
    } else if (b.outcomes.slice(-PLATFORM_WINDOW).filter(Boolean).length >= PLATFORM_TRIP) {
      b.open = true;
      b.openedAt = now;
      logEvent(
        "oneshot.platform_paused",
        { key, kind: failed.kind, reason: failed.reason, text: pauseReason(failed.kind) },
        "warn",
      );
    }
  }
  if (b.outcomes.length > PLATFORM_WINDOW) b.outcomes = b.outcomes.slice(-PLATFORM_WINDOW);
}

/**
 * The breaker if calls on `key` are paused: inside the cooldown, or while the
 * one probe after it is out (`admitProbe`).
 */
function pausedBreaker(key: string, now: number): Breaker | null {
  const b = breakers.get(key);
  if (!b?.open) return null;
  if (now - b.openedAt < PLATFORM_COOLDOWN_MS) return b;
  // A probe that never answered (a hung call) frees the slot after a cooldown.
  if (b.probe && now - b.probe.at < PLATFORM_COOLDOWN_MS) return b;
  return null;
}

let nextProbeId = 1;

/** Make this call the probe of `key`'s open breaker past its cooldown; its id, or 0. */
function admitProbe(key: string, now: number): number {
  const b = breakers.get(key);
  if (!b?.open || pausedBreaker(key, now)) return 0;
  b.probe = { id: nextProbeId++, at: now };
  return b.probe.id;
}

/** Free `key`'s probe slot without a verdict, if this call holds it. */
function releaseProbe(key: string, probeId: number): void {
  const b = breakers.get(key);
  if (b?.probe && probeId && b.probe.id === probeId) b.probe = null;
}

/** True while OneShot as a whole is paused (payment rail, wallet or reachability). */
export function isPlatformPaused(now = Date.now()): boolean {
  return pausedBreaker("platform", now) !== null;
}

/** The pause text while OneShot is paused, else null. */
export function platformPauseReason(now = Date.now()): string | null {
  const b = pausedBreaker("platform", now);
  return b ? pauseReason(b.kind) : null;
}

/** Test-only: forget every breaker. */
export function _resetPlatformHealth(): void {
  breakers.clear();
}

/** How much of one run OneShot's failures took. */
export interface PlatformScope {
  /** Platform-wide failures (payment, wallet, unreachable), including calls skipped while paused. */
  errors: number;
  /** Whether OneShot paused during the run. */
  paused: boolean;
  kind: PlatformErrorKind | null;
}

const scopeStore = new AsyncLocalStorage<PlatformScope>();

/** Platform-wide failures in one run that count as the run being hit. */
export const RUN_OUTAGE_ERRORS = 5;

export function newPlatformScope(): PlatformScope {
  return { errors: 0, paused: false, kind: null };
}

/** Run `fn` with its OneShot failures counted in `scope`. */
export function inPlatformScope<T>(scope: PlatformScope, fn: () => Promise<T>): Promise<T> {
  return scopeStore.run(scope, fn);
}

/** The pause text when a run was hit by a OneShot outage, else null. */
export function runOutage(scope: PlatformScope): string | null {
  if (!scope.kind) return null;
  return scope.paused || scope.errors >= RUN_OUTAGE_ERRORS ? pauseReason(scope.kind) : null;
}

function noteScope(failed: PlatformError, paused: boolean): void {
  if (failed.kind === "tool") return;
  const scope = scopeStore.getStore();
  if (!scope) return;
  scope.errors++;
  scope.kind = failed.kind;
  if (paused) scope.paused = true;
}

/**
 * SDK methods that only read: skipped while OneShot is paused. Sends (email,
 * LinkedIn messages and invites, SMS, voice, mail) always go through and keep
 * their own deferral handling.
 */
const LOOKUPS = new Set([
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
]);
const LOOKUP_TOOLS = new Set(["linkedin/profile-view"]);

function isLookup(method: string, args: unknown[]): boolean {
  if (LOOKUPS.has(method)) return true;
  return method === "tool" && typeof args[0] === "string" && LOOKUP_TOOLS.has(args[0]);
}

function methodKey(method: string, args: unknown[]): string {
  return method === "tool" && typeof args[0] === "string" ? `tool:${args[0]}` : method;
}

interface Probes {
  platform: number;
  tool: number;
}

function observe(method: string, args: unknown[], err: unknown | null, probes: Probes): void {
  const now = Date.now();
  const key = methodKey(method, args);
  if (err === null) {
    record("platform", null, now, probes.platform);
    record(key, null, now, probes.tool);
    return;
  }
  const failed = classifyPlatformError(err);
  if (!failed) {
    // An answer about the input: OneShot and this tool both worked.
    record("platform", null, now, probes.platform);
    record(key, null, now, probes.tool);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  logEvent(
    "oneshot.call_failed",
    { method: key, ...failed, message_500: message.slice(0, 500) },
    "warn",
  );
  // Each call answers every probe it was: a tool outage says OneShot itself
  // is up; a platform failure says nothing about the tool, so its probe slot
  // is freed without a verdict.
  if (failed.kind === "tool") {
    record("platform", null, now, probes.platform);
    record(key, failed, now, probes.tool);
  } else {
    record("platform", failed, now, probes.platform);
    releaseProbe(key, probes.tool);
  }
  noteScope(failed, isPlatformPaused(now));
}

/**
 * Wrap the SDK so every call reports to the breakers, and lookups are skipped
 * while OneShot (or that one tool) is paused. Results and errors pass through
 * unchanged.
 */
export function watchAgent<T extends object>(agent: T): T {
  const wrapped = new Map<string, { value: unknown; fn: unknown }>();
  return new Proxy(agent, {
    get(target, prop) {
      // The target as receiver: SDK getters may read private fields.
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      const known = wrapped.get(prop);
      if (known?.value === value) return known.fn;
      const fn = (...args: unknown[]): unknown => {
        const probes: Probes = { platform: 0, tool: 0 };
        if (isLookup(prop, args)) {
          const now = Date.now();
          const key = methodKey(prop, args);
          const paused = pausedBreaker("platform", now) ?? pausedBreaker(key, now);
          if (paused) {
            noteScope({ kind: paused.kind, reason: paused.reason }, true);
            return Promise.reject(new PlatformUnavailableError(paused.kind, paused.reason, prop));
          }
          // Past a cooldown this call is the one probe; others wait for its answer.
          probes.platform = admitProbe("platform", now);
          probes.tool = admitProbe(key, now);
        }
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        // Only calls that go to OneShot (they return a promise) count.
        if (!out || typeof (out as Promise<unknown>).then !== "function") return out;
        return (out as Promise<unknown>).then(
          (res) => {
            observe(prop, args, null, probes);
            return res;
          },
          (err: unknown) => {
            observe(prop, args, err, probes);
            throw err;
          },
        );
      };
      wrapped.set(prop, { value, fn });
      return fn;
    },
  });
}
