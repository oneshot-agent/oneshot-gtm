import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLedger } from "@oneshot-gtm/core";

// The warm LinkedIn connect routes (#791) over a real ledger in the isolated
// test home. The LinkedIn client and the model are stubs; nothing leaves.

const linkedInCalls: Array<Record<string, unknown>> = [];
let account: { workspace: string; accountId: string; canInvite: boolean } | null = {
  workspace: "gtm",
  accountId: "acct-1",
  canInvite: true,
};
let note = "We traded emails last week. Connecting so the next hello isn't cold.";

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return { ...actual, linkedInOutreachAccount: () => account };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return { ...actual, complete: async () => ({ content: note }) };
});
vi.mock("../src/linkedin-client.ts", () => ({
  callLinkedIn: async (_workspace: string, op: Record<string, unknown>) => {
    linkedInCalls.push(op);
    if (op["kind"] === "account") return {};
    return { invitation_id: "inv-1", status: "sent" };
  },
}));

const { linkedInFriendRoute, linkedInFriendDraftRoute, linkedInFriendSendRoute } =
  await import("../src/api/linkedin-friend.ts");

const post = (path: string, body: unknown): Request =>
  new Request(`http://127.0.0.1:3030${path}`, {
    method: "POST",
    headers: { host: "127.0.0.1:3030", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = (path: string): Request =>
  new Request(`http://127.0.0.1:3030${path}`, { headers: { host: "127.0.0.1:3030" } });

let n = 0;
function replier(labels: Array<string | null>, review = false): number {
  const k = ++n;
  const ledger = getLedger();
  const id = ledger.upsertProspect({
    name: `${["Dana", "Eli", "Fay", "Gus"][k % 4]!} Lee`,
    email: `route${k}@example.test`,
    company: "Acme",
    linkedin_url: `https://www.linkedin.com/in/route-person-${k}`,
    source: "test",
  });
  for (const [i, label] of labels.entries()) {
    const mid = `route-${k}-${i}`;
    ledger.recordInboxReply({
      id: mid,
      threadKey: `t-${mid}`,
      prospectId: id,
      fromEmail: `route${k}@example.test`,
      subject: "Re: hello",
      body: "Happy to chat.",
      receivedAt: new Date().toISOString(),
      kind: "human",
    });
    if (label !== null) {
      ledger.setInboxReplyIntent(mid, label, "test", {
        confidence: review ? 0.4 : 0.95,
        review,
      });
    }
  }
  return id;
}
const idParam = (id: number) => ({ id: String(id) });

beforeEach(() => {
  linkedInCalls.length = 0;
  account = { workspace: "gtm", accountId: "acct-1", canInvite: true };
  note = "We traded emails last week. Connecting so the next hello isn't cold.";
});

describe("GET /api/prospects/:id/linkedin-friend", () => {
  it("offers the action on a qualifying thread only", async () => {
    const yes = replier(["interested"]);
    const flagged = replier(["interested"], true);
    const untriaged = replier([null]);
    const vetoed = replier(["interested", "not_interested"]);
    const none = replier([]);
    const offered = async (id: number) =>
      ((await linkedInFriendRoute(get("/x"), idParam(id)).json()) as { canConnect: boolean })
        .canConnect;
    expect(await offered(yes)).toBe(true);
    for (const id of [flagged, untriaged, vetoed, none]) expect(await offered(id)).toBe(false);
  });

  it("doesn't offer it without a connected LinkedIn account", async () => {
    account = null;
    const body = (await linkedInFriendRoute(get("/x"), idParam(replier(["meeting"]))).json()) as {
      canConnect: boolean;
    };
    expect(body.canConnect).toBe(false);
  });

  it("rejects a bad id", () => {
    expect(linkedInFriendRoute(get("/x"), { id: "abc" }).status).toBe(400);
  });

  it("doesn't offer it when the account lacks the invite grant", async () => {
    account = { workspace: "gtm", accountId: "acct-1", canInvite: false };
    const body = (await linkedInFriendRoute(get("/x"), idParam(replier(["meeting"]))).json()) as {
      canConnect: boolean;
      reason: string;
    };
    expect(body.canConnect).toBe(false);
    expect(body.reason).toBe("allow connection requests on Replies");
    const sent = await linkedInFriendSendRoute(
      post("/s", { note: "hi" }),
      idParam(replier(["meeting"])),
    );
    expect(sent.status).toBe(409);
    expect(((await sent.json()) as { error: string }).error).toBe(
      "allow connection requests on Replies",
    );
    expect(linkedInCalls).toHaveLength(0);
  });
});

describe("draft and send", () => {
  it("drafts a note without sending anything", async () => {
    const id = replier(["question"]);
    const res = await linkedInFriendDraftRoute(post("/d", {}), idParam(id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { note: string; flags: string[]; maxChars: number };
    expect(body.note).toBe(note);
    expect(body.maxChars).toBe(300);
    expect(linkedInCalls).toEqual([]);
    expect(getLedger().listLinkedInInviteEvents(id, "linkedin:friend")).toEqual([]);
  });

  it("refuses to draft for a thread that doesn't qualify", async () => {
    const res = await linkedInFriendDraftRoute(
      post("/d", {}),
      idParam(replier(["interested", "complaint"])),
    );
    expect(res.status).toBe(409);
  });

  it("never sends without a note: preview and edit come first", async () => {
    const id = replier(["meeting"]);
    for (const body of [{}, { note: "" }, { note: "   " }, { note: 5 }]) {
      const res = await linkedInFriendSendRoute(post("/s", body), idParam(id));
      expect(res.status).toBe(400);
    }
    expect(linkedInCalls.filter((c) => c["kind"] === "invite")).toEqual([]);
  });

  it("sends exactly the edited note, then shows the invite's state and offers no second one", async () => {
    const id = replier(["partnership"]);
    const edited = "Edited by hand: we traded emails, connecting so the next hello isn't cold.";
    const res = await linkedInFriendSendRoute(post("/s", { note: edited }), idParam(id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, invitationId: "inv-1", status: "sent" });
    const invite = linkedInCalls.find((c) => c["kind"] === "invite");
    expect(invite).toMatchObject({ note: edited, playName: "linkedin:friend" });

    const after = (await linkedInFriendRoute(get("/x"), idParam(id)).json()) as {
      canConnect: boolean;
      invite: { state: string } | null;
    };
    expect(after.canConnect).toBe(false);
    expect(after.invite?.state).toBe("sent");

    const again = await linkedInFriendSendRoute(post("/s", { note: edited }), idParam(id));
    expect(again.status).toBe(409);
    expect(linkedInCalls.filter((c) => c["kind"] === "invite")).toHaveLength(1);
  });

  it("refuses a send to someone with a veto label, and a note over 300 characters", async () => {
    const vetoed = await linkedInFriendSendRoute(
      post("/s", { note: "hi" }),
      idParam(replier(["interested", "unsubscribe"])),
    );
    expect(vetoed.status).toBe(409);
    const long = await linkedInFriendSendRoute(
      post("/s", { note: "x".repeat(301) }),
      idParam(replier(["interested"])),
    );
    expect(long.status).toBe(409);
    expect(linkedInCalls.filter((c) => c["kind"] === "invite")).toEqual([]);
  });

  it("refuses a foreign origin and a send with no account", async () => {
    const id = replier(["interested"]);
    const foreign = new Request("http://127.0.0.1:3030/s", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3030",
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ note: "hi" }),
    });
    expect((await linkedInFriendSendRoute(foreign, idParam(id))).status).toBe(403);
    account = null;
    expect((await linkedInFriendSendRoute(post("/s", { note: "hi" }), idParam(id))).status).toBe(
      409,
    );
  });
});
