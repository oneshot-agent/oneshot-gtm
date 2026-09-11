import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression tests for ultrareview bug_002: regenerate/send TOCTOU.
// The previous `if (row.status === "sent")` guard was read ONCE at the top
// of regenerateDraftRoute, then a multi-second `await dispatchPlay(...)`
// followed by `setQueueDraft(...)` with no re-check. A concurrent send
// completing during the await window overwrote the canonical sent body.

interface RowSnapshot {
  id: number;
  source?: string;
  last_draft_json?: string;
  play_name: string;
  payload_json: string;
  status: string;
  send_started_at: string | null;
}

let row: RowSnapshot = {
  id: 1,
  play_name: "show-hn",
  payload_json: JSON.stringify({ email: "a@b.dev" }),
  status: "approved",
  send_started_at: null,
};

// Per-test override: how should dispatchPlay behave? Default is success;
// tests that simulate a concurrent send flip the row mid-await.
let dispatchPlayImpl: () => Promise<
  Array<{ subject: string; body: string; flags: string[] }>
> = async () => [{ subject: "subj", body: "body", flags: [] }];

const getTrigger = vi.fn();
const dispatchCalls: unknown[] = [];
const dispatchAngles: Array<string | undefined> = [];

const setQueueDraftCalls: Array<{ id: number; sent: boolean }> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    isDraining: () => false,
    getLedger: () => ({
      getQueueRow: () => ({ ...row }),
      getTrigger,
      setQueueDraftIfCurrent: (input: { id: number; draft: { sent: boolean } }) => {
        setQueueDraftCalls.push({ id: input.id, sent: input.draft.sent });
        return true;
      },
    }),
  };
});

vi.mock("../src/api/_play-dispatch.ts", () => ({
  dispatchPlay: (
    _name: string,
    body: unknown,
    _progress: unknown,
    _signal: unknown,
    angle?: string,
  ) => {
    dispatchAngles.push(angle);
    dispatchCalls.push(body);
    return dispatchPlayImpl();
  },
}));

const { regenerateDraftRoute } = await import("../src/api/queue.ts");

beforeEach(() => {
  row = {
    id: 1,
    play_name: "show-hn",
    payload_json: JSON.stringify({ email: "a@b.dev" }),
    status: "approved",
    send_started_at: null,
  };
  setQueueDraftCalls.length = 0;
  dispatchCalls.length = 0;
  dispatchAngles.length = 0;
  getTrigger.mockReset();
  dispatchPlayImpl = async () => [{ subject: "subj", body: "body", flags: [] }];
});

afterEach(() => {
  vi.clearAllMocks();
});

function req(): Request {
  return new Request("http://x/api/queue/1/regenerate", { method: "POST" });
}

