import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const previewBatchMock = vi.fn();
const sendBatchMock = vi.fn();
const claimMarkerMock = vi.fn(() => true);
const clearMarkerMock = vi.fn();
// Cadences an out-of-office holds, by prospect id: `held_until` in the future.
let heldIds = new Set<number>();
// Email previews by prospect id, with the config key each was written under.
let emailDrafts = new Map<number, string | undefined>();

vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return {
    ...actual,
    previewCadenceStepBatch: (items: unknown) => previewBatchMock(items),
    sendCadenceStepBatch: (items: unknown) => sendBatchMock(items),
  };
});

// The route now claims `cadence_state.sending_started_at` before kicking off
// the background send (atomic CAS). Mock the ledger so claim always succeeds:
// the tests below assert routing behavior, not the marker semantics (covered
// in packages/core/__tests__/ledger.test.ts).
vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({
      claimCadenceSendingMarker: claimMarkerMock,
      clearCadenceSendingMarker: clearMarkerMock,
      getCadence: (prospectId: number) =>
        heldIds.has(prospectId)
          ? {
              held_until: new Date(Date.now() + 86_400_000).toISOString(),
              hold_reason: "out-of-office",
              return_date: "2026-11-09",
            }
          : { held_until: null },
      getCadenceDraft: (item: { prospectId: number }) =>
        emailDrafts.has(item.prospectId)
          ? {
              subject: "s",
              body: "b",
              flags: [],
              payload: { kind: "email", subject: "s", body: "b" },
              draftedAt: "now",
              ...(emailDrafts.get(item.prospectId)
                ? { configKey: emailDrafts.get(item.prospectId) }
                : {}),
            }
          : { subject: "s", body: "b", flags: [], payload: {}, draftedAt: "now" },
    }),
  };
});

const { previewCadenceBatchRoute, sendCadenceBatchRoute } = await import("../src/api/cadences.ts");
const { draftConfigKey } = await import("@oneshot-gtm/plays");
const { loadConfig } = await import("@oneshot-gtm/core");
/** Today's key for a show-hn follow-up. */
const currentKey = () =>
  draftConfigKey(loadConfig(), {
    surface: { channel: "email", stage: "follow_up" },
    playName: "show-hn",
  });

function jsonBody(body: unknown): Request {
  return new Request("http://localhost/api/cadences/preview-batch", {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1:3030" },
    body: JSON.stringify(body),
  });
}

function badJsonRequest(): Request {
  return new Request("http://localhost/api/cadences/preview-batch", {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1:3030" },
    body: "{not-json",
  });
}

