import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const previewBatchMock = vi.fn();
const sendBatchMock = vi.fn();

vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return {
    ...actual,
    previewCadenceStepBatch: (items: unknown) => previewBatchMock(items),
    sendCadenceStepBatch: (items: unknown) => sendBatchMock(items),
  };
});

const { previewCadenceBatchRoute, sendCadenceBatchRoute } = await import(
  "../src/api/cadences.ts"
);

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
      { prospectId: 1, playName: "show-hn", ok: true, preview: { subject: "s", body: "b", flags: [], draftedAt: "now" } },
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
      { prospectId: 1, playName: "show-hn", ok: true, preview: { subject: "s", body: "b", flags: [], draftedAt: "now" } },
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
    // Wrapper resolves after a microtask — verify the route returns BEFORE
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
});
