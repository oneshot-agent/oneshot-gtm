import { expect, it, vi } from "vitest";

const { tool, recordReceipt, connect, reconnect, account, revoke } = vi.hoisted(() => ({
  account: vi.fn(),
  revoke: vi.fn(),
  tool: vi.fn(),
  recordReceipt: vi.fn(),
  connect: vi.fn(),
  reconnect: vi.fn(),
}));
vi.mock("../src/oneshot.ts", () => ({
  getAgent: async () => ({
    tool,
    linkedinConnect: connect,
    reconnectLinkedInAccount: reconnect,
    getLinkedInAccount: account,
    revokeLinkedInAccount: revoke,
  }),
  buildAuditOpts: () => ({}),
}));
vi.mock("../src/demo.ts", () => ({ demoMode: () => false }));
vi.mock("../src/ledger.ts", () => ({ getLedger: () => ({ recordReceipt }) }));
const { linkedInSdk } = await import("../src/linkedin-sdk.ts");

it("submits a bounded history import without the rejected SDK timeout field and records acceptance", async () => {
  const accepted = { status: "pending", request_id: "history-job", cost: 0.01 };
  tool.mockImplementation(async (name, body) => {
    expect(name).toBe("linkedin/sync");
    expect(body).toEqual({ account_id: "account", mode: "continue", max_pages: 10, wait: false });
    if ("timeout" in body) throw new Error("Unrecognized key: timeout");
    return accepted;
  });
  expect(await linkedInSdk({ kind: "sync", accountId: "account" })).toEqual(accepted);
  expect(recordReceipt).toHaveBeenCalledWith(
    expect.objectContaining({
      callType: "linkedin.sync",
      oneshotRequestId: "history-job",
      signedReceipt: accepted,
    }),
  );
});

it("requests additional permissions with a new hosted intent", async () => {
  await linkedInSdk({ kind: "connect", accountId: "account", upgrade: true });
  expect(connect).toHaveBeenCalledWith({ requestedActions: ["read", "reply", "view_profile"] });
  expect(reconnect).not.toHaveBeenCalled();
});
it("resolves profiles silently with a persisted idempotency key and no unsupported timeout", async () => {
  tool.mockResolvedValueOnce({ status: "pending", request_id: "lookup" });
  await linkedInSdk({
    kind: "profile",
    accountId: "account",
    identifier: "internal",
    idempotencyKey: "stable",
  });
  expect(tool).toHaveBeenLastCalledWith("linkedin/profile-view", {
    account_id: "account",
    identifier: "internal",
    notify: false,
    wait: false,
    idempotencyKey: "stable",
  });
});

it("requests read, reply, and profile access on the very first login", async () => {
  connect.mockClear();
  await linkedInSdk({ kind: "connect" });
  expect(connect).toHaveBeenCalledExactlyOnceWith({
    requestedActions: ["read", "reply", "view_profile"],
  });
});

it("sends replies through the SDK transport without the rejected timeout field", async () => {
  account.mockResolvedValue({ status: "connected", allowed_actions: ["reply"] });
  const accepted = { status: "processing", request_id: "reply-job" };
  tool.mockImplementationOnce(async (name, body) => {
    expect(name).toBe("linkedin/reply");
    expect(body).toEqual({
      account_id: "account",
      conversation_id: "conversation",
      text: "Hello",
      idempotencyKey: "stable-send",
      wait: false,
    });
    return accepted;
  });
  expect(
    await linkedInSdk({
      kind: "reply",
      accountId: "account",
      conversationId: "conversation",
      text: "Hello",
      idempotencyKey: "stable-send",
    }),
  ).toEqual(accepted);
  expect(recordReceipt).toHaveBeenLastCalledWith(
    expect.objectContaining({ callType: "linkedin.reply", oneshotRequestId: "reply-job" }),
  );
});

it("rejects unauthorized replies before submitting a send", async () => {
  tool.mockClear();
  account.mockResolvedValue({ status: "connected", allowed_actions: ["read"] });
  await expect(
    linkedInSdk({
      kind: "reply",
      accountId: "account",
      conversationId: "conversation",
      text: "Hello",
      idempotencyKey: "stable-send",
    }),
  ).rejects.toThrow("permission to reply");
  expect(tool).not.toHaveBeenCalled();
});

it("revokes a connection through the SDK without deleting local messages or invoking paid tools", async () => {
  const calls = tool.mock.calls.length;
  revoke.mockResolvedValueOnce({ status: "revoked", upstream_deleted: true });
  expect(await linkedInSdk({ kind: "revoke", accountId: "account" })).toMatchObject({
    status: "revoked",
  });
  expect(revoke).toHaveBeenCalledWith("account");
  expect(tool.mock.calls).toHaveLength(calls);
});
