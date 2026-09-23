import { beforeEach, expect, it, vi } from "vitest";
const sdk = vi.fn();
vi.mock("../src/linkedin-client.ts", () => ({
  callLinkedIn: (...args: unknown[]) => sdk(...args),
}));
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  linkedInMatches: () => [],
}));
const { getLinkedInInboxStore, getReplyReviewStore } = await import("@oneshot-gtm/core");
const { adoptPendingLinkedInReplacements } = await import("../src/linkedin-replacement.ts");
const store = getLinkedInInboxStore();
beforeEach(() => {
  store.db.exec(
    "DELETE FROM accounts;DELETE FROM progress;DELETE FROM conversations;DELETE FROM messages;",
  );
  getReplyReviewStore().db.exec("DELETE FROM review_leases");
  store.saveAccount({
    key: "wallet:old",
    wallet: "wallet",
    workspace: "gtm",
    account: { id: "old", member_urn: "owner", status: "revoked" } as never,
    sync: null,
    checkedAt: null,
    error: null,
  });
  store.saveProgress("replacement:wallet:old", {
    stage: "awaiting_login",
    oldAccountKey: "wallet:old",
    oldAccountId: "old",
    member: "owner",
    intentId: "intent",
  });
  sdk.mockReset();
  sdk.mockResolvedValue({
    status: "completed",
    account: {
      id: "new",
      member_urn: "owner",
      status: "connected",
      allowed_actions: ["read", "reply", "view_profile"],
    },
  });
});
it("adopts only the explicitly saved hosted intent and does not revoke or create connections", async () => {
  await adoptPendingLinkedInReplacements();
  expect(sdk).toHaveBeenCalledExactlyOnceWith("gtm", { kind: "connection", intentId: "intent" });
  expect(store.account("wallet:old")?.account.id).toBe("new");
  expect(store.progress("replacement:wallet:old")).toMatchObject({
    stage: "complete",
    newAccountId: "new",
  });
  await adoptPendingLinkedInReplacements();
  expect(sdk).toHaveBeenCalledTimes(1);
});
it("waits while either server holds the capture lease", async () => {
  const token = getReplyReviewStore().claim("capture:wallet:old")!;
  await adoptPendingLinkedInReplacements();
  expect(store.account("wallet:old")?.account.id).toBe("old");
  expect(store.progress("replacement:wallet:old")).toMatchObject({ stage: "awaiting_login" });
  getReplyReviewStore().release("capture:wallet:old", token);
  await adoptPendingLinkedInReplacements();
  expect(store.account("wallet:old")?.account.id).toBe("new");
});
it("does not attach a different signed-in member", async () => {
  sdk.mockResolvedValue({
    status: "completed",
    account: { id: "new", member_urn: "different", status: "connected" },
  });
  await expect(adoptPendingLinkedInReplacements()).rejects.toThrow("does not match");
  expect(store.account("wallet:old")?.account.id).toBe("old");
  expect(store.progress("replacement:wallet:old")).toMatchObject({ stage: "failed" });
});
it("does not treat opening the login page as a completed grant", async () => {
  sdk.mockResolvedValue({ status: "pending" });
  await adoptPendingLinkedInReplacements();
  expect(store.account("wallet:old")?.account.id).toBe("old");
  expect(store.progress("replacement:wallet:old")).toMatchObject({ stage: "awaiting_login" });
});
