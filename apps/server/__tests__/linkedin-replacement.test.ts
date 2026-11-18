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
    workspace: "alpha",
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
  expect(sdk).toHaveBeenCalledExactlyOnceWith("alpha", { kind: "connection", intentId: "intent" });
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
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await adoptPendingLinkedInReplacements();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("does not match"));
  warn.mockRestore();
  expect(store.account("wallet:old")?.account.id).toBe("old");
  expect(store.progress("replacement:wallet:old")).toMatchObject({
    stage: "failed",
    error: expect.stringContaining("does not match"),
  });
});
it("does not treat opening the login page as a completed grant", async () => {
  sdk.mockResolvedValue({ status: "pending" });
  await adoptPendingLinkedInReplacements();
  expect(store.account("wallet:old")?.account.id).toBe("old");
  expect(store.progress("replacement:wallet:old")).toMatchObject({ stage: "awaiting_login" });
});
/** The account being replaced, as one a member connected. A saved record keeps its first owner, so start over. */
function connectedByMia(removedAt?: string) {
  store.db.exec("DELETE FROM accounts");
  store.saveAccount({
    key: "wallet:old",
    wallet: "wallet",
    workspace: "alpha",
    account: { id: "old", member_urn: "owner", status: "revoked" } as never,
    sync: null,
    checkedAt: null,
    error: null,
    ownerMember: "mia@example.com",
    removedAt,
  });
}
it("keeps a connection it cannot merge with the member who opened the login", async () => {
  connectedByMia();
  const { pendingLinkedInReplacementWallets } = await import("../src/linkedin-replacement.ts");
  // Until the login settles, discovery leaves the wallet's new accounts alone.
  expect([...pendingLinkedInReplacementWallets()]).toEqual(["wallet"]);
  // A second account's login is ready in the same pass.
  store.saveAccount({
    key: "wallet:other",
    wallet: "wallet",
    workspace: "alpha",
    account: { id: "other", member_urn: "second", status: "revoked" } as never,
    sync: null,
    checkedAt: null,
    error: null,
  });
  store.saveProgress("replacement:wallet:other", {
    stage: "awaiting_login",
    oldAccountKey: "wallet:other",
    oldAccountId: "other",
    member: "second",
    intentId: "other-intent",
  });
  sdk.mockImplementation(async (_workspace, op: { intentId: string }) => ({
    status: "completed",
    account:
      op.intentId === "intent"
        ? { id: "new", member_urn: "different", status: "connected", allowed_actions: [] }
        : { id: "next", member_urn: "second", status: "connected", allowed_actions: [] },
  }));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // The first login cannot be adopted; the pass goes on to the next one.
  await adoptPendingLinkedInReplacements();
  warn.mockRestore();
  expect(store.progress("replacement:wallet:old")).toMatchObject({ stage: "failed" });
  expect(store.account("wallet:other")?.account.id).toBe("next");
  expect(store.progress("replacement:wallet:other")).toMatchObject({ stage: "complete" });
  expect(store.account("wallet:old")?.account.id).toBe("old");
  // The other LinkedIn member Mia signed in as is an account of its own, and hers.
  expect(store.account("wallet:new")).toMatchObject({
    ownerMember: "mia@example.com",
    account: { id: "new", member_urn: "different" },
  });
  expect(pendingLinkedInReplacementWallets().size).toBe(0);
});
it("settles a login finished after its account was removed, and keeps the member", async () => {
  connectedByMia("2026-11-01T00:00:00Z");
  await adoptPendingLinkedInReplacements();
  expect(store.account("wallet:old")).toMatchObject({ account: { id: "old" } });
  expect(store.account("wallet:new")).toMatchObject({
    ownerMember: "mia@example.com",
    account: { id: "new" },
  });
  expect(store.progress("replacement:wallet:old")).toMatchObject({ stage: "failed" });
  await adoptPendingLinkedInReplacements();
  expect(sdk).toHaveBeenCalledTimes(1);
});
it("retries an account whose login could not be checked, and still adopts the others", async () => {
  store.saveAccount({
    key: "wallet:other",
    wallet: "wallet",
    workspace: "alpha",
    account: { id: "other", member_urn: "second", status: "revoked" } as never,
    sync: null,
    checkedAt: null,
    error: null,
  });
  store.saveProgress("replacement:wallet:other", {
    stage: "awaiting_login",
    oldAccountKey: "wallet:other",
    oldAccountId: "other",
    member: "second",
    intentId: "other-intent",
  });
  const connected = { status: "connected", allowed_actions: ["read", "reply", "view_profile"] };
  const poll = (intentId: string, unreachable: boolean) =>
    intentId === "intent"
      ? unreachable
        ? Promise.reject(new Error("worker timeout"))
        : { status: "completed", account: { id: "new", member_urn: "owner", ...connected } }
      : { status: "completed", account: { id: "next", member_urn: "second", ...connected } };
  sdk.mockImplementation(async (_workspace, op: { intentId: string }) => poll(op.intentId, true));
  await adoptPendingLinkedInReplacements();
  expect(store.account("wallet:other")?.account.id).toBe("next");
  expect(store.progress("replacement:wallet:other")).toMatchObject({ stage: "complete" });
  // The one that could not be checked is as it was, for the next pass.
  expect(store.account("wallet:old")?.account.id).toBe("old");
  const waiting = store.progress<Record<string, unknown>>("replacement:wallet:old");
  expect(waiting).toMatchObject({ stage: "awaiting_login", intentId: "intent" });
  expect(waiting?.error).toBeUndefined();
  sdk.mockImplementation(async (_workspace, op: { intentId: string }) => poll(op.intentId, false));
  await adoptPendingLinkedInReplacements();
  expect(store.account("wallet:old")?.account.id).toBe("new");
});
it("waits for the new connection's unfinished provider work, then merges", async () => {
  connectedByMia();
  // A busy capture leaves the new connection with Mia as an account of its own.
  const token = getReplyReviewStore().claim("capture:wallet:old")!;
  await adoptPendingLinkedInReplacements();
  getReplyReviewStore().release("capture:wallet:old", token);
  // She imports its history; the provider has accepted a run and not finished it.
  const job = { accountKey: "wallet:new", stage: "waiting", counts: {}, failures: [] };
  store.saveProgress("backfill:wallet:new", {
    ...job,
    pending: { kind: "sync", idempotencyKey: "key", requestId: "request" },
  });
  await adoptPendingLinkedInReplacements();
  expect(store.account("wallet:old")?.account.id).toBe("old");
  expect(store.account("wallet:new")).toMatchObject({ ownerMember: "mia@example.com" });
  expect(store.progress("replacement:wallet:old")).toMatchObject({
    stage: "awaiting_login",
    error: expect.stringContaining("history import"),
  });
  // The run finishes, and the pass after it merges the two.
  store.saveProgress("backfill:wallet:new", { ...job, stage: "capture" });
  await adoptPendingLinkedInReplacements();
  expect(store.account("wallet:old")).toMatchObject({
    ownerMember: "mia@example.com",
    account: { id: "new" },
  });
  expect(store.account("wallet:new")).toBeNull();
  const merged = store.progress<Record<string, unknown>>("replacement:wallet:old");
  expect(merged).toMatchObject({ stage: "complete", newAccountId: "new" });
  expect(merged?.error).toBeUndefined();
});
it("leaves a connection saved for another member unmerged and the login open", async () => {
  connectedByMia();
  store.saveAccount({
    key: "wallet:new",
    wallet: "wallet",
    workspace: "alpha",
    account: { id: "new", member_urn: "owner", status: "connected" } as never,
    sync: null,
    checkedAt: null,
    error: null,
    ownerMember: "bob@example.com",
  });
  store.saveConversation(
    "wallet:new",
    { id: "chat", provider_chat_id: "chat", attendees: [], updated_at: "2026-01-01" } as never,
    [],
    "new",
  );
  store.saveMessages("wallet:new", [
    { id: "m", conversation_id: "chat", provider_message_id: "m", text: "Bob's" } as never,
  ]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await adoptPendingLinkedInReplacements();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("different owners"));
  expect(store.account("wallet:old")).toMatchObject({
    ownerMember: "mia@example.com",
    account: { id: "old" },
  });
  expect(store.threads("wallet:old")).toHaveLength(0);
  expect(store.account("wallet:new")).toMatchObject({ ownerMember: "bob@example.com" });
  expect(store.threads("wallet:new")).toHaveLength(1);
  expect(store.allMessages("wallet:new")).toHaveLength(1);
  expect(store.progress("replacement:wallet:old")).toMatchObject({
    stage: "awaiting_login",
    intentId: "intent",
    error: expect.stringContaining("do not belong to this account's owner"),
  });
  // Still open: the next pass checks the login again.
  await adoptPendingLinkedInReplacements();
  warn.mockRestore();
  expect(sdk).toHaveBeenCalledTimes(2);
});
/** A force reconnect that stores a newer intent while this pass waits on the poll. */
const newerIntent = {
  stage: "awaiting_login",
  oldAccountKey: "wallet:old",
  oldAccountId: "old",
  member: "owner",
  pauseBackfill: true,
  intentId: "newer",
  expiresAt: "2026-12-01T00:00:00Z",
};
it.each([
  [
    "completes",
    {
      status: "completed",
      account: { id: "new", member_urn: "owner", status: "connected", allowed_actions: [] },
    },
  ],
  ["fails", { status: "failed", failure_reason: "expired" }],
])("leaves a newer intent's record alone when the superseded login %s", async (_, outcome) => {
  connectedByMia();
  sdk.mockImplementation(async () => {
    store.saveProgress("replacement:wallet:old", newerIntent);
    return outcome;
  });
  await adoptPendingLinkedInReplacements();
  expect(store.progress("replacement:wallet:old")).toEqual(newerIntent);
  expect(store.account("wallet:old")).toMatchObject({ account: { id: "old" } });
  expect(store.account("wallet:old")?.previousAccountIds).toBeUndefined();
  if ("account" in outcome)
    // The superseded login's connection stays Mia's own account, not merged.
    expect(store.account("wallet:new")).toMatchObject({
      ownerMember: "mia@example.com",
      account: { id: "new" },
    });
  else expect(store.account("wallet:new")).toBeNull();
});
it("does not undo a resumed import when a slow poll returns after another pass completed the login", async () => {
  store.saveProgress("replacement:wallet:old", {
    stage: "awaiting_login",
    oldAccountKey: "wallet:old",
    oldAccountId: "old",
    member: "owner",
    intentId: "intent",
    pauseBackfill: true,
  });
  const resumed = {
    accountKey: "wallet:old",
    stage: "waiting",
    pending: { kind: "sync", idempotencyKey: "key", requestId: "request" },
  };
  const connected = {
    id: "new",
    member_urn: "owner",
    status: "connected",
    allowed_actions: ["read", "reply", "view_profile"],
  };
  sdk.mockImplementation(async () => {
    // While this poll waits, another pass adopts the same login and the member resumes the import.
    store.replaceAccount("wallet:old", connected as never, []);
    store.saveProgress("replacement:wallet:old", {
      stage: "complete",
      oldAccountKey: "wallet:old",
      oldAccountId: "old",
      member: "owner",
      intentId: "intent",
      pauseBackfill: true,
      newAccountId: "new",
    });
    store.saveProgress("backfill:wallet:old", resumed);
    return { status: "completed", account: connected };
  });
  await adoptPendingLinkedInReplacements();
  expect(store.progress("backfill:wallet:old")).toEqual(resumed);
  expect(store.progress("replacement:wallet:old")).toMatchObject({ stage: "complete" });
});
it("lets discovery go on for the wallet's other accounts once the open login's account is known", async () => {
  const { pendingLinkedInReplacementWallets } = await import("../src/linkedin-replacement.ts");
  connectedByMia();
  store.saveAccount({
    key: "wallet:new",
    wallet: "wallet",
    workspace: "alpha",
    account: { id: "new", member_urn: "owner", status: "connected" } as never,
    sync: null,
    checkedAt: null,
    error: null,
    ownerMember: "bob@example.com",
  });
  expect([...pendingLinkedInReplacementWallets()]).toEqual(["wallet"]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await adoptPendingLinkedInReplacements();
  warn.mockRestore();
  // Still open, and its account is on record, so the wallet is no longer held back.
  expect(store.progress("replacement:wallet:old")).toMatchObject({
    stage: "awaiting_login",
    newAccountId: "new",
  });
  expect(pendingLinkedInReplacementWallets().size).toBe(0);
});
