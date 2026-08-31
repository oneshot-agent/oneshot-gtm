import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listSmartleadAccounts, sendViaSmartlead } from "../src/smartlead.ts";

// Smartlead REST client: paging, response sanitization (the raw rows carry
// base64 mailbox passwords), key-never-in-errors, and the send contract.

const KEY = "sk-test-SECRETKEY-123";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rawAccount(id: number, email: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    from_email: email,
    from_name: "Jane",
    message_per_day: 30,
    daily_sent_count: 3,
    is_smtp_success: true,
    type: "SMTP",
    // The fields that must NEVER survive sanitization:
    password: "cGFzc3dvcmQtc2VjcmV0",
    smtp_password: "c210cC1zZWNyZXQ=",
    warmup_details: { status: "ACTIVE", warmup_reputation: "95%", reply_rate: 40 },
    ...extra,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("listSmartleadAccounts", () => {
  it("pages until a short page and concatenates", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => rawAccount(i, `a${i}@x.com`));
    const page2 = [rawAccount(200, "tail@x.com")];
    fetchMock.mockResolvedValueOnce(jsonResponse(page1)).mockResolvedValueOnce(jsonResponse(page2));
    const accounts = await listSmartleadAccounts(KEY);
    expect(accounts).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = String(fetchMock.mock.calls[0]![0]);
    expect(firstUrl).toContain("/email-accounts/");
    expect(firstUrl).toContain("offset=0");
    expect(String(fetchMock.mock.calls[1]![0])).toContain("offset=100");
  });

  it("strips password fields — the serialized result never contains them", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([rawAccount(1, "jane@acme.com")]));
    const accounts = await listSmartleadAccounts(KEY);
    const serialized = JSON.stringify(accounts);
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("cGFzc3dvcmQtc2VjcmV0");
    expect(serialized).not.toContain("c210cC1zZWNyZXQ=");
    expect(accounts[0]).toEqual({
      id: 1,
      fromEmail: "jane@acme.com",
      fromName: "Jane",
      messagePerDay: 30,
      dailySentCount: 3,
      isSmtpSuccess: true,
      type: "SMTP",
      warmupStatus: "ACTIVE",
      warmupReputation: "95%",
    });
  });

  it("lowercases from_email and drops rows without id/from_email", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([rawAccount(1, "Jane@ACME.com"), { junk: true }, rawAccount(2, "")]),
    );
    const accounts = await listSmartleadAccounts(KEY);
    expect(accounts.map((a) => a.fromEmail)).toEqual(["jane@acme.com"]);
  });

  it("errors carry the HTTP status but never the api key", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad key" }, 401));
    const err = await listSmartleadAccounts(KEY).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("401");
    expect((err as Error).message).toContain("/email-accounts/");
    expect((err as Error).message).not.toContain(KEY);
    expect((err as Error).message).not.toContain("SECRETKEY");
  });

  it("throws without any key", async () => {
    const prev = process.env["SMARTLEAD_API_KEY"];
    delete process.env["SMARTLEAD_API_KEY"];
    try {
      await expect(listSmartleadAccounts()).rejects.toThrow(/no Smartlead API key/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env["SMARTLEAD_API_KEY"] = prev;
    }
  });

  it("times out a hung fetch with a deadline error (no key in the message)", async () => {
    vi.useFakeTimers();
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    const pending = listSmartleadAccounts(KEY);
    const settled = pending.catch((e: Error) => e);
    await vi.advanceTimersByTime(31_000);
    await new Promise(process.nextTick);
    const err = await settled;
    expect((err as Error).message).toMatch(/deadline exceeded/);
    expect((err as Error).message).not.toContain(KEY);
  });
});

describe("sendViaSmartlead", () => {
  it("POSTs to /send-email/initiate with the documented field names", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { message: "Email sent", message_id: "msg_abc" } }),
    );
    const res = await sendViaSmartlead(
      {
        to: "founder@startup.com",
        subject: "hey",
        htmlBody: "<p>hi</p>",
        fromEmail: "jane@acme.com",
        fromName: "Jane Doe",
      },
      KEY,
    );
    expect(res.messageId).toBe("msg_abc");
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toContain("/send-email/initiate");
    expect(init.method).toBe("POST");
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload).toEqual({
      to: "founder@startup.com",
      subject: "hey",
      body: "<p>hi</p>",
      fromEmail: "jane@acme.com",
      fromName: "Jane Doe",
    });
  });

  it("falls back to a unique smartlead: id when the response has no message id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    const res = await sendViaSmartlead(
      { to: "a@b.com", subject: "s", htmlBody: "b", fromEmail: "jane@acme.com" },
      KEY,
    );
    expect(res.messageId).toMatch(/^smartlead:[0-9a-f-]{36}$/);
  });

  it("surfaces upstream failures with status, without the key", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "quota" }, 429));
    const err = await sendViaSmartlead(
      { to: "a@b.com", subject: "s", htmlBody: "b", fromEmail: "jane@acme.com" },
      KEY,
    ).catch((e: Error) => e);
    expect((err as Error).message).toContain("429");
    expect((err as Error).message).not.toContain(KEY);
  });
});
