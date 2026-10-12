import { expect, it, vi } from "vitest";

const {
  tool,
  recordReceipt,
  connect,
  reconnect,
  account,
  revoke,
  message,
  invitation,
  invitations,
} = vi.hoisted(() => ({
  account: vi.fn(),
  revoke: vi.fn(),
  tool: vi.fn(),
  recordReceipt: vi.fn(),
  connect: vi.fn(),
  reconnect: vi.fn(),
  message: vi.fn(),
  invitation: vi.fn(),
  invitations: vi.fn(),
}));
vi.mock("../src/oneshot.ts", () => ({
  getAgent: async () => ({
    tool,
    linkedinConnect: connect,
    reconnectLinkedInAccount: reconnect,
    getLinkedInAccount: account,
    revokeLinkedInAccount: revoke,
    linkedinMessage: message,
    linkedinInvitation: invitation,
    linkedinInvitations: invitations,
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

it("adds permissions by reconnecting the same account with the full grant, never a second connection", async () => {
  await linkedInSdk({ kind: "connect", accountId: "account", upgrade: true });
  expect(reconnect).toHaveBeenLastCalledWith("account", {
    requestedActions: ["read", "reply", "view_profile", "invite"],
  });
  // A plain reconnect leaves the grant as it is.
  await linkedInSdk({ kind: "connect", accountId: "account" });
  expect(reconnect).toHaveBeenLastCalledWith("account", {});
  expect(connect).not.toHaveBeenCalled();
  // Only a first connection opens a new one.
  await linkedInSdk({ kind: "connect" });
  expect(connect).toHaveBeenCalledWith({
    requestedActions: ["read", "reply", "view_profile", "invite"],
  });
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

it("requests read, reply, profile and invite access on the very first login", async () => {
  connect.mockClear();
  await linkedInSdk({ kind: "connect" });
  expect(connect).toHaveBeenCalledExactlyOnceWith({
    requestedActions: ["read", "reply", "view_profile", "invite"],
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

it("opens a conversation with linkedinMessage, keyed for a safe retry", async () => {
  account.mockResolvedValue({ status: "connected", allowed_actions: ["reply"] });
  message.mockResolvedValueOnce({ status: "sent", conversation_id: "conv-1", cost: 0.02 });
  const result = await linkedInSdk({
    kind: "message",
    accountId: "account",
    profile: "https://www.linkedin.com/in/someone",
    text: "Hello",
    idempotencyKey: "stable-first",
    playName: "luma-events",
  });
  expect(result).toMatchObject({ conversation_id: "conv-1" });
  expect(message).toHaveBeenLastCalledWith({
    accountId: "account",
    profile: "https://www.linkedin.com/in/someone",
    text: "Hello",
    idempotencyKey: "stable-first",
  });
  expect(recordReceipt).toHaveBeenLastCalledWith(
    expect.objectContaining({ callType: "linkedin.message", playName: "luma-events" }),
  );
});

it("refuses a first message without the reply grant, a disconnected account, or bad text", async () => {
  message.mockClear();
  const base = {
    kind: "message" as const,
    accountId: "account",
    profile: "https://www.linkedin.com/in/someone",
    idempotencyKey: "k",
    playName: "luma-events",
  };
  account.mockResolvedValue({ status: "connected", allowed_actions: ["read"] });
  await expect(linkedInSdk({ ...base, text: "Hello" })).rejects.toThrow("permission to reply");
  account.mockResolvedValue({ status: "revoked", allowed_actions: ["reply"] });
  await expect(linkedInSdk({ ...base, text: "Hello" })).rejects.toThrow("permission to reply");
  account.mockResolvedValue({ status: "connected", allowed_actions: ["reply"] });
  await expect(linkedInSdk({ ...base, text: "   " })).rejects.toThrow("1–4000 characters");
  await expect(linkedInSdk({ ...base, text: "x".repeat(4001) })).rejects.toThrow(
    "1–4000 characters",
  );
  expect(message).not.toHaveBeenCalled();
});

it("reads one invitation's status through the SDK", async () => {
  invitation.mockResolvedValueOnce({ invitation_id: "inv", status: "accepted" });
  expect(
    await linkedInSdk({ kind: "invitation", accountId: "account", invitationId: "inv" }),
  ).toEqual({ invitation_id: "inv", status: "accepted" });
  expect(invitation).toHaveBeenLastCalledWith({ accountId: "account", invitationId: "inv" });
});

it("lists changed invitations, passing only the filters given", async () => {
  invitations.mockResolvedValue({ invitations: [] });
  await linkedInSdk({ kind: "invitations", accountId: "account" });
  expect(invitations).toHaveBeenLastCalledWith({ accountId: "account" });
  await linkedInSdk({
    kind: "invitations",
    accountId: "account",
    status: "pending",
    changedSince: "2026-10-01T00:00:00Z",
    limit: 100,
  });
  expect(invitations).toHaveBeenLastCalledWith({
    accountId: "account",
    status: "pending",
    changedSince: "2026-10-01T00:00:00Z",
    limit: 100,
  });
});
