import { describe, expect, it } from "vitest";
import type { LinkedInAccountView } from "@oneshot-gtm/shared-types";
import { linkedInConnectionView } from "../src/lib/linkedinConnection.ts";
const base: LinkedInAccountView = {
  key: "a",
  id: "a",
  name: "Founder",
  workspace: "test",
  status: "connected",
  syncState: "partial",
  complete: false,
  lastCheckedAt: null,
  error: null,
  canReply: true,
  canResolve: true,
};
describe("LinkedIn connection presentation", () => {
  it("does not turn an import timeout into a reconnect requirement", () => {
    const view = linkedInConnectionView({
      ...base,
      backfill: {
        stage: "blocked",
        error: "The operation timed out.",
        senders: { total: 156, resolved: 156 },
        counts: {},
      },
    });
    expect(view).toMatchObject({
      reconnect: false,
      connected: true,
      paused: true,
      showProgress: false,
      title: "History import paused",
    });
  });
  it.each(["account", "sync"])("prioritizes a provider reconnect requirement from %s", (source) => {
    const view = linkedInConnectionView({
      ...base,
      ...(source === "account"
        ? { status: "reconnect_required" }
        : { syncState: "reconnect_required" }),
      backfill: { stage: "blocked", counts: {} },
      canResolve: false,
    });
    expect(view).toMatchObject({
      reconnect: true,
      connected: false,
      needsPermissions: false,
      title: "Reconnect LinkedIn",
      showProgress: false,
    });
  });
  it.each(["blocked", "complete", "capture", "provider", "waiting"])(
    "does not present sender checks as overall progress during %s",
    (stage) => {
      expect(
        linkedInConnectionView({
          ...base,
          backfill: { stage, senders: { total: 156, resolved: 156 }, counts: {} },
        }).showProgress,
      ).toBe(false);
    },
  );
  it("only shows ongoing profile lookup progress", () => {
    expect(
      linkedInConnectionView({
        ...base,
        backfill: { stage: "resolve", senders: { total: 156, resolved: 12 }, counts: {} },
      }).showProgress,
    ).toBe(true);
  });
  it("separates permission upgrades from reconnecting", () => {
    expect(linkedInConnectionView({ ...base, canResolve: false })).toMatchObject({
      reconnect: false,
      needsPermissions: true,
      title: "Allow profile access",
    });
  });
});
