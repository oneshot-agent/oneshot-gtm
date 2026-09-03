import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueued: Array<Record<string, unknown>> = [];
let icpMatch: boolean | null = true;
let icpFilterImpl: (() => Promise<{ match: boolean | null; reason: string }>) | null = null;
const webhookReplays = new Map<string, number>();

vi.mock("@oneshot-gtm/core", () => ({
  // jsonResponse scrubs demo paths out of every response, so the module's
  // demo seam has to exist on the mock even though these routes never run in
  // demo mode.
  demoMode: () => false,
  scrubDemoPaths: (json: string) => json,
  configDir: () => "/tmp/webhook-test-home",
  getLedger: () => ({
    consumeWebhookReplay: (key: string, expiresAt: number, now: number) => {
      for (const [storedKey, storedExpiry] of webhookReplays) {
        if (storedExpiry < now) webhookReplays.delete(storedKey);
      }
      if (webhookReplays.has(key)) return false;
      webhookReplays.set(key, expiresAt);
      return true;
    },
    clearWebhookReplays: () => webhookReplays.clear(),
    releaseWebhookReplay: (key: string) => {
      webhookReplays.delete(key);
    },
    enqueueTarget: (row: Record<string, unknown>) => {
      enqueued.push(row);
      return 42;
    },
  }),
}));

vi.mock("@oneshot-gtm/find", () => ({
  resolveIcp: () => "technical SaaS founders",
  icpFilter: async () =>
    icpFilterImpl ? icpFilterImpl() : { match: icpMatch, reason: icpMatch ? "fits" : "not a fit" },
}));

const { calNoShowWebhookRoute, signupWebhookRoute } =
  await import("../src/api/webhook-triggers.ts");
const { resetWebhookReplayCache } = await import("../src/api/webhook-verifier.ts");

function request(
  path: string,
  body: unknown,
  secret?: string,
  timestamp = Math.floor(Date.now() / 1_000),
): Request {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const signature = secret
    ? `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`
    : undefined;
  return new Request(`http://localhost/api/triggers/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature ? { "x-webhook-signature": signature } : {}),
    },
    body: raw,
  });
}

beforeEach(() => {
  enqueued.length = 0;
  icpMatch = true;
  icpFilterImpl = null;
  delete process.env["WEBHOOK_SECRET"];
  resetWebhookReplayCache();
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

  it("accepts valid signed events on both intake endpoints", async () => {
    process.env["WEBHOOK_SECRET"] = "whsec-test";
    const signup = { name: "Grace", email: "grace@example.com", phone: "+15555550101" };
    const noShow = {
      name: "Ada",
      email: "ada@example.com",
      company: "Analytical Engines",
      missedAt: "2026-09-01T10:00:00Z",
      rescheduleLink: "https://example.com/reschedule",
    };

    expect(
      (await signupWebhookRoute(request("signup", signup, process.env["WEBHOOK_SECRET"]))).status,
    ).toBe(202);
    expect(
      (await calNoShowWebhookRoute(request("cal-no-show", noShow, process.env["WEBHOOK_SECRET"])))
        .status,
    ).toBe(202);
  });

  it("rejects tampered, expired, and replayed deliveries", async () => {
    const secret = "whsec-test";
    process.env["WEBHOOK_SECRET"] = secret;
    const payload = { name: "Grace", email: "grace@example.com", phone: "+15555550101" };
    const signed = request("signup", payload, secret);
    const signature = signed.headers.get("x-webhook-signature")!;
    const tampered = request("signup", { ...payload, name: "Mallory" });
    tampered.headers.set("x-webhook-signature", signature);

    expect((await signupWebhookRoute(tampered)).status).toBe(401);
    expect(
      (
        await signupWebhookRoute(
          request("signup", payload, secret, Math.floor(Date.now() / 1_000) - 301),
        )
      ).status,
    ).toBe(401);
    expect((await signupWebhookRoute(signed.clone())).status).toBe(202);
    const replay = await signupWebhookRoute(signed.clone());
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "replayed webhook" });
  });

  it("does not consume a valid signature when the JSON is malformed", async () => {
    const secret = "whsec-test";
    process.env["WEBHOOK_SECRET"] = secret;
    const signed = request("signup", "{", secret);

    expect((await signupWebhookRoute(signed.clone())).status).toBe(400);
    expect(webhookReplays.size).toBe(0);
    expect((await signupWebhookRoute(signed.clone())).status).toBe(400);
  });

  it("keeps unsigned local intake enabled when no secret is configured", async () => {
    const response = await signupWebhookRoute(
      request("signup", { name: "Pat", email: "pat@example.com", phone: "+155****0102" }),
    );
    expect(response.status).toBe(202);
  });

  it("releases the replay key on a downstream ICP-filter failure so a retry is not rejected as replayed", async () => {
    const secret = "whsec-test";
    process.env["WEBHOOK_SECRET"] = secret;
    const signup = { name: "Grace", email: "grace@example.com", phone: "+155****0101" };
    const signed = request("signup", signup, secret);

    // First attempt: icpFilter throws (transient LLM error). intakeWebhook
    // re-throws after releasing the replay key (buildFetchHandler in
    // server.ts turns this into a 500 in production); calling the route
    // directly here bypasses that wrapper, so assert the throw itself.
    icpFilterImpl = async () => {
      throw new Error("transient LLM error");
    };
    await expect(signupWebhookRoute(signed.clone())).rejects.toThrow("transient LLM error");
    expect(enqueued).toHaveLength(0);

    // Retry with the identical signed payload (same timestamp + signature):
    // must succeed now that the transient failure is over, proving the
    // replay key was released rather than burned by the failed attempt.
    icpFilterImpl = async () => ({ match: true, reason: "fits" });
    const retry = await signupWebhookRoute(signed.clone());
    expect(retry.status).toBe(202);
    expect(enqueued).toHaveLength(1);
  });
});
