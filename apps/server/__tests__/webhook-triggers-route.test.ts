import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueued: Array<Record<string, unknown>> = [];
let icpMatch: boolean | null = true;

vi.mock("@oneshot-gtm/core", () => ({
  getLedger: () => ({
    enqueueTarget: (row: Record<string, unknown>) => {
      enqueued.push(row);
      return 42;
    },
  }),
}));

vi.mock("@oneshot-gtm/find", () => ({
  resolveIcp: () => "technical SaaS founders",
  icpFilter: async () => ({ match: icpMatch, reason: icpMatch ? "fits" : "not a fit" }),
}));

const { calNoShowWebhookRoute, signupWebhookRoute } =
  await import("../src/api/webhook-triggers.ts");

function request(path: string, body: unknown): Request {
  return new Request(`http://localhost/api/triggers/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  enqueued.length = 0;
  icpMatch = true;
});

describe("webhook trigger intake", () => {
  it("ICP-filters and enqueues accepted events into their plays", async () => {
    const noShow = {
      name: "Ada",
      email: "ada@example.com",
      phone: "+15555550100",
      company: "Analytical Engines",
      missedAt: "2026-09-01T10:00:00Z",
      rescheduleLink: "https://example.com/reschedule",
    };
    const signup = {
      name: "Grace",
      email: "grace@example.com",
      phone: "+15555550101",
      signupContext: "Started a team trial",
    };

    expect((await calNoShowWebhookRoute(request("cal-no-show", noShow))).status).toBe(202);
    expect((await signupWebhookRoute(request("signup", signup))).status).toBe(202);
    expect(enqueued).toMatchObject([
      { playName: "demo-no-show", payload: noShow, source: "webhook:cal-no-show" },
      { playName: "concierge", payload: signup, source: "webhook:signup" },
    ]);
  });

  it("does not enqueue an ICP rejection", async () => {
    icpMatch = false;
    const res = await signupWebhookRoute(
      request("signup", { name: "Pat", email: "pat@example.com", phone: "+15555550102" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: false, reason: "not a fit" });
    expect(enqueued).toHaveLength(0);
  });

  it("returns a JSON 400 for malformed and unknown payloads", async () => {
    const missing = await calNoShowWebhookRoute(
      request("cal-no-show", { event: "calendar.cancelled", mystery: true }),
    );
    expect(missing.status).toBe(400);
    expect(missing.headers.get("content-type")).toContain("application/json");
    expect(await missing.json()).toHaveProperty("error");

    const malformed = await signupWebhookRoute(request("signup", "{"));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid JSON body" });
    expect(enqueued).toHaveLength(0);
  });
});