beforeEach(() => {
  previewBatchMock.mockReset();
  sendBatchMock.mockReset();
  claimMarkerMock.mockReset();
  claimMarkerMock.mockReturnValue(true);
  clearMarkerMock.mockReset();
  heldIds = new Set();
  emailDrafts = new Map();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("previewCadenceBatchRoute", () => {
  it("400s when body is not JSON", async () => {
    const res = await previewCadenceBatchRoute(badJsonRequest());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: /invalid JSON/i });
    expect(previewBatchMock).not.toHaveBeenCalled();
  });

  it("400s when items is missing", async () => {
    const res = await previewCadenceBatchRoute(jsonBody({}));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: /items.*required/i });
    expect(previewBatchMock).not.toHaveBeenCalled();
  });

  it("400s when items is not an array", async () => {
    const res = await previewCadenceBatchRoute(jsonBody({ items: "nope" }));
    expect(res.status).toBe(400);
    expect(previewBatchMock).not.toHaveBeenCalled();
  });

  it("400s when items has zero VALID entries (every entry is malformed)", async () => {
    const res = await previewCadenceBatchRoute(
      jsonBody({ items: [{ prospectId: "not-a-number", playName: "x" }, { playName: 1 }] }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: /no valid items/i });
    expect(previewBatchMock).not.toHaveBeenCalled();
  });

  it("silently drops malformed entries when at least one is valid", async () => {
    previewBatchMock.mockResolvedValue([
      {
        prospectId: 1,
        playName: "show-hn",
        ok: true,
        preview: { subject: "s", body: "b", flags: [], draftedAt: "now" },
      },
    ]);
    const res = await previewCadenceBatchRoute(
      jsonBody({
        items: [
          { prospectId: 1, playName: "show-hn" },
          { prospectId: "bad", playName: "x" },
          { onlyOne: "field" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    // Only the one well-formed item reached the wrapper.
    expect(previewBatchMock).toHaveBeenCalledWith([{ prospectId: 1, playName: "show-hn" }]);
    expect(await res.json()).toEqual({
      results: [
        {
          prospectId: 1,
          playName: "show-hn",
          ok: true,
          preview: { subject: "s", body: "b", flags: [], draftedAt: "now" },
        },
      ],
    });
  });

  it("200s with results pass-through when wrapper returns mixed ok/error", async () => {
    previewBatchMock.mockResolvedValue([
      {
        prospectId: 1,
        playName: "show-hn",
        ok: true,
        preview: { subject: "s", body: "b", flags: [], draftedAt: "now" },
      },
      { prospectId: 2, playName: "show-hn", ok: false, error: "cadence is replied" },
    ]);
    const res = await previewCadenceBatchRoute(
      jsonBody({
        items: [
          { prospectId: 1, playName: "show-hn" },
          { prospectId: 2, playName: "show-hn" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ ok: boolean }> };
    expect(body.results).toHaveLength(2);
    expect(body.results[0]?.ok).toBe(true);
    expect(body.results[1]?.ok).toBe(false);
  });
});

describe("sendCadenceBatchRoute (fire-and-forget)", () => {
  it("returns 202 immediately and kicks off the background batch", async () => {
    // Wrapper resolves after a microtask: verify the route returns BEFORE
    // it completes.
    let backgroundResolved = false;
    sendBatchMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      backgroundResolved = true;
      return [];
    });

    const res = await sendCadenceBatchRoute(
      jsonBody({
        items: [
          { prospectId: 1, playName: "show-hn" },
          { prospectId: 2, playName: "show-hn" },
        ],
      }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 2 });
    // The route has returned but the background wrapper is still running.
    expect(backgroundResolved).toBe(false);
    expect(sendBatchMock).toHaveBeenCalledTimes(1);
    // Wait for the background promise to drain before the test exits, so
    // it doesn't pollute later tests' mock state.
    await new Promise((r) => setTimeout(r, 100));
    expect(backgroundResolved).toBe(true);
  });

  it("400s on the same malformed-body shapes as preview", async () => {
    const res = await sendCadenceBatchRoute(jsonBody({ nope: true }));
    expect(res.status).toBe(400);
    expect(sendBatchMock).not.toHaveBeenCalled();
  });

  it("background-promise rejection doesn't crash; route already returned 202", async () => {
    sendBatchMock.mockRejectedValue(new Error("boom"));
    const res = await sendCadenceBatchRoute(
      jsonBody({ items: [{ prospectId: 1, playName: "show-hn" }] }),
    );
    expect(res.status).toBe(202);
    // The unhandled rejection (if any) is captured by the IIFE's try/catch
    // around sendBatchMock. Give the microtask queue a tick to drain.
    await new Promise((r) => setTimeout(r, 30));
    expect(sendBatchMock).toHaveBeenCalled();
  });

  it("skips a row an out-of-office holds and reports it", async () => {
    heldIds = new Set([2]);
    sendBatchMock.mockResolvedValue([]);
    const res = await sendCadenceBatchRoute(
      jsonBody({
        items: [
          { prospectId: 1, playName: "show-hn" },
          { prospectId: 2, playName: "show-hn" },
        ],
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      accepted: number;
      skipped: Array<{ prospectId: number; reason: string }>;
    };
    expect(body.accepted).toBe(1);
    expect(body.skipped).toEqual([
      expect.objectContaining({
        prospectId: 2,
        reason: expect.stringMatching(/^away until 2026-11-09/),
      }),
    ]);
    // The held row is never claimed, so it never reads "sending…".
    expect(claimMarkerMock).toHaveBeenCalledTimes(1);
    expect(sendBatchMock.mock.calls[0]?.[0]).toEqual([{ prospectId: 1, playName: "show-hn" }]);
  });

  it("skips a preview written under an older setup, or before previews had a key", async () => {
    emailDrafts = new Map([
      [1, currentKey()],
      [2, "0ld0ld0ld0ld"],
      [3, undefined],
    ]);
    sendBatchMock.mockResolvedValue([]);
    const res = await sendCadenceBatchRoute(
      jsonBody({
        items: [1, 2, 3].map((prospectId) => ({ prospectId, playName: "show-hn" })),
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      accepted: number;
      skipped: Array<{ prospectId: number; reason: string }>;
    };
    expect(body.accepted).toBe(1);
    expect(body.skipped).toEqual([
      {
        prospectId: 2,
        playName: "show-hn",
        reason: "draft written under an older setup; re-preview",
      },
      {
        prospectId: 3,
        playName: "show-hn",
        reason: "draft written under an older setup; re-preview",
      },
    ]);
    expect(claimMarkerMock).toHaveBeenCalledTimes(1);
    expect(sendBatchMock.mock.calls[0]?.[0]).toEqual([{ prospectId: 1, playName: "show-hn" }]);
  });

  it("409s when every selected preview is stale, saying so", async () => {
    emailDrafts = new Map([[1, "0ld0ld0ld0ld"]]);
    const res = await sendCadenceBatchRoute(
      jsonBody({ items: [{ prospectId: 1, playName: "show-hn" }] }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: /older setup/, skipped: [{ prospectId: 1 }] });
    expect(sendBatchMock).not.toHaveBeenCalled();
  });

  it("409s when every selected row is held", async () => {
    heldIds = new Set([1]);
    const res = await sendCadenceBatchRoute(
      jsonBody({ items: [{ prospectId: 1, playName: "show-hn" }] }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: /away/, skipped: [{ prospectId: 1 }] });
    expect(sendBatchMock).not.toHaveBeenCalled();
  });
});
