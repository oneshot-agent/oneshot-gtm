import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  linkedInMatches: () => [
    {
      workspace: "test",
      prospectId: 1,
      profile: "linkedin.com/in/ada",
      name: "Ada",
      home: "unused",
    },
  ],
  currentWorkspaceName: () => "test",
}));
const { getLinkedInInboxStore } = await import("@oneshot-gtm/core");
const { linkedInThreads, threadContextVersion } = await import("../src/api/replies-view.ts");
const store = getLinkedInInboxStore();
beforeEach(() => {
  store.db.exec(
    "DELETE FROM accounts; DELETE FROM conversations; DELETE FROM messages; DELETE FROM identities;",
  );
  store.saveAccount({
    key: "account",
    wallet: "wallet",
    workspace: "test",
    account: { id: "id", status: "connected", allowed_actions: ["read", "reply"] } as never,
    sync: null,
    checkedAt: null,
    error: null,
  });
  store.saveIdentity("account", {
    providerId: "internal",
    profile: "linkedin.com/in/ada",
    name: "Ada",
    resolvedAt: "2026-01-01",
  });
  store.saveMessages("account", [
    {
      id: "reply",
      conversation_id: "chat",
      direction: "inbound",
      sender_provider_id: "internal",
      sender_name: "Ada",
      text: "Tell me more",
      sent_at: "2020-01-01",
      attachments: [],
    },
  ] as never);
});
it.each([
  { attendees: [], attendees_synced: false, type: 0, expected: false },
  {
    attendees: [
      { is_self: false, provider_id: "internal", profile_url: "https://linkedin.com/in/ada" },
    ],
    attendees_synced: true,
    type: 1,
    expected: false,
  },
  {
    attendees: [
      { is_self: false, provider_id: "internal", profile_url: "https://linkedin.com/in/ada" },
    ],
    attendees_synced: true,
    type: 0,
    expected: true,
  },
])("keeps sender resolution separate from generation eligibility: %j", ({ expected, ...c }) => {
  store.saveConversation("account", { id: "chat", ...c } as never, []);
  store.assign("linkedin:account:chat", { workspace: "test", prospectId: 1 });
  expect(linkedInThreads()[0]).toMatchObject({
    name: "Ada",
    profileUrl: "https://linkedin.com/in/ada",
    canGenerate: expected,
    matchStatus: "matched",
  });
});

it("distinguishes a restored account from a conversation still tied to the previous connection", () => {
  const a = store.account("account")!;
  store.saveAccount({
    ...a,
    account: { ...a.account, id: "replacement", status: "connected" },
    previousAccountIds: ["id"],
  });
  const conversation = {
    id: "chat",
    attendees: [
      { is_self: false, provider_id: "internal", profile_url: "https://linkedin.com/in/ada" },
    ],
    attendees_synced: true,
    type: 0,
  };
  store.saveConversation("account", conversation as never, [], "id");
  expect(linkedInThreads()[0]).toMatchObject({
    canSend: false,
    linkedinConnectionState: "restoring",
    unavailableReason: expect.stringContaining("LinkedIn is connected"),
  });
  store.saveConversation("account", conversation as never, [], "replacement");
  expect(linkedInThreads()[0]).toMatchObject({
    canSend: true,
    linkedinConnectionState: "connected",
  });
});

it("drafts an unassigned one-to-one conversation as this workspace, with a warning", () => {
  store.saveConversation(
    "account",
    {
      id: "chat",
      attendees: [
        { is_self: false, provider_id: "internal", profile_url: "https://linkedin.com/in/ada" },
      ],
      attendees_synced: true,
      type: 0,
    } as never,
    [],
  );
  const [unassigned] = linkedInThreads();
  expect(unassigned).toMatchObject({ canGenerate: true, canSend: true, workspace: null });
  expect(unassigned?.unavailableReason).toBeUndefined();
  expect(unassigned?.draftingWarning).toContain("the test workspace's product");

  store.assign("linkedin:account:chat", { workspace: "test", prospectId: 1 });
  expect(linkedInThreads()[0]?.draftingWarning).toBeUndefined();
});

it("shows no drafting warning on an unassigned conversation that cannot be drafted", () => {
  store.saveConversation(
    "account",
    { id: "chat", attendees: [], attendees_synced: false, type: 1 } as never,
    [],
  );
  const [group] = linkedInThreads();
  expect(group).toMatchObject({ canGenerate: false });
  expect(group?.draftingWarning).toBeUndefined();
});

it("versions an unassigned conversation's drafts per workspace, an assigned one's once", () => {
  store.saveConversation(
    "account",
    {
      id: "chat",
      attendees: [
        { is_self: false, provider_id: "internal", profile_url: "https://linkedin.com/in/ada" },
      ],
      attendees_synced: true,
      type: 0,
    } as never,
    [],
  );
  const [unassigned] = linkedInThreads();
  expect(threadContextVersion(unassigned!, "gtm")).not.toBe(
    threadContextVersion(unassigned!, "sdk"),
  );

  store.assign("linkedin:account:chat", { workspace: "test", prospectId: 1 });
  const [assigned] = linkedInThreads();
  expect(threadContextVersion(assigned!, "gtm")).toBe(threadContextVersion(assigned!, "sdk"));
});