describe("regenerateDraftRoute — TOCTOU guards", () => {
  it("rejects with 400 when row.status is already 'sent' (top-of-function guard)", async () => {
    row.status = "sent";
    const res = await regenerateDraftRoute(req(), { id: "1" });
    expect(res.status).toBe(400);
    expect(setQueueDraftCalls).toHaveLength(0);
  });

  it("rejects with 409 when a send is in flight at request time (send_started_at != null)", async () => {
    row.send_started_at = "2026-06-09T12:00:00Z";
    const res = await regenerateDraftRoute(req(), { id: "1" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/send in flight/i);
    expect(setQueueDraftCalls).toHaveLength(0);
  });

  it("rejects with 409 + skips setQueueDraft when status flips to 'sent' during dispatchPlay (post-await re-check)", async () => {
    // Simulate: regenerate started while approved; a concurrent send
    // completed during the LLM call and flipped status to "sent".
    dispatchPlayImpl = async () => {
      row.status = "sent";
      return [{ subject: "subj", body: "body", flags: [] }];
    };
    const res = await regenerateDraftRoute(req(), { id: "1" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/send completed/i);
    // CRITICAL: the canonical sent body must not have been overwritten.
    expect(setQueueDraftCalls).toHaveLength(0);
  });

  it("rejects with 409 + skips setQueueDraft when send claims the row during dispatchPlay", async () => {
    // Like the previous, but send is still in flight (claimed marker, not
    // yet flipped status). Post-await re-check must catch both cases.
    dispatchPlayImpl = async () => {
      row.send_started_at = "2026-06-09T12:00:00Z";
      return [{ subject: "subj", body: "body", flags: [] }];
    };
    const res = await regenerateDraftRoute(req(), { id: "1" });
    expect(res.status).toBe(409);
    expect(setQueueDraftCalls).toHaveLength(0);
  });

  it("happy path: approved + no in-flight send → 200 + setQueueDraft called once with sent=false", async () => {
    const res = await regenerateDraftRoute(req(), { id: "1" });
    expect(res.status).toBe(200);
    expect(setQueueDraftCalls).toHaveLength(1);
    expect(setQueueDraftCalls[0]?.sent).toBe(false);
  });
});

it("regenerates from current trigger edges without changing saved context", async () => {
  row.source = "find:luma-events";
  row.payload_json = JSON.stringify({
    email: "a@b.dev",
    yourEdge: "LinkedIn versus email",
    dossier: "facts",
  });
  const original = row.payload_json;
  getTrigger.mockReturnValue({
    config_json: JSON.stringify({ yourEdge: "the product is the playbook" }),
  });
  const res = await regenerateDraftRoute(req(), { id: "1" });
  expect(res.status).toBe(200);
  expect(dispatchCalls[0]).toEqual({
    dryRun: true,
    targets: [{ email: "a@b.dev", yourEdge: "the product is the playbook", dossier: "facts" }],
  });
  expect(row.payload_json).toBe(original);
});
it("rejects malformed trigger config before dispatching", async () => {
  row.source = "find:luma-events";
  getTrigger.mockReturnValue({ config_json: "{" });
  const res = await regenerateDraftRoute(req(), { id: "1" });
  expect(res.status).toBe(400);
  expect(dispatchCalls).toHaveLength(0);
  expect(setQueueDraftCalls).toHaveLength(0);
});

it("rejects concurrent generations and releases the lock", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  dispatchPlayImpl = async () => {
    await pending;
    return [{ subject: "s", body: "b", flags: [] }];
  };
  const first = regenerateDraftRoute(req(), { id: "1" });
  const second = await regenerateDraftRoute(req(), { id: "1" });
  expect(second.status).toBe(409);
  release();
  expect((await first).status).toBe(200);
  expect((await regenerateDraftRoute(req(), { id: "1" })).status).toBe(200);
});
it("preserves the previous draft when the writer fails", async () => {
  dispatchPlayImpl = async () => [{ subject: "error", body: "", flags: ["error:provider"] }];
  expect((await regenerateDraftRoute(req(), { id: "1" })).status).toBe(500);
  expect(setQueueDraftCalls).toHaveLength(0);
});
it("validates rotation input before drafting", async () => {
  const bad = new Request("http://x/api/queue/1/regenerate", {
    method: "POST",
    body: JSON.stringify({ rotateAngle: "yes" }),
  });
  expect((await regenerateDraftRoute(bad, { id: "1" })).status).toBe(400);
  expect(dispatchCalls).toHaveLength(0);
});

it("rotation passes the next angle explicitly to the writer", async () => {
  row.payload_json = JSON.stringify({
    email: "a@b.dev",
    // A full pool, so rotation is a pure index step and nothing is generated.
    yourEdge:
      "first // second // third // fourth // fifth // sixth // seventh // eighth // ninth // tenth // eleventh // twelfth",
  });
  row.last_draft_json = JSON.stringify({
    body: "old draft",
    angle: {
      text: "first",
      origin: "configured",
      index: 0,
      count: 3,
      fingerprint: "older positioning",
      history: [],
    },
  });
  const response = await regenerateDraftRoute(
    new Request("http://x/api/queue/1/regenerate", {
      method: "POST",
      body: JSON.stringify({ rotateAngle: true }),
    }),
    { id: "1" },
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.angle.text).toBe("second");
  expect(body.angle.index).toBe(1);
  expect(dispatchAngles).toEqual(["second"]);
  expect(row.last_draft_json).toContain("old draft");
});
