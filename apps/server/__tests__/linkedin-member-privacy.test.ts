import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepliesResult } from "@oneshot-gtm/shared-types";

// A LinkedIn account's threads are private to the member who connected it
// (#1040). Members share every workspace, so the only thing that separates
// them here is who the request acts as: the owner on the host machine, or
// the member `tailscale serve` signed in.

const sdk = vi.fn();
vi.mock("../src/linkedin-client.ts", () => ({
  callLinkedIn: (...args: unknown[]) => sdk(...args),
}));
vi.mock("../src/api/inbox.ts", () => ({
  listInboxRoute: async () => Response.json({ replies: [], conversations: [], hasMore: false }),
  draftReplyRoute: vi.fn(),
  saveDraftRoute: vi.fn(),
  steerRoute: vi.fn(),
  archiveInboxConversationRoute: vi.fn(),
  sendReplyRoute: vi.fn(),
}));
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  oneshotEnvReady: () => true,
  linkedInMatches: () => [],
  currentWorkspaceName: () => "default",
}));
const { getLinkedInInboxStore, getReplyReviewStore, getSharedDb } =
  await import("@oneshot-gtm/core");
const { collectReplies } = await import("../src/api/replies-view.ts");
const {
  replyAssignRoute,
  replyDraftSaveRoute,
  replyGenerateRoute,
  replySendRoute,
  replyStateRoute,
  repliesLinkedInRoute,
} = await import("../src/api/replies.ts");
const { refreshLinkedInInbox } = await import("../src/linkedin-sync.ts");

const TAILNET = "gtm-host.tail1234.ts.net";
const OWNER = "olive@example.com";
const MIA = "mia@example.com";
/** A request made on the host machine. */
const local = { host: "127.0.0.1:3030" };
/** What `tailscale serve` puts in front of the server for a signed-in member. */
const as = (login: string): Record<string, string> => ({
  host: `${TAILNET}:3030`,
  "x-forwarded-host": `${TAILNET}:3030`,
  "x-forwarded-for": "100.64.0.7",
  "tailscale-user-login": login,
  origin: `https://${TAILNET}:3030`,
});
const list = async (headers: Record<string, string>): Promise<RepliesResult> =>
  collectReplies(new Request("http://127.0.0.1:3030/api/replies", { headers }));
