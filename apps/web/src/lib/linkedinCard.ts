import type { LinkedInAccountView } from "@oneshot-gtm/shared-types";
import { linkedinView, type LinkedInCfg, type LinkedInPhase } from "./linkedinConnect.ts";
import { linkedInConnectionView } from "./linkedinConnection.ts";

/**
 * The one LinkedIn card on /setup: two connections, one button.
 *
 * Messaging (the OneShot-connected account Replies imports from and sends
 * through — one for every workspace) and profile reads (the browser session
 * research reads Experience with — one per workspace) cannot share a
 * sign-in: the platform's profile view returns a headline, not a history,
 * and the browser profile cannot message. What they share is the button.
 * Connect runs whichever sign-ins are missing, messaging first because it
 * completes on its own; the profile session ends with the founder's Done.
 *
 * Kept pure so the copy is testable; the component only wires the calls.
 */

/** `unknown`: the account list has not loaded (or failed), so nothing is assumed. */
export type MessagingState = "none" | "connected" | "attention" | "unknown";
/** What the Connect chain is doing right now, on this page. */
export type CardStep = null | "messaging" | "research";
export type ConnectRun = "messaging" | "research";

export interface LinkedInCardView {
  messaging: { state: MessagingState; text: string; ok: boolean };
  research: { phase: LinkedInPhase; text: string; ok: boolean };
  /** The one primary button, if any. */
  primary: "connect" | "done" | null;
  /** What Connect will do, in order. Empty when nothing is missing. */
  connectRuns: ConnectRun[];
  /** The line under the button while a hosted sign-in is open. */
  waiting: string | null;
  /** Both connected. */
  ok: boolean;
}

/**
 * Messaging is connected when at least one account imports and sends
 * without asking for anything. Accounts that exist but need a reconnect, a
 * permission, or a resumed import are managed on Replies, not here: a fresh
 * connect from this card would add a second account, not fix the first.
 * `null` (list not loaded) is unknown, never "no accounts": a Connect that
 * assumed none would add a second account behind a loading spinner.
 */
export function messagingState(accounts: readonly LinkedInAccountView[] | null): {
  state: MessagingState;
  name: string | null;
} {
  if (accounts === null) return { state: "unknown", name: null };
  const live = accounts.find((a) => {
    const v = linkedInConnectionView(a);
    return v.connected && !v.attention;
  });
  if (live) return { state: "connected", name: live.name || null };
  return { state: accounts.length > 0 ? "attention" : "none", name: null };
}

const MESSAGING_WAITING =
  "Sign in to LinkedIn in the tab that opened. OneShot confirms the connection on its own; the profile session then opens in the same tab.";

export function linkedinCardView(args: {
  cfg: LinkedInCfg;
  cookieSet: boolean;
  /** `null` while the account list is loading or when it failed to load. */
  accounts: readonly LinkedInAccountView[] | null;
  /** Why the list failed to load, when it did. */
  accountsError?: string | null;
  step: CardStep;
  liveUrl: string | null;
}): LinkedInCardView {
  const m = messagingState(args.accounts);
  const r = linkedinView(
    args.cfg,
    args.cookieSet,
    Boolean(args.liveUrl) || args.step === "research",
  );

  const messaging = {
    state: m.state,
    ok: m.state === "connected",
    text:
      m.state === "connected"
        ? m.name
          ? `Connected as ${m.name}`
          : "Connected"
        : m.state === "attention"
          ? "Needs attention"
          : m.state === "unknown"
            ? args.accountsError
              ? `Couldn't check — ${args.accountsError}`
              : "Checking…"
            : "Not connected",
  };
  const research = {
    phase: r.phase,
    ok: r.phase === "connected",
    text:
      r.phase === "connected"
        ? r.headline
        : r.phase === "signing-in"
          ? "Signing in…"
          : r.phase === "expired"
            ? "LinkedIn signed you out"
            : args.cookieSet
              ? "A cookie is saved, not connected yet"
              : "Not connected",
  };

  const connectRuns: ConnectRun[] = [];
  if (m.state === "none") connectRuns.push("messaging");
  if (r.phase !== "connected" && r.phase !== "signing-in") connectRuns.push("research");

  const primary: LinkedInCardView["primary"] =
    args.step === "messaging"
      ? null
      : r.phase === "signing-in"
        ? "done"
        : connectRuns.length > 0
          ? "connect"
          : null;

  const waiting =
    args.step === "messaging" ? MESSAGING_WAITING : r.phase === "signing-in" ? r.headline : null;

  return {
    messaging,
    research,
    primary,
    connectRuns,
    waiting,
    ok: messaging.ok && research.ok,
  };
}

/**
 * The messaging sign-in is confirmed by polling an intent id the platform
 * handed back. Kept in sessionStorage so a reload mid-sign-in resumes the
 * poll instead of leaving the account to be discovered on the next Replies
 * visit. Storage can be missing or throwing (private window, previews):
 * every access is guarded and the card works without it.
 */
const INTENT_KEY = "linkedin-connect-intent";

export function readIntent(): string | null {
  try {
    return sessionStorage.getItem(INTENT_KEY);
  } catch {
    return null;
  }
}

export function writeIntent(id: string): void {
  try {
    sessionStorage.setItem(INTENT_KEY, id);
  } catch {
    // no storage: the poll lives for this page only
  }
}

export function clearIntent(): void {
  try {
    sessionStorage.removeItem(INTENT_KEY);
  } catch {
    // nothing stored
  }
}

/** What to tell the founder when the platform closes an intent without a connection. */
export function connectionFailureCopy(status: string, failureReason: string | undefined): string {
  if (failureReason === "duplicate_member") {
    return "OneShot rejected the connection: this LinkedIn member is already connected. Manage it on Replies.";
  }
  return failureReason ?? `Connection ${status}. Try again.`;
}
