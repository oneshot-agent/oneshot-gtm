import { beforeEach, expect, it, vi } from "vitest";
const sdk = vi.fn();
vi.mock("../src/linkedin-client.ts", () => ({
  callLinkedIn: (...args: unknown[]) => sdk(...args),
}));
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  linkedInMatches: () => [],
  currentWorkspaceName: () => "customer-workspace",
}));
const { getLinkedInInboxStore, getReplyReviewStore } = await import("@oneshot-gtm/core");
const { removeLinkedInAccount, forceReconnectLinkedInAccount } =
  await import("../src/linkedin-remove.ts");
const { adoptPendingLinkedInReplacements } = await import("../src/linkedin-replacement.ts");
const { startLinkedInBackfill, runLinkedInBackfill } = await import("../src/linkedin-backfill.ts");
const store = getLinkedInInboxStore();
beforeEach(() => {
  store.db.exec(
    "DELETE FROM accounts; DELETE FROM progress; DELETE FROM conversations; DELETE FROM messages;",
  );
  getReplyReviewStore().db.exec("DELETE FROM review_leases");
  store.saveAccount({
    key: "wallet:old",
    wallet: "wallet",
    workspace: "owner-workspace",
    account: {
      id: "old",
      member_urn: "member",
      status: "reconnect_required",
      allowed_actions: ["read", "reply"],
    } as never,
    sync: null,
    checkedAt: null,
    error: null,
  });
  store.saveConversation(
    "wallet:old",
    { id: "chat", attendees: [], attendees_synced: false } as never,
    [],
  );
  store.assign("linkedin:wallet:old:chat", { workspace: "customer-workspace", prospectId: 42 });
  store.saveMessages("wallet:old", [
    {
      id: "msg",
      conversation_id: "chat",
      text: "Keep this message",
      direction: "inbound",
      sent_at: "2026-09-01",
      attachments: [],
    },
  ] as never);
  store.saveProgress("backfill:wallet:old", {
    stage: "blocked",
    pending: { requestId: "old-request" },
  });
  sdk.mockReset().mockResolvedValue({ status: "revoked", upstream_deleted: true });
});
function historyPreserved() {
  expect(store.messages("wallet:old", "chat")[0]?.text).toBe("Keep this message");
  expect(store.threads("wallet:old")[0]?.owner).toMatchObject({
    workspace: "customer-workspace",
    prospectId: 42,
  });
}
it("removes access in the owner workspace, retains history, and prevents stale refresh resurrection", async () => {
  const stale = store.account("wallet:old")!;
  await removeLinkedInAccount("wallet:old");
  expect(sdk).toHaveBeenCalledExactlyOnceWith("owner-workspace", {
    kind: "revoke",
    accountId: "old",
  });
  historyPreserved();
  const { linkedInThreads } = await import("../src/api/replies-view.ts");
  expect(linkedInThreads()[0]).toMatchObject({
    canSend: false,
    canGenerate: false,
    messages: [expect.objectContaining({ body: "Keep this message" })],
  });
  store.saveAccount(stale);
  expect(store.account("wallet:old")).toMatchObject({
    removedAt: expect.any(String),
    account: { status: "revoked", allowed_actions: [] },
  });
  expect(() => startLinkedInBackfill("wallet:old")).toThrow("removed");
  await runLinkedInBackfill("wallet:old");
  expect(sdk).toHaveBeenCalledTimes(1);
});
it("keeps the connection visible when revocation fails", async () => {
  sdk.mockRejectedValueOnce(new Error("Service unavailable"));
  await expect(removeLinkedInAccount("wallet:old")).rejects.toThrow("Service unavailable");
  expect(store.account("wallet:old")?.removedAt).toBeUndefined();
  historyPreserved();
});
it("waits for active sync work and releases every acquired lease", async () => {
  const review = getReplyReviewStore();
  const token = review.claim("capture:wallet:old")!;
  await expect(removeLinkedInAccount("wallet:old")).rejects.toThrow("currently syncing");
  expect(sdk).not.toHaveBeenCalled();
  expect(review.claim("backfill:wallet:old")).toBeTruthy();
  review.release("capture:wallet:old", token);
});
it("reports incomplete provider cleanup without discarding history", async () => {
  sdk.mockResolvedValueOnce({ status: "revoked", upstream_deleted: false });
  expect(await removeLinkedInAccount("wallet:old")).toMatchObject({ upstreamDeleted: false });
  historyPreserved();
});
it("force reconnect persists a replacement and adopts the same member under the original message keys", async () => {
  sdk.mockResolvedValueOnce({ status: "revoked", upstream_deleted: true });
  sdk.mockResolvedValueOnce({
    intent_id: "new-intent",
    url: "https://example.test/login",
    expires_at: "2027-01-01",
  });
  expect(await forceReconnectLinkedInAccount("wallet:old")).toMatchObject({
    intent_id: "new-intent",
  });
  expect(store.account("wallet:old")?.removedAt).toBeUndefined();
  expect(store.progress("replacement:wallet:old")).toMatchObject({
    stage: "awaiting_login",
    intentId: "new-intent",
  });
  expect(JSON.stringify(store.progress("replacement:wallet:old"))).not.toContain(
    "https://example.test/login",
  );
  sdk.mockResolvedValueOnce({
    status: "completed",
    account: {
      id: "new",
      member_urn: "member",
      status: "connected",
      allowed_actions: ["read", "reply"],
    },
  });
  await adoptPendingLinkedInReplacements();
  expect(store.account("wallet:old")?.account.id).toBe("new");
  expect(store.progress("backfill:wallet:old")).toMatchObject({
    stage: "blocked",
    resumeStage: "capture",
  });
  expect(store.progress<{ pending?: unknown }>("backfill:wallet:old")?.pending).toBeUndefined();
  historyPreserved();
});
it("keeps history and a retryable state if a fresh login cannot be issued", async () => {
  sdk.mockResolvedValueOnce({ status: "revoked", upstream_deleted: true });
  sdk.mockRejectedValueOnce(new Error("Hosted connection service unavailable"));
  await expect(forceReconnectLinkedInAccount("wallet:old")).rejects.toThrow(
    "Your messages are saved",
  );
  expect(store.account("wallet:old")).toMatchObject({ account: { status: "revoked" } });
  expect(store.account("wallet:old")?.removedAt).toBeUndefined();
  historyPreserved();
});
it("does not open a new login before provider cleanup succeeds", async () => {
  sdk.mockResolvedValueOnce({ status: "revoked", upstream_deleted: false });
  await expect(forceReconnectLinkedInAccount("wallet:old")).rejects.toThrow(
    "disconnection is still pending",
  );
  expect(sdk).toHaveBeenCalledTimes(1);
  historyPreserved();
});

it("routes removal through the explicit action and keeps history readable", async () => {
  const { repliesLinkedInRoute } = await import("../src/api/replies.ts");
  const request = new Request("http://localhost/api/replies/linkedin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "remove", accountKey: "wallet:old" }),
  });
  const result = await repliesLinkedInRoute(request);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ ok: true });
  historyPreserved();
});

it("distinguishes a missing account from an unknown action without calling the provider", async () => {
  const { repliesLinkedInRoute } = await import("../src/api/replies.ts");
  for (const action of ["remove", "force-reconnect"]) {
    const response = await repliesLinkedInRoute(
      new Request("http://localhost/api/replies/linkedin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, accountKey: "missing" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "LinkedIn account not found. Refresh Replies and try again.",
    });
  }
  expect(sdk).not.toHaveBeenCalled();
});