const post = (headers: Record<string, string>, body: unknown) =>
  new Request("http://127.0.0.1:3030/api/replies", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const store = getLinkedInInboxStore();
const review = getReplyReviewStore();
/** One connected account with one conversation holding one inbound message, matched to no prospect. */
function seedAccount(id: string, ownerMember?: string): string {
  const key = `wallet:${id}`;
  store.saveAccount({
    key,
    wallet: "wallet",
    workspace: "default",
    account: {
      id,
      display_name: `${id} account`,
      status: "connected",
      allowed_actions: ["read", "reply"],
    } as never,
    sync: null,
    checkedAt: null,
    error: `${id} provider detail`,
    ...(ownerMember ? { ownerMember } : {}),
  });
  store.saveConversation(
    key,
    {
      id: `${id}-chat`,
      attendees: [{ is_self: false, provider_id: `${id}-peer`, name: `${id} contact` }],
      attendees_synced: true,
      type: 0,
    } as never,
    [],
  );
  store.saveMessages(key, [
    {
      id: `${id}-message`,
      conversation_id: `${id}-chat`,
      direction: "inbound",
      sender_provider_id: `${id}-peer`,
      sender_name: `${id} contact`,
      text: `A private note on the ${id} account`,
      sent_at: "2026-11-01T10:00:00Z",
      attachments: [],
    },
  ] as never);
  return `linkedin:${key}:${id}-chat`;
}
function seedMembers(): void {
  const db = getSharedDb();
  db.addMember({ email: OWNER, name: "Olive Owner", role: "owner" });
  db.addMember({ email: MIA, name: "Mia Member", role: "member" });
  db.allowHost(TAILNET);
}

let oliveThread: string;
let miaThread: string;
let oldThread: string;
beforeEach(() => {
  store.db.exec(
    "DELETE FROM accounts;DELETE FROM conversations;DELETE FROM messages;DELETE FROM progress;DELETE FROM identities;",
  );
  review.db.exec("DELETE FROM review_threads;DELETE FROM review_sends;DELETE FROM review_leases");
  const db = getSharedDb();
  for (const m of db.listMembers()) db.removeMember(m.email);
  for (const host of db.allowedHosts()) db.disallowHost(host);
  sdk.mockReset();
  oliveThread = seedAccount("olive", OWNER);
  miaThread = seedAccount("mia", MIA);
  // Connected before members existed: no member recorded.
  oldThread = seedAccount("old");
});

describe("the Replies view", () => {
  it("shows a member only the threads on accounts they connected, unmatched ones included", async () => {
    seedMembers();
    const mia = await list(as(MIA));
    expect(mia.threads.map((t) => t.key)).toEqual([miaThread]);
    expect(mia.threads[0]).toMatchObject({ prospectId: null, matchStatus: "missing_identity" });
    expect(mia.threads[0]!.messages[0]!.body).toBe("A private note on the mia account");

    // Accounts nobody is recorded for are the install owner's.
    const olive = await list(as(OWNER));
    expect(olive.threads.map((t) => t.key).toSorted()).toEqual([oldThread, oliveThread].toSorted());
    expect(JSON.stringify(olive)).not.toContain("A private note on the mia account");
    expect(JSON.stringify(mia)).not.toContain("A private note on the olive account");
    expect(JSON.stringify(mia)).not.toContain("A private note on the old account");

    // On the host machine the request acts as the listed owner.
    const host = await list(local);
    expect(host.threads.map((t) => t.key).toSorted()).toEqual([oldThread, oliveThread].toSorted());
  });

  it("lists other members' accounts by name and status, without their import detail", async () => {
    seedMembers();
    const { accounts } = await list(as(MIA));
    expect(accounts.map((a) => a.key).toSorted()).toEqual([
      "wallet:mia",
      "wallet:old",
      "wallet:olive",
    ]);
    expect(accounts.find((a) => a.key === "wallet:mia")).toMatchObject({
      mine: true,
      ownerMember: MIA,
      error: "mia provider detail",
    });
    expect(accounts.find((a) => a.key === "wallet:olive")).toMatchObject({
      mine: false,
      ownerMember: OWNER,
      name: "olive account",
      status: "connected",
      error: null,
      backfill: null,
    });
    expect(accounts.find((a) => a.key === "wallet:old")).toMatchObject({
      mine: false,
      ownerMember: null,
    });
  });

  it("is unchanged on a single-user install: the host machine sees every account", async () => {
    // No member is listed, even though two accounts carry one from earlier.
    const host = await list(local);
    expect(host.threads.map((t) => t.key).toSorted()).toEqual(
      [miaThread, oldThread, oliveThread].toSorted(),
    );
    expect(host.accounts.every((a) => a.mine)).toBe(true);
    const archived = await replyStateRoute(
      post(local, { key: miaThread, action: "archive", observedReplyIds: ["mia-message"] }),
    );
    expect(archived.status).toBe(200);
    expect((await archived.json()).archivedAt).toEqual(expect.any(String));
  });

  it("never treats a signed-in member as the only user, even when the members list reads empty after them", async () => {
    seedMembers();
    // The last member is removed between the request's member lookup and the count.
    const db = getSharedDb();
    const count = vi.spyOn(db, "listMembers").mockReturnValue([]);
    try {
      const mia = await list(as(MIA));
      expect(mia.threads.map((t) => t.key)).toEqual([miaThread]);
      expect(JSON.stringify(mia)).not.toContain("A private note on the olive account");
    } finally {
      count.mockRestore();
    }
  });
});

describe("acting on a thread of another member's account", () => {
  beforeEach(async () => {
    seedMembers();
    // The owner has opened Replies, so their threads are in the shared review store.
    await list(as(OWNER));
    expect(review.get(oliveThread)).not.toBeNull();
  });

  it.each([
    ["reply", () => replySendRoute, { sendId: "1234567890123456", revision: 1 }],
    ["check a reply", () => replySendRoute, { check: true }],
    ["resolve", () => replyStateRoute, { action: "archive", observedReplyIds: ["olive-message"] }],
    ["assign", () => replyAssignRoute, { workspace: "default", prospectId: 1 }],
    ["draft", () => replyGenerateRoute, {}],
    ["save a draft", () => replyDraftSaveRoute, { drafts: {}, expectedRevision: null }],
  ] as const)("refuses to %s with 403", async (_name, route, body) => {
    for (const key of [oliveThread, oldThread]) {
      const refused = await route()(post(as(MIA), { key, ...body }));
      expect(refused.status).toBe(403);
      expect(JSON.stringify(await refused.json())).not.toContain("private note");
    }
    expect(sdk).not.toHaveBeenCalled();
    expect(review.get(oliveThread)).toMatchObject({ archivedAt: null, drafts: null, send: null });
    expect(store.thread(oliveThread)?.owner).toBeNull();
  });

  it("lets the member who connected the account act on the same thread", async () => {
    const archived = await replyStateRoute(
      post(as(OWNER), { key: oliveThread, action: "archive", observedReplyIds: ["olive-message"] }),
    );
    expect(archived.status).toBe(200);
    expect(review.get(oliveThread)?.archivedAt).toEqual(expect.any(String));
  });

  it("refuses account actions on another member's account with 403", async () => {
    for (const action of ["remove", "force-reconnect", "backfill", "backfill-status", "upgrade"]) {
      const refused = await repliesLinkedInRoute(
        post(as(MIA), { action, accountKey: "wallet:olive" }),
      );
      expect(refused.status).toBe(403);
    }
    expect(sdk).not.toHaveBeenCalled();
    expect(store.account("wallet:olive")?.removedAt).toBeUndefined();
  });
});

describe("background jobs", () => {
  it("sync every account whoever connected it, and record who connected a new one", async () => {
    seedMembers();
    const fresh = { id: "fresh", status: "connected", allowed_actions: ["read", "reply"] };
    const known = ["olive", "mia", "old"].map((id) => store.account(`wallet:${id}`)!.account);
    sdk.mockImplementation(async (_workspace, op) => {
      if (op.kind === "connect") return { intent_id: "intent-mia", url: "https://example.com/in" };
      if (op.kind === "connection") return { status: "completed", account: fresh };
      if (op.kind === "accounts") return { wallet: "wallet", accounts: [...known, fresh] };
      if (op.kind === "status") return { sync_state: "complete", coverage: { complete: true } };
      if (op.kind === "conversations") return { conversations: [], has_more: false };
      if (op.kind === "messages") return { messages: [], has_more: false };
      throw new Error(`Unexpected operation ${op.kind}`);
    });
    // Mia starts a connection from her own machine.
    const started = await repliesLinkedInRoute(post(as(MIA), { action: "connect" }));
    expect(started.status).toBe(200);

    // The sync runs with no request and no viewer.
    await refreshLinkedInInbox(true);
    const synced = sdk.mock.calls
      .filter(([, op]) => op.kind === "status")
      .map(([, op]) => op.accountId)
      .toSorted();
    expect(synced).toEqual(["fresh", "mia", "old", "olive"]);
    for (const id of ["olive", "mia", "old", "fresh"])
      expect(store.account(`wallet:${id}`)?.checkedAt).toEqual(expect.any(String));

    // Discovery and capture rewrite each record; the owners are as they were.
    expect(store.account("wallet:olive")?.ownerMember).toBe(OWNER);
    expect(store.account("wallet:mia")?.ownerMember).toBe(MIA);
    expect(store.account("wallet:old")?.ownerMember).toBeUndefined();
    expect(store.account("wallet:fresh")?.ownerMember).toBe(MIA);
    expect((await list(as(OWNER))).accounts.find((a) => a.key === "wallet:fresh")?.mine).toBe(
      false,
    );
  });

  it("keeps an account connected before members existed with the owner when a member signs in to it", async () => {
    seedMembers();
    const known = ["olive", "mia", "old"].map((id) => store.account(`wallet:${id}`)!.account);
    // The same LinkedIn account, as the provider returns it after Mia's sign-in.
    const again = { ...store.account("wallet:old")!.account, allowed_actions: ["read"] };
    // Discovery lists the account as it was: only the login's adoption carries the sign-in.
    sdk.mockImplementation(async (_workspace, op) => {
      if (op.kind === "connect") return { intent_id: "intent-old", url: "https://example.com/in" };
      if (op.kind === "connection") return { status: "completed", account: again };
      if (op.kind === "accounts") throw new Error("accounts unavailable");
      if (op.kind === "status") return { sync_state: "complete", coverage: { complete: true } };
      if (op.kind === "conversations") return { conversations: [], has_more: false };
      if (op.kind === "messages") return { messages: [], has_more: false };
      throw new Error(`Unexpected operation ${op.kind}`);
    });
    sdk.mockImplementationOnce(async () => ({ wallet: "wallet", accounts: known }));
    expect((await repliesLinkedInRoute(post(as(MIA), { action: "connect" }))).status).toBe(200);
    await refreshLinkedInInbox(true);

    // Sync settled Mia's login, and the sign-in was adopted onto the existing record,
    // which stays the owner's.
    expect(store.progress("connect:intent-old")).toMatchObject({ complete: true });
    expect(
      sdk.mock.calls.some(([, op]) => op.kind === "connection" && op.intentId === "intent-old"),
    ).toBe(true);
    expect(store.account("wallet:old")?.account.allowed_actions).toEqual(["read"]);
    expect(store.account("wallet:old")?.ownerMember).toBeUndefined();
    const mia = await list(as(MIA));
    expect(mia.threads.map((t) => t.key)).toEqual([miaThread]);
    expect(mia.accounts.find((a) => a.key === "wallet:old")).toMatchObject({ mine: false });
    expect(JSON.stringify(mia)).not.toContain("A private note on the old account");
    expect((await list(as(OWNER))).threads.map((t) => t.key)).toContain(oldThread);
  });
});

describe("a force reconnect whose new connection is adopted late", () => {
  const AFTER = "A private note after mia signed in again";
  const again = {
    id: "mia2",
    member_urn: "mia-urn",
    display_name: "mia account",
    status: "connected",
    allowed_actions: ["read", "reply"],
  };
  const againThread = "linkedin:wallet:mia2:mia2-chat";
  /** What the login answers when sync asks; a test moves it from pending to completed. */
  let login: unknown;
  beforeEach(async () => {
    seedMembers();
    const mia = store.account("wallet:mia")!;
    store.saveAccount({ ...mia, account: { ...mia.account, member_urn: "mia-urn" } as never });
    const known = ["olive", "old"].map((id) => store.account(`wallet:${id}`)!.account);
    login = { status: "completed", account: again };
    sdk.mockImplementation(async (_workspace, op) => {
      if (op.kind === "revoke") return { status: "revoked", upstream_deleted: true };
      if (op.kind === "connect")
        return { intent_id: "intent-again", url: "https://example.com/in", expires_at: "later" };
      if (op.kind === "connection") return login;
      // The provider lists the new connection as soon as the login is done.
      if (op.kind === "accounts") return { wallet: "wallet", accounts: [...known, again] };
      if (op.kind === "status") return { sync_state: "complete", coverage: { complete: true } };
      const mine = op.options?.accountId === "mia2";
      if (op.kind === "conversations")
        return {
          conversations:
            mine && !op.options.archived
              ? [
                  {
                    id: "mia2-chat",
                    attendees: [{ is_self: false, provider_id: "mia2-peer", name: "mia2 contact" }],
                    attendees_synced: true,
                    type: 0,
                  },
                ]
              : [],
          has_more: false,
        };
      if (op.kind === "messages")
        return {
          messages: mine
            ? [
                {
                  id: "mia2-message",
                  conversation_id: "mia2-chat",
                  direction: "inbound",
                  sender_provider_id: "mia2-peer",
                  sender_name: "mia2 contact",
                  text: AFTER,
                  sent_at: "2026-11-02T10:00:00Z",
                  attachments: [],
                },
              ]
            : [],
          has_more: false,
        };
      throw new Error(`Unexpected operation ${op.kind}`);
    });
    const started = await repliesLinkedInRoute(
      post(as(MIA), { action: "force-reconnect", accountKey: "wallet:mia" }),
    );
    expect(started.status).toBe(200);
  });
  /** Every way the owner could read the conversation: the list, on either machine, and each route. */
  async function refusedToOwner(key: string): Promise<void> {
    for (const headers of [as(OWNER), local]) {
      expect(JSON.stringify(await list(headers))).not.toContain(AFTER);
      for (const [route, body] of [
        [replyStateRoute, { action: "archive", observedReplyIds: ["mia2-message"] }],
        [replyGenerateRoute, {}],
        [replySendRoute, { check: true }],
        [replyAssignRoute, { workspace: "default", prospectId: 1 }],
      ] as const) {
        const refused = await route(post(headers, { key, ...body }));
        expect(refused.status).toBe(403);
        expect(JSON.stringify(await refused.json())).not.toContain(AFTER);
      }
    }
  }

  it("keeps the new connection's messages with the member while another server holds the capture, and after the merge", async () => {
    // Another server is capturing the account, so this one cannot merge yet.
    const lease = review.claim("capture:wallet:mia")!;
    await refreshLinkedInInbox(true);
    expect(store.account("wallet:mia")?.account.id).toBe("mia");
    expect(store.progress("replacement:wallet:mia")).toMatchObject({ stage: "awaiting_login" });
    // Discovery and capture went on: the new connection was recorded and its messages collected.
    expect(store.account("wallet:mia2")?.ownerMember).toBe(MIA);
    expect(store.allMessages("wallet:mia2").map((m) => m.text)).toEqual([AFTER]);

    const mia = await list(as(MIA));
    expect(mia.threads.map((t) => t.key).toSorted()).toEqual([againThread, miaThread].toSorted());
    expect(mia.accounts.find((a) => a.key === "wallet:mia2")).toMatchObject({ mine: true });
    // Mia opened Replies, so the conversation is in the shared review store.
    expect(review.get(againThread)?.messages[0]?.body).toBe(AFTER);
    await refusedToOwner(againThread);
    expect((await list(as(OWNER))).accounts.find((a) => a.key === "wallet:mia2")).toMatchObject({
      mine: false,
      ownerMember: MIA,
    });

    // The other server is done; the next sync merges the connection into Mia's account.
    review.release("capture:wallet:mia", lease);
    await refreshLinkedInInbox(true);
    expect(store.account("wallet:mia")).toMatchObject({
      ownerMember: MIA,
      account: { id: "mia2" },
    });
    expect(store.account("wallet:mia2")).toBeNull();
    expect(store.progress("replacement:wallet:mia")).toMatchObject({ stage: "complete" });
    // The review copy saved under the merged-away account outlives it, and is nobody's to read.
    expect(review.get(againThread)?.messages[0]?.body).toBe(AFTER);
    await refusedToOwner(againThread);
    // Mia reads the conversation on her account, where the merge put it.
    const merged = await list(as(MIA));
    expect(merged.threads.map((t) => t.key).toSorted()).toEqual(
      ["linkedin:wallet:mia:mia2-chat", miaThread].toSorted(),
    );
    expect(JSON.stringify(merged)).toContain(AFTER);
    await refusedToOwner("linkedin:wallet:mia:mia2-chat");
  });

  it("leaves a connection found before its login reads as finished to the adoption, never to the owner", async () => {
    // Sync asked about the login just before Mia finished it; the wallet already lists the result.
    login = { status: "pending" };
    await refreshLinkedInInbox(true);
    expect(store.account("wallet:mia2")).toBeNull();
    expect(sdk.mock.calls.some(([, op]) => op.options?.accountId === "mia2")).toBe(false);
    expect(JSON.stringify(await list(as(OWNER)))).not.toContain("mia2");

    login = { status: "completed", account: again };
    await refreshLinkedInInbox(true);
    expect(store.account("wallet:mia")).toMatchObject({
      ownerMember: MIA,
      account: { id: "mia2" },
    });
    expect(store.allMessages("wallet:mia").map((m) => m.text)).toContain(AFTER);
    expect(JSON.stringify(await list(as(OWNER)))).not.toContain(AFTER);
    expect(JSON.stringify(await list(as(MIA)))).toContain(AFTER);
  });

  it("keeps an account a login connected with the member even when the login ends unfinished", async () => {
    // The provider reports the login failed, yet the wallet already lists what it connected.
    login = { status: "failed", failure_reason: "checkpoint", account: again };
    await refreshLinkedInInbox(true);
    expect(store.progress("replacement:wallet:mia")).toMatchObject({ stage: "failed" });
    expect(store.account("wallet:mia2")).toMatchObject({ ownerMember: MIA });
    for (const headers of [as(OWNER), local]) {
      const owner = await list(headers);
      expect(owner.accounts.find((a) => a.key === "wallet:mia2")).toMatchObject({ mine: false });
      expect(JSON.stringify(owner)).not.toContain(AFTER);
    }
    expect(JSON.stringify(await list(as(MIA)))).toContain(AFTER);
  });
});
