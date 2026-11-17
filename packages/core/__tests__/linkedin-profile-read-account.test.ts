import { beforeEach, describe, expect, it } from "vitest";
import type { LinkedInAccount } from "@oneshot-agent/sdk";
import {
  getLinkedInInboxStore,
  linkedInProfileReadAccount,
  linkedInOutreachAccount,
  linkedInAccountSelectionBlocker,
  linkedInConversationFor,
  linkedInProfileReadBlocker,
} from "../src/linkedin-inbox.ts";

import { loadConfig, saveConfig } from "../src/config.ts";

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
  store.db.exec("DELETE FROM accounts; DELETE FROM conversations;");
  saveConfig({ ...loadConfig(), linkedin: undefined });
});

describe("linkedInProfileReadAccount", () => {
  it("is none until an account is connected", () => {
    expect(linkedInProfileReadAccount()).toBeNull();
    expect(linkedInProfileReadBlocker()).toBe("none");
  });

  it("blocks sends and reads when several accounts have no selection", () => {
    save("reader", "alpha", "connected", ["read", "view_profile"]);
    save("outreach", "beta", "connected", ["read", "view_profile", "invite"]);
    expect(linkedInProfileReadAccount()).toBeNull();
    expect(linkedInOutreachAccount()).toBeNull();
    expect(linkedInProfileReadBlocker()).toBe("ambiguous");
  });

  it("never passes over the selected account when it loses grants", () => {
    save("outreach", "beta", "connected", ["read", "invite"]);
    save("reader", "alpha", "connected", ["view_profile"]);
    saveConfig({ ...loadConfig(), linkedin: { accountKey: "wallet-beta:outreach" } });
    expect(linkedInProfileReadAccount()).toBeNull();
    expect(linkedInProfileReadBlocker()).toBe("no-grant");
    save("outreach", "beta", "connected", ["read"]);
    expect(linkedInOutreachAccount()).toEqual({
      workspace: "beta",
      accountId: "outreach",
      canInvite: false,
    });
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

it("keeps single-account automatic selection unchanged", () => {
  save("only", "alpha", "connected", ["invite", "view_profile"]);
  expect(linkedInOutreachAccount()).toEqual({
    workspace: "alpha",
    accountId: "only",
    canInvite: true,
  });
  expect(linkedInProfileReadAccount()).toEqual({ workspace: "alpha", accountId: "only" });
  expect(linkedInAccountSelectionBlocker()).toBeNull();
});

it("never falls back when the selected account is disconnected, removed, or absent", () => {
  save("other", "alpha", "connected", ["invite", "view_profile"]);
  saveConfig({ ...loadConfig(), linkedin: { accountKey: "wallet-beta:selected" } });
  expect(linkedInAccountSelectionBlocker()).toBe("missing");
  expect(linkedInOutreachAccount()).toBeNull();
  expect(linkedInProfileReadAccount()).toBeNull();
  save("selected", "beta", "disconnected", ["invite", "view_profile"]);
  expect(linkedInAccountSelectionBlocker()).toBe("disconnected");
  expect(linkedInOutreachAccount()).toBeNull();
  expect(linkedInProfileReadAccount()).toBeNull();
  save("selected", "beta", "connected", ["invite", "view_profile"], "2026-11-17");
  expect(linkedInAccountSelectionBlocker()).toBe("missing");
  expect(linkedInOutreachAccount()).toBeNull();
  expect(linkedInProfileReadAccount()).toBeNull();
});

it("only returns a cadence conversation belonging to the selected account", () => {
  for (const owner of ["alpha", "beta"]) {
    save(owner, owner, "connected", ["invite", "reply"]);
    const accountKey = `wallet-${owner}:${owner}`;
    store.saveConversation(accountKey, { id: owner, attendees: [] } as never, []);
    store.assign(`linkedin:${accountKey}:${owner}`, { workspace: "alpha", prospectId: 1 });
  }
  const person = { workspace: "alpha", prospectId: 1, linkedinUrl: null };
  expect(linkedInConversationFor(person)).toBeNull();
  saveConfig({ ...loadConfig(), linkedin: { accountKey: "wallet-beta:beta" } });
  expect(linkedInConversationFor(person)).toEqual({
    conversationId: "beta",
    accountId: "beta",
    workspace: "beta",
  });
  save("beta", "beta", "disconnected", ["reply"]);
  expect(linkedInConversationFor(person)).toBeNull();
});
