import { beforeEach, describe, expect, it } from "vitest";
import type { LinkedInAccount } from "@oneshot-agent/sdk";
import {
  getLinkedInInboxStore,
  linkedInProfileReadAccount,
  linkedInProfileReadBlocker,
} from "../src/linkedin-inbox.ts";

// Which connected account person research reads profiles through, and why
// none can: never connected, needs a reconnect, or not granted profile views.

const store = getLinkedInInboxStore();

function save(
  id: string,
  workspace: string,
  status: string,
  actions: string[],
  removedAt?: string,
): void {
  store.saveAccount({
    key: `wallet-${workspace}:${id}`,
    wallet: `wallet-${workspace}`,
    workspace,
    account: { id, member_urn: id, status, allowed_actions: actions } as unknown as LinkedInAccount,
    sync: null,
    checkedAt: null,
    error: null,
    ...(removedAt ? { removedAt } : {}),
  });
}

beforeEach(() => {
  store.db.exec("DELETE FROM accounts");
});

describe("linkedInProfileReadAccount", () => {
  it("is none until an account is connected", () => {
    expect(linkedInProfileReadAccount()).toBeNull();
    expect(linkedInProfileReadBlocker()).toBe("none");
  });

  it("picks a connected account granted profile views, the outreach account first", () => {
    save("reader", "alpha", "connected", ["read", "view_profile"]);
    save("outreach", "beta", "connected", ["read", "view_profile", "invite"]);
    expect(linkedInProfileReadAccount()).toEqual({ workspace: "beta", accountId: "outreach" });
    expect(linkedInProfileReadBlocker()).toBeNull();
  });

  it("passes over the outreach account when it may not view profiles", () => {
    save("outreach", "beta", "connected", ["read", "invite"]);
    save("reader", "alpha", "connected", ["view_profile"]);
    expect(linkedInProfileReadAccount()).toEqual({ workspace: "alpha", accountId: "reader" });
  });

  it("says why no account can read: the grant, or a reconnect", () => {
    save("outreach", "beta", "connected", ["read", "invite"]);
    expect(linkedInProfileReadAccount()).toBeNull();
    expect(linkedInProfileReadBlocker()).toBe("no-grant");
    store.db.exec("DELETE FROM accounts");
    save("expired", "beta", "disconnected", ["read", "view_profile"]);
    expect(linkedInProfileReadBlocker()).toBe("disconnected");
    store.db.exec("DELETE FROM accounts");
    save("gone", "gamma", "connected", ["view_profile"], "2026-10-01T00:00:00.000Z");
    expect(linkedInProfileReadBlocker()).toBe("none");
  });
});
