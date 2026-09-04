import { beforeEach, describe, expect, it, vi } from "vitest";

const resolve = vi.fn();
const record = vi.fn();
const getProspectById = vi.fn();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({
      resolveProspectForLinkedInReply: resolve,
      recordLinkedInReply: record,
      getProspectById,
    }),
  };
});

const { linkedinReplyWebhookRoute, markLinkedInReplyRoute } =
  await import("../src/api/linkedin-replies.ts");

function webhook(body: unknown, token = "test-secret-with-enough-entropy"): Request {
  return new Request("http://localhost/api/triggers/linkedin-reply", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

describe("LinkedIn reply routes", () => {
  beforeEach(() => {
    delete process.env["VITE_DEV_SERVER_URL"];
    process.env["LINKEDIN_REPLY_WEBHOOK_SECRET"] = "test-secret-with-enough-entropy";
    resolve.mockReset().mockReturnValue({ status: "matched", prospectId: 7 });
    record.mockReset().mockReturnValue({
      duplicate: false,
      prospectId: 7,
      cadencesStopped: 2,
      inFlightSends: 0,
    });
    getProspectById.mockReset().mockReturnValue({ id: 7 });
  });

  it("authenticates and records a valid provider-neutral event", async () => {
    const response = await linkedinReplyWebhookRoute(
      webhook({
        source: "expandi",
        eventId: "evt-1",
        occurredAt: "2026-08-01T10:00:00Z",
        linkedinUrl: "https://www.linkedin.com/in/ada/",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true, cadencesStopped: 2 });
    expect(record).toHaveBeenCalledWith({
      prospectId: 7,
      body: null,
      source: "expandi",
      externalEventId: "evt-1",
      occurredAt: "2026-08-01T10:00:00.000Z",
    });
  });

  it("rejects bad auth, invalid input, missing prospects, and conflicting identities", async () => {
    expect((await linkedinReplyWebhookRoute(webhook({}, "wrong"))).status).toBe(401);
    expect((await linkedinReplyWebhookRoute(webhook({ source: "UPPER" }))).status).toBe(400);
    resolve.mockReturnValueOnce({ status: "unmatched" });
    expect(
      (
        await linkedinReplyWebhookRoute(
          webhook({
            source: "zapier",
            eventId: "1",
            occurredAt: "2026-08-01T10:00:00Z",
            email: "a@example.com",
          }),
        )
      ).status,
    ).toBe(404);
    resolve.mockReturnValueOnce({ status: "conflict" });
    expect(
      (
        await linkedinReplyWebhookRoute(
          webhook({
            source: "zapier",
            eventId: "2",
            occurredAt: "2026-08-01T10:00:00Z",
            email: "a@example.com",
          }),
        )
      ).status,
    ).toBe(409);
  });

  it("supports the dashboard's prospect-id action", async () => {
    const response = await markLinkedInReplyRoute(
      new Request("http://localhost/api/prospects/7/linkedin-reply", { method: "POST" }),
      { id: "7" },
    );
    expect(response.status).toBe(200);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ prospectId: 7, source: "manual" }),
    );
  });

  it("rejects a cross-origin dashboard mutation", async () => {
    const response = await markLinkedInReplyRoute(
      new Request("http://127.0.0.1:3030/api/prospects/7/linkedin-reply", {
        method: "POST",
        headers: { origin: "http://localhost.attacker.example" },
      }),
      { id: "7" },
    );
    expect(response.status).toBe(403);
    expect(record).not.toHaveBeenCalled();
  });
});

// The manual mark used a fresh randomUUID per click, so UNIQUE(source,
// external_event_id) never fired once: prospect 586 carries two "replied"
// events 47 seconds apart from a single double-submit.
describe("manual LinkedIn reply — idempotency key", () => {
  beforeEach(() => {
    delete process.env["VITE_DEV_SERVER_URL"];
    record.mockReset().mockReturnValue({
      duplicate: false,
      prospectId: 7,
      cadencesStopped: 0,
      inFlightSends: 0,
    });
    getProspectById.mockReset().mockReturnValue({ id: 7 });
  });

  it("derives the same id from two identical submissions", async () => {
    const call = () =>
      markLinkedInReplyRoute(
        new Request("http://localhost/api/prospects/7/linkedin-reply", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "Hey — what are you building?" }),
        }),
        { id: "7" },
      );
    await call();
    await call();
    const ids = record.mock.calls.map((c) => (c[0] as { externalEventId: string }).externalEventId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("is NOT keyed on the clock — the two real duplicates straddled a minute boundary", async () => {
    // 20:51:13 and 20:52:00. Any fixed time bucket has an edge a double-click
    // can straddle, so identity is the key: same prospect, same message.
    const at = (iso: string) => {
      vi.setSystemTime(new Date(iso));
      return markLinkedInReplyRoute(
        new Request("http://localhost/api/prospects/586/linkedin-reply", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "same message" }),
        }),
        { id: "586" },
      );
    };
    vi.useFakeTimers();
    try {
      await at("2026-09-01T20:51:13.993Z");
      await at("2026-09-01T20:52:00.217Z");
    } finally {
      vi.useRealTimers();
    }
    const ids = record.mock.calls.map((c) => (c[0] as { externalEventId: string }).externalEventId);
    expect(ids[0]).toBe(ids[1]);
  });

  it("gives a genuinely different message its own id, and stores the text", async () => {
    const send = (body: string) =>
      markLinkedInReplyRoute(
        new Request("http://localhost/api/prospects/7/linkedin-reply", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body }),
        }),
        { id: "7" },
      );
    await send("first");
    await send("second, different");
    const calls = record.mock.calls.map((c) => c[0] as { externalEventId: string; body: string });
    expect(calls[0]?.externalEventId).not.toBe(calls[1]?.externalEventId);
    expect(calls[0]?.body).toBe("first");
  });

  it("still records with no body at all", async () => {
    const response = await markLinkedInReplyRoute(
      new Request("http://localhost/api/prospects/7/linkedin-reply", { method: "POST" }),
      { id: "7" },
    );
    expect(response.status).toBe(200);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ body: null }));
  });
});
