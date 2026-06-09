import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression tests for ultrareview bug_002: regenerate/send TOCTOU.
// The previous `if (row.status === "sent")` guard was read ONCE at the top
// of regenerateDraftRoute, then a multi-second `await dispatchPlay(...)`
// followed by `setQueueDraft(...)` with no re-check. A concurrent send
// completing during the await window overwrote the canonical sent body.

interface RowSnapshot {
  id: number;
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
let dispatchPlayImpl: () => Promise<Array<{ subject: string; body: string; flags: string[] }>> =
  async () => [{ subject: "subj", body: "body", flags: [] }];

const setQueueDraftCalls: Array<{ id: number; sent: boolean }> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    isDraining: () => false,
    getLedger: () => ({
      getQueueRow: () => ({ ...row }),
      setQueueDraft: (input: { id: number; draft: { sent: boolean } }) => {
        setQueueDraftCalls.push({ id: input.id, sent: input.draft.sent });
      },
    }),
  };
});

vi.mock("../src/api/_play-dispatch.ts", () => ({
  dispatchPlay: () => dispatchPlayImpl(),
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
