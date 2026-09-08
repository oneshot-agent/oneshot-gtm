import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The manual mark-sent flow: a hand-sent x-amplify-dm draft is recorded as a
// channel:"x" step-0 sequence event (no receipt — no SDK call) and the row
// flips to sent. Non-manual plays must be refused: they have a real transport.

interface FakeRow {
  id: number;
  play_name: string;
  payload_json: string;
  status: string;
  last_draft_json: string | null;
}

let row: FakeRow;
const events: Array<{
  prospectId: number;
  playName: string;
  stepIndex: number;
  channel: string;
  status: string;
  metadata?: Record<string, unknown>;
}> = [];
const statusCalls: Array<{ id: number; status: string }> = [];
const upserts: Array<Record<string, unknown>> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({
      getQueueRow: () => ({ ...row }),
      upsertProspect: (input: Record<string, unknown>) => {
        upserts.push(input);
        return 42;
      },
      recordSequenceEvent: (input: (typeof events)[number]) => {
        events.push(input);
        return 1;
      },
      setQueueProspectId: () => {},
      setQueueStatus: (input: { id: number; status: string }) => {
        statusCalls.push(input);
      },
    }),
  };
});

const { markSentRoute } = await import("../src/api/queue.ts");

const req = new Request("http://localhost/api/queue/1/mark-sent", { method: "POST" });

beforeEach(() => {
  events.length = 0;
  statusCalls.length = 0;
  upserts.length = 0;
  row = {
    id: 1,
    play_name: "x-amplify-dm",
    payload_json: JSON.stringify({
      name: "Some One",
      handle: "someone",
      twitterUrl: "https://x.com/someone",
      seedHandle: "iamdevloper",
      tweetUrl: "https://x.com/iamdevloper/status/1",
    }),
    status: "approved",
    last_draft_json: JSON.stringify({ subject: "X DM → @someone", body: "dm text", flags: [] }),
  };
});
afterEach(() => vi.clearAllMocks());

describe("markSentRoute", () => {
  it("records a channel-x step-0 event with the body and flips the row to sent", async () => {
    const res = await markSentRoute(req, { id: "1" });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]!.channel).toBe("x");
    expect(events[0]!.stepIndex).toBe(0);
    expect(events[0]!.status).toBe("sent");
    expect(events[0]!.playName).toBe("x-amplify-dm");
    expect(events[0]!.metadata).toMatchObject({ body: "dm text", seedHandle: "iamdevloper" });
    expect(statusCalls).toEqual([{ id: 1, status: "sent", decidedBy: "human" }]);
    // Prospect keyed by the X profile, not an email.
    expect(upserts[0]).toMatchObject({
      email: null,
      linkedin_url: "https://x.com/someone",
      source_profile_url: "https://x.com/someone",
    });
  });

  it("refuses a play that has a real transport", async () => {
    row.play_name = "x-amplify";
    const res = await markSentRoute(req, { id: "1" });
    expect(res.status).toBe(400);
    expect(events).toHaveLength(0);
    expect(statusCalls).toHaveLength(0);
  });

  it("refuses a row with no draft", async () => {
    row.last_draft_json = null;
    const res = await markSentRoute(req, { id: "1" });
    expect(res.status).toBe(400);
    expect(events).toHaveLength(0);
  });

  it("refuses a row already marked sent", async () => {
    row.status = "sent";
    const res = await markSentRoute(req, { id: "1" });
    expect(res.status).toBe(400);
    expect(events).toHaveLength(0);
  });

  it("refuses a rejected row — marking it sent would silently un-reject it", async () => {
    row.status = "rejected";
    const res = await markSentRoute(req, { id: "1" });
    expect(res.status).toBe(400);
    expect(events).toHaveLength(0);
    expect(statusCalls).toHaveLength(0);
  });

  it("refuses a never-reviewed (pending) row", async () => {
    row.status = "pending";
    const res = await markSentRoute(req, { id: "1" });
    expect(res.status).toBe(400);
    expect(events).toHaveLength(0);
  });
});
