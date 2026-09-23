import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinkedInAccountView } from "@oneshot-gtm/shared-types";
import {
  clearIntent,
  connectionFailureCopy,
  linkedinCardView,
  messagingState,
  readIntent,
  writeIntent,
} from "../src/lib/linkedinCard.ts";

// One button for two sign-ins: Connect runs whatever is missing, messaging
// first; the card never shows Connect next to Done; accounts that need
// attention are Replies' business, not a reason to add another one.

const account = (over: Partial<LinkedInAccountView> = {}): LinkedInAccountView => ({
  key: "wallet:acc_1",
  id: "acc_1",
  name: "J. Nicolas",
  workspace: "gtm",
  status: "connected",
  syncState: "partial",
  complete: false,
  lastCheckedAt: null,
  error: null,
  canReply: true,
  canResolve: true,
  backfill: null,
  ...over,
});

const researchOn = {
  linkedinBrowserProfileId: "prof_a",
  linkedinSessionCheckedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  linkedinSessionName: "J. Nicolas",
  linkedinSessionInvalidAt: null,
  linkedinPendingProfileId: null,
};
const researchOff = {
  linkedinBrowserProfileId: null,
  linkedinSessionCheckedAt: null,
  linkedinSessionName: null,
  linkedinSessionInvalidAt: null,
  linkedinPendingProfileId: null,
};

describe("messagingState", () => {
  it("is none without accounts, connected with a working one, attention otherwise", () => {
    expect(messagingState([])).toEqual({ state: "none", name: null });
    expect(messagingState([account()])).toEqual({ state: "connected", name: "J. Nicolas" });
    expect(messagingState([account({ status: "reconnect_required" })]).state).toBe("attention");
    expect(messagingState([account({ canResolve: false })]).state).toBe("attention");
    // One working account is enough, whatever the others need.
    expect(
      messagingState([account({ status: "reconnect_required" }), account({ key: "w:2", id: "2" })])
        .state,
    ).toBe("connected");
  });
});

describe("linkedinCardView", () => {
  it("nothing connected: one Connect that runs messaging, then the profile session", () => {
    const v = linkedinCardView({
      cfg: researchOff,
      cookieSet: false,
      accounts: [],
      step: null,
      liveUrl: null,
    });
    expect(v.primary).toBe("connect");
    expect(v.connectRuns).toEqual(["messaging", "research"]);
    expect(v.messaging.text).toBe("Not connected");
    expect(v.research.text).toBe("Not connected");
    expect(v.waiting).toBeNull();
    expect(v.ok).toBe(false);
  });

  it("only the missing side runs", () => {
    const onlyResearch = linkedinCardView({
      cfg: researchOff,
      cookieSet: false,
      accounts: [account()],
      step: null,
      liveUrl: null,
    });
    expect(onlyResearch.connectRuns).toEqual(["research"]);
    expect(onlyResearch.messaging).toMatchObject({ ok: true, text: "Connected as J. Nicolas" });

    const onlyMessaging = linkedinCardView({
      cfg: researchOn,
      cookieSet: false,
      accounts: [],
      step: null,
      liveUrl: null,
    });
    expect(onlyMessaging.connectRuns).toEqual(["messaging"]);
    expect(onlyMessaging.research.ok).toBe(true);
    expect(onlyMessaging.research.text).toMatch(/^Connected as J\. Nicolas · checked 3h ago$/);
  });

  it("both connected: two check lines and no button", () => {
    const v = linkedinCardView({
      cfg: researchOn,
      cookieSet: false,
      accounts: [account()],
      step: null,
      liveUrl: null,
    });
    expect(v.primary).toBeNull();
    expect(v.connectRuns).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("messaging step: no button, a waiting line that says what happens next", () => {
    const v = linkedinCardView({
      cfg: researchOff,
      cookieSet: false,
      accounts: [],
      step: "messaging",
      liveUrl: null,
    });
    expect(v.primary).toBeNull();
    expect(v.waiting).toMatch(/OneShot confirms the connection on its own/);
    expect(v.waiting).toMatch(/profile session then opens in the same tab/);
  });

  it("profile step, here or resumed from the server, offers Done", () => {
    const here = linkedinCardView({
      cfg: researchOff,
      cookieSet: false,
      accounts: [account()],
      step: "research",
      liveUrl: "https://live.example/x",
    });
    expect(here.primary).toBe("done");
    expect(here.research.text).toBe("Signing in…");
    expect(here.waiting).toMatch(/then click Done/);

    const resumed = linkedinCardView({
      cfg: { ...researchOff, linkedinPendingProfileId: "prof_pending" },
      cookieSet: false,
      accounts: [account()],
      step: null,
      liveUrl: null,
    });
    expect(resumed.primary).toBe("done");
    expect(resumed.connectRuns).toEqual([]);
  });

  it("an account that needs attention is pointed at Replies, not reconnected from here", () => {
    const v = linkedinCardView({
      cfg: researchOn,
      cookieSet: false,
      accounts: [account({ status: "reconnect_required" })],
      step: null,
      liveUrl: null,
    });
    expect(v.messaging).toEqual({ state: "attention", ok: false, text: "Needs attention" });
    expect(v.connectRuns).toEqual([]);
    expect(v.primary).toBeNull();
  });

  it("expired and cookie-saved profile states keep their one-line reason", () => {
    const expired = linkedinCardView({
      cfg: { ...researchOn, linkedinSessionInvalidAt: new Date().toISOString() },
      cookieSet: false,
      accounts: [account()],
      step: null,
      liveUrl: null,
    });
    expect(expired.research.text).toBe("LinkedIn signed you out");
    expect(expired.primary).toBe("connect");
    const cookie = linkedinCardView({
      cfg: researchOff,
      cookieSet: true,
      accounts: [account()],
      step: null,
      liveUrl: null,
    });
    expect(cookie.research.text).toBe("A cookie is saved, not connected yet");
  });
});

describe("intent persistence", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips through sessionStorage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    expect(readIntent()).toBeNull();
    writeIntent("int_1");
    expect(readIntent()).toBe("int_1");
    clearIntent();
    expect(readIntent()).toBeNull();
  });

  it("survives a missing or throwing storage", () => {
    vi.stubGlobal("sessionStorage", undefined);
    expect(readIntent()).toBeNull();
    expect(() => writeIntent("x")).not.toThrow();
    expect(() => clearIntent()).not.toThrow();
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readIntent()).toBeNull();
    expect(() => writeIntent("x")).not.toThrow();
  });
});

describe("connectionFailureCopy", () => {
  it("names the duplicate-member case and falls back to the platform's reason", () => {
    expect(connectionFailureCopy("failed", "duplicate_member")).toMatch(/already connected/);
    expect(connectionFailureCopy("failed", "expired_intent")).toBe("expired_intent");
    expect(connectionFailureCopy("cancelled", undefined)).toBe("Connection cancelled. Try again.");
  });
});
