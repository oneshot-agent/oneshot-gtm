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
    const response = markLinkedInReplyRoute(
      new Request("http://localhost/api/prospects/7/linkedin-reply", { method: "POST" }),
      { id: "7" },
    );
    expect(response.status).toBe(200);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ prospectId: 7, source: "manual" }),
    );
  });

  it("rejects a cross-origin dashboard mutation", () => {
    const response = markLinkedInReplyRoute(
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
