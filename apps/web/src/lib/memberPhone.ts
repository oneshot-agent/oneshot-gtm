import type { CallsMeResponse, MemberPhoneView } from "@oneshot-gtm/shared-types";

/**
 * Setup → Calls → "Your phone": each signed-in member verifies their own
 * mobile once. Verify asks the server to ring it with a 6-digit code; the
 * page then checks every few seconds until the member typed it in, or gives
 * up after two minutes.
 */

export const VERIFY_POLL_MS = 3000;
export const VERIFY_TIMEOUT_MS = 120_000;

/** Which screen "Your phone" shows. */
export type YourPhoneScreen = "no_keys" | "enter" | "verifying" | "verified" | "failed";

export function yourPhoneScreen(
  me: Pick<CallsMeResponse, "bridgeReady" | "phone">,
  opts: { editing: boolean; timedOut: boolean },
): YourPhoneScreen {
  if (!me.bridgeReady) return "no_keys";
  if (opts.editing) return "enter";
  const status = me.phone.status;
  if (status === "verified") return "verified";
  if (status === "verifying") return opts.timedOut ? "failed" : "verifying";
  if (status === "failed") return "failed";
  return "enter";
}

/** Why verifying didn't work, in plain words. */
export function verifyFailure(
  me: Pick<CallsMeResponse, "phone">,
  opts: { timedOut: boolean },
): string {
  if (me.phone.status === "verifying" && opts.timedOut)
    return "The code wasn't typed in within two minutes.";
  return me.phone.error ?? "Your phone couldn't be verified.";
}

/** A typed number that is clearly not a phone; the server normalises the rest. */
export function phoneInputError(value: string): string | null {
  const v = value.trim();
  if (!v) return "Type your mobile number.";
  if (/[^\d\s()+.-]/.test(v)) return "Only digits, spaces and +.";
  const digits = v.replace(/\D/g, "").length;
  if (digits < 7 || digits > 15) return "That doesn't look like a phone number.";
  return null;
}

/**
 * Check every few seconds whether the member typed the code, until the
 * phone is no longer verifying or two minutes pass. A failed check is
 * retried on the next tick. Returns the stop function.
 */
export function pollVerification(
  check: () => Promise<MemberPhoneView>,
  handlers: { onPhone: (phone: MemberPhoneView) => void; onTimeout: () => void },
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): () => void {
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearInterval(tick);
    clearTimeout(limit);
  };
  const tick = setInterval(() => {
    check().then(
      (phone) => {
        if (stopped) return;
        handlers.onPhone(phone);
        if (phone.status !== "verifying") stop();
      },
      () => {},
    );
  }, opts.intervalMs ?? VERIFY_POLL_MS);
  const limit = setTimeout(() => {
    stop();
    handlers.onTimeout();
  }, opts.timeoutMs ?? VERIFY_TIMEOUT_MS);
  return stop;
}
