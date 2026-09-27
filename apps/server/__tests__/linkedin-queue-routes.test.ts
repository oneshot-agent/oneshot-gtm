import { beforeEach, describe, expect, it, vi } from "vitest";

// The LinkedIn channel's per-row routes: send a reviewed note as an invite,
// withdraw a sent invite, and move an unsent row between channels.

interface FakeRow {
  id: number;
  play_name: string;
  channel: string;
  payload_json: string;
  status: string;
  prospect_id: number | null;
  notes: string | null;
  last_draft_json: string | null;
}

let row: FakeRow;
let seqEvents: Array<Record<string, unknown>> = [];
const recorded: Array<Record<string, unknown>> = [];
const statusCalls: Array<Record<string, unknown>> = [];
const channelCalls: Array<[number, string]> = [];
const linkedInCalls: Array<Record<string, unknown>> = [];
let linkedInResult: unknown = { invitation_id: "inv-1", status: "sent" };
let account: { workspace: string; accountId: string } | null = {
  workspace: "gtm",
  accountId: "acct-1",
};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    currentWorkspaceName: () => "gtm",
    isDraining: () => false,
    linkedInOutreachAccount: () => account,
    getLedger: () => ({
      getQueueRow: () => ({ ...row }),
      claimQueueSendingMarker: () => true,
      clearQueueSendingMarker: () => {},
      upsertProspect: () => 42,
      recordSequenceEvent: (input: Record<string, unknown>) => {
        recorded.push(input);
        return 1;
      },
      setQueueProspectId: () => {},
      setQueueStatus: (input: Record<string, unknown>) => {
        statusCalls.push(input);
      },
      closeQueueDraftVersion: () => true,
      listSequenceEventsForProspectPlay: () => seqEvents,
      setQueueChannel: (id: number, channel: string) => {
        channelCalls.push([id, channel]);
        return row.status !== "sent";
      },
    }),
  };
});
vi.mock("../src/linkedin-client.ts", () => ({
  callLinkedIn: async (_workspace: string, op: Record<string, unknown>) => {
    linkedInCalls.push(op);
    if (linkedInResult instanceof Error) throw linkedInResult;
    return linkedInResult;
  },
}));

const { sendDraftRoute, withdrawInviteRoute, setQueueChannelRoute } =
  await import("../src/api/queue.ts");

const post = (body?: unknown) =>
  new Request("http://localhost/api/queue/1/x", {
    method: "POST",
    ...(body
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
      : {}),
  });

beforeEach(() => {
  row = {
    id: 1,
    play_name: "luma-events",
    channel: "linkedin",
    payload_json: JSON.stringify({
      name: "Dana Lee",
      linkedinUrl: "https://www.linkedin.com/in/dana-lee",
      email: "dana@acme.com",
    }),
    status: "approved",
    prospect_id: null,
    notes: null,
    last_draft_json: JSON.stringify({
      subject: "LinkedIn invite → Dana Lee",
      body: "reviewed",
      flags: [],
    }),
  };
  seqEvents = [];
  recorded.length = 0;
  statusCalls.length = 0;
  channelCalls.length = 0;
  linkedInCalls.length = 0;
  linkedInResult = { invitation_id: "inv-1", status: "sent" };
  account = { workspace: "gtm", accountId: "acct-1" };
});

describe("send-draft on a LinkedIn row", () => {
  it("sends the reviewed note as an invite and marks the row sent", async () => {
    const res = await sendDraftRoute(post(), { id: "1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, invitationId: "inv-1", status: "sent" });
    expect(linkedInCalls[0]).toMatchObject({
      kind: "invite",
      accountId: "acct-1",
      note: "reviewed",
    });
    expect(recorded[0]).toMatchObject({ channel: "linkedin", stepIndex: 0, status: "sent" });
    expect(statusCalls[0]).toMatchObject({ status: "sent", decidedBy: "human" });
  });

  it("refuses without a connected LinkedIn account", async () => {
    account = null;
    const res = await sendDraftRoute(post(), { id: "1" });
    expect(res.status).toBe(409);
    expect(linkedInCalls).toHaveLength(0);
  });

  it("reports a refusal the founder can fix and leaves the row unsent", async () => {
    linkedInResult = Object.assign(new Error("failed"), { code: "note_too_long" });
    const res = await sendDraftRoute(post(), { id: "1" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ flags: ["linkedin-note-too-long"] });
    expect(statusCalls).toHaveLength(0);
  });
});

describe("withdraw-invite", () => {
  beforeEach(() => {
    row.status = "sent";
    row.prospect_id = 42;
    seqEvents = [
      {
        channel: "linkedin",
        step_index: 0,
        status: "sent",
        metadata_json: JSON.stringify({ invitationId: "inv-1" }),
      },
    ];
    linkedInResult = { status: "withdrawn" };
  });

  it("withdraws through OneShot and records a withdrawn step-0 event", async () => {
    const res = await withdrawInviteRoute(post(), { id: "1" });
    expect(res.status).toBe(200);
    expect(linkedInCalls[0]).toMatchObject({ kind: "withdraw", invitationId: "inv-1" });
    expect(recorded[0]).toMatchObject({
      channel: "linkedin",
      status: "withdrawn",
      metadata: { invitationId: "inv-1", withdrawStatus: "withdrawn" },
    });
  });

  it("refuses a second withdrawal and an unsent row", async () => {
    seqEvents.push({
      channel: "linkedin",
      step_index: 0,
      status: "withdrawn",
      metadata_json: "{}",
    });
    expect((await withdrawInviteRoute(post(), { id: "1" })).status).toBe(409);
    row.status = "approved";
    expect((await withdrawInviteRoute(post(), { id: "1" })).status).toBe(400);
    expect(linkedInCalls).toHaveLength(0);
  });
});

describe("channel", () => {
  it("moves an unsent row to a channel the person has an address for", async () => {
    const res = await setQueueChannelRoute(post({ channel: "email" }), { id: "1" });
    expect(res.status).toBe(200);
    expect(channelCalls).toEqual([[1, "email"]]);
  });

  it("refuses a channel with no address, and an unknown channel", async () => {
    expect((await setQueueChannelRoute(post({ channel: "x" }), { id: "1" })).status).toBe(400);
    expect((await setQueueChannelRoute(post({ channel: "fax" }), { id: "1" })).status).toBe(400);
    expect(channelCalls).toHaveLength(0);
  });
});
