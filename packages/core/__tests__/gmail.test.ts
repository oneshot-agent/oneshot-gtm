import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetGmailCache,
  buildRawMessage,
  getGmailAccessToken,
  listGmailReplies,
  missingGmailSecrets,
} from "../src/gmail.ts";

const GMAIL_KEYS = ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"] as const;
let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  envSnapshot = {};
  for (const k of GMAIL_KEYS) {
    envSnapshot[k] = process.env[k];
    process.env[k] = `test-${k.toLowerCase()}`;
  }
  _resetGmailCache();
});

afterEach(() => {
  for (const k of GMAIL_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  _resetGmailCache();
  vi.unstubAllGlobals();
});

function decodeRaw(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

describe("buildRawMessage", () => {
  it("round-trips through base64url with the expected headers", () => {
    const msg = decodeRaw(
      buildRawMessage({
        to: "prospect@acme.com",
        fromEmail: "jane@gmail.com",
        fromName: "Jane Doe",
        subject: "quick question",
        htmlBody: "hello<br>\nworld",
      }),
    );
    expect(msg).toContain('From: "Jane Doe" <jane@gmail.com>');
    expect(msg).toContain("To: prospect@acme.com");
    expect(msg).toContain("Subject: quick question");
    expect(msg).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(msg.endsWith("hello<br>\nworld")).toBe(true);
  });

  it("omits the display-name clause when fromName is empty", () => {
    const msg = decodeRaw(
      buildRawMessage({
        to: "a@b.com",
        fromEmail: "jane@gmail.com",
        fromName: null,
        subject: "s",
        htmlBody: "b",
      }),
    );
    expect(msg).toContain("From: jane@gmail.com");
    expect(msg).not.toContain('From: "');
  });

  it("strips CR/LF from header values (header injection)", () => {
    const msg = decodeRaw(
      buildRawMessage({
        to: "a@b.com\r\nBcc: evil@x.com",
        fromEmail: "jane@gmail.com",
        fromName: "Jane\r\nReply-To: evil@x.com",
        subject: "hi\r\nX-Spam: yes",
        htmlBody: "b",
      }),
    );
    // The CR/LF is folded into a space, so the injected text stays INSIDE the
    // original header's value instead of becoming its own header line.
    expect(msg).not.toMatch(/^Bcc:/m);
    expect(msg).not.toMatch(/^Reply-To:/m);
    expect(msg).not.toMatch(/^X-Spam:/m);
    expect(msg).toContain("To: a@b.com Bcc: evil@x.com");
  });

  it("RFC 2047-encodes a non-ASCII subject", () => {
    const subject = "métricas página";
    const msg = decodeRaw(
      buildRawMessage({
        to: "a@b.com",
        fromEmail: "j@g.com",
        fromName: null,
        subject,
        htmlBody: "b",
      }),
    );
    const expected = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
    expect(msg).toContain(`Subject: ${expected}`);
  });
});

describe("missingGmailSecrets", () => {
  it("returns [] when all three are set", () => {
    expect(missingGmailSecrets()).toEqual([]);
  });

  it("lists each unset key", () => {
    delete process.env["GMAIL_REFRESH_TOKEN"];
    process.env["GMAIL_CLIENT_SECRET"] = "  ";
    expect(missingGmailSecrets()).toEqual(["GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"]);
  });
});

function tokenResponse(token = "at-1", expiresIn = 3600): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
    status: 200,
  });
}

describe("getGmailAccessToken", () => {
  it("caches the access token across calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse());
    vi.stubGlobal("fetch", fetchMock);
    expect(await getGmailAccessToken()).toBe("at-1");
    expect(await getGmailAccessToken()).toBe("at-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-refreshes once the cached token is within the expiry skew", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("at-1", 30)) // expires inside the 60s skew
      .mockResolvedValueOnce(tokenResponse("at-2"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getGmailAccessToken()).toBe("at-1");
    expect(await getGmailAccessToken()).toBe("at-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps invalid_grant to an actionable re-auth message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
    );
    await expect(getGmailAccessToken()).rejects.toThrow(/gmail auth/);
  });

  it("names the missing secrets when credentials are absent", async () => {
    delete process.env["GMAIL_REFRESH_TOKEN"];
    await expect(getGmailAccessToken()).rejects.toThrow(/GMAIL_REFRESH_TOKEN/);
  });
});

describe("listGmailReplies", () => {
  it("maps Gmail messages to the OneShot inbox contract", async () => {
    const internalDate = Date.UTC(2026, 5, 10, 12, 0, 0);
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com")) return tokenResponse();
      if (u.includes("/messages?")) {
        return new Response(JSON.stringify({ messages: [{ id: "m1" }] }), { status: 200 });
      }
      if (u.includes("/messages/m1")) {
        return new Response(
          JSON.stringify({
            id: "m1",
            threadId: "t1",
            internalDate: String(internalDate),
            payload: {
              mimeType: "multipart/alternative",
              headers: [
                { name: "From", value: "Pat Prospect <pat@acme.com>" },
                { name: "Subject", value: "Re: quick question" },
              ],
              parts: [
                {
                  mimeType: "text/plain",
                  body: { data: Buffer.from("sounds good!", "utf8").toString("base64url") },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await listGmailReplies({ limit: 10 });
    expect(out.agent_id).toBe("gmail");
    expect(out.count).toBe(1);
    expect(out.emails[0]).toMatchObject({
      id: "m1",
      from: "Pat Prospect <pat@acme.com>",
      subject: "Re: quick question",
      received_at: new Date(internalDate).toISOString(),
      thread_id: "t1",
      body: "sounds good!",
    });
    // Query excludes the founder's own sends at the source.
    const listCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/messages?"));
    expect(decodeURIComponent(String(listCall![0]))).toContain("-from:me");
  });

  it("returns an empty result when the inbox has no matches", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes("oauth2.googleapis.com")) return tokenResponse();
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await listGmailReplies();
    expect(out.emails).toEqual([]);
    expect(out.count).toBe(0);
  });
});
