import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/queue/import — the destination side of a cross-workspace move.
// The row must land pending with the sender's positioning and verdicts
// stripped, and a rejected row this workspace already holds for the same
// play + dedupe key must be re-opened, not refused.

type Row = {
  id: number;
  play_name: string;
  dedupe_key: string;
  status: string;
  sent_at: string | null;
  send_started_at: string | null;
};

let enqueueResult: number | null = 51;
let existing: Row | null = null;
const calls = {
  enqueue: [] as Array<Record<string, unknown>>,
  status: [] as Array<Record<string, unknown>>,
  payload: [] as Array<Record<string, unknown>>,
  cleared: [] as number[],
};

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({
      enqueueTarget: (input: Record<string, unknown>) => {
        calls.enqueue.push(input);
        return enqueueResult;
      },
      getQueueRowByDedupe: () => existing,
      setQueueStatus: (input: Record<string, unknown>) => {
        calls.status.push(input);
      },
      updateQueuePayload: (input: Record<string, unknown>) => {
        calls.payload.push(input);
      },
      clearQueueDraft: (id: number) => {
        calls.cleared.push(id);
      },
    }),
  };
});

const { importQueueRowRoute } = await import("../src/api/queue.ts");

const req = (body: unknown) =>
  new Request("http://127.0.0.1:3031/api/queue/import", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const good = {
  playName: "luma-events",
  dedupeKey: "luma:ada@example.com",
  source: "find:luma-events:ai-builders-sf",
  payload: {
    name: "Ada",
    email: "ada@example.com",
    personResearch: { status: "ok" },
    yourEdge: "the sender's edge",
    icpVerdict: "reject",
    fitReason: "fits the other product",
  },
  movedFrom: { workspace: "sdk", queueId: 746 },
};

beforeEach(() => {
  enqueueResult = 51;
  existing = null;
  calls.enqueue.length = 0;
  calls.status.length = 0;
  calls.payload.length = 0;
  calls.cleared.length = 0;
});

describe("POST /api/queue/import", () => {
  it("enqueues a pending row with the portable payload, provenance and a 'moved from' note", async () => {
    const res = await importQueueRowRoute(req(good));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ queueId: 51, reused: false });
    expect(calls.enqueue).toHaveLength(1);
    const input = calls.enqueue[0]!;
    expect(input["playName"]).toBe("luma-events");
    expect(input["dedupeKey"]).toBe("luma:ada@example.com");
    expect(input["source"]).toBe("find:luma-events:ai-builders-sf");
    expect(input["notes"]).toBe("moved from sdk");
    const payload = input["payload"] as Record<string, unknown>;
    expect(payload["name"]).toBe("Ada");
    expect(payload["personResearch"]).toEqual({ status: "ok" });
    expect(payload).not.toHaveProperty("yourEdge");
    expect(payload).not.toHaveProperty("icpVerdict");
    expect(payload).not.toHaveProperty("fitReason");
    expect(payload["movedFrom"]).toMatchObject({ workspace: "sdk", queueId: 746 });
    expect(typeof (payload["movedFrom"] as { at: string }).at).toBe("string");
  });

  it("re-opens a rejected row it already holds: pending, fresh payload, stale draft cleared", async () => {
    enqueueResult = null;
    existing = {
      id: 9,
      play_name: "luma-events",
      dedupe_key: "luma:ada@example.com",
      status: "rejected",
      sent_at: null,
      send_started_at: null,
    };
    const res = await importQueueRowRoute(req(good));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queueId: 9, reused: true });
    expect(calls.status).toEqual([{ id: 9, status: "pending", notes: "moved from sdk" }]);
    const written = calls.payload[0]!;
    expect(written["id"]).toBe(9);
    expect((written["payload"] as Record<string, unknown>)["movedFrom"]).toBeDefined();
    expect(calls.cleared).toEqual([9]);
  });

  it("refuses when this workspace already sent to the person on that play", async () => {
    enqueueResult = null;
    existing = {
      id: 9,
      play_name: "luma-events",
      dedupe_key: "luma:ada@example.com",
      status: "sent",
      sent_at: "2026-09-01T00:00:00Z",
      send_started_at: null,
    };
    const res = await importQueueRowRoute(req(good));
    expect(res.status).toBe(409);
    expect(calls.status).toHaveLength(0);
    expect(calls.payload).toHaveLength(0);
  });

  it("rejects malformed bodies and unknown plays", async () => {
    expect((await importQueueRowRoute(req("not json"))).status).toBe(400);
    expect((await importQueueRowRoute(req({ ...good, dedupeKey: "" }))).status).toBe(400);
    expect((await importQueueRowRoute(req({ ...good, movedFrom: {} }))).status).toBe(400);
    expect((await importQueueRowRoute(req({ ...good, playName: "no-such-play" }))).status).toBe(
      400,
    );
    expect(calls.enqueue).toHaveLength(0);
  });
});
