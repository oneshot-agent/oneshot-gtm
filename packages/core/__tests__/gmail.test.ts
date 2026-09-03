import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetGmailCache,
  buildRawMessage,
  getGmailAccessToken,
  getGmailProfile,
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

  it("emits In-Reply-To and References headers for a threaded reply", () => {
    const msg = decodeRaw(
      buildRawMessage({
        to: "prospect@acme.com",
        fromEmail: "jane@gmail.com",
        fromName: "Jane Doe",
        subject: "Re: quick question",
        htmlBody: "b",
        inReplyTo: "<abc123@mail.gmail.com>",
        references: ["<abc123@mail.gmail.com>"],
      }),
    );
    expect(msg).toMatch(/^In-Reply-To: <abc123@mail\.gmail\.com>$/m);
    expect(msg).toMatch(/^References: <abc123@mail\.gmail\.com>$/m);
  });

  it("omits threading headers when not provided", () => {
    const msg = decodeRaw(
      buildRawMessage({
        to: "a@b.com",
        fromEmail: "j@g.com",
        fromName: null,
        subject: "s",
        htmlBody: "b",
      }),
    );
    expect(msg).not.toMatch(/^In-Reply-To:/m);
    expect(msg).not.toMatch(/^References:/m);
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

describe("gmailJson error formatting", () => {
  // A representative Google quota envelope — same shape and metric wording
  // as the truncated production sample from issue #485.
  const QUOTA_BODY = JSON.stringify({
    error: {
      code: 403,
      message:
        "Quota exceeded for quota metric 'Gmail API requests' and limit " +
        "'Requests per minute per user' of service 'gmail.googleapis.com' " +
        "for consumer 'project_number:123456789'.",
      status: "RESOURCE_EXHAUSTED",
      errors: [{ message: "Quota exceeded", domain: "global", reason: "rateLimitExceeded" }],
    },
  });

  function stubFetchWith(body: string, status: number): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).startsWith("https://oauth2.googleapis.com/")) return tokenResponse();
      return new Response(body, { status });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("surfaces error.status and the compacted quota metric/limit for a parseable Google error envelope", async () => {
    stubFetchWith(QUOTA_BODY, 403);
    await expect(getGmailProfile()).rejects.toThrow(
      /Gmail API failed \(403\): RESOURCE_EXHAUSTED — quota metric 'Gmail API requests' \/ limit 'Requests per minute per user'/,
    );
  });

  it("keeps both the quota metric AND the specific limit legible within the existing 120-char log convention, even on listGmailReplies' /messages/<id> path — the issue's own reproduction and the dominant real-world caller (longer than /profile)", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://oauth2.googleapis.com/")) return tokenResponse();
      if (u.includes("/messages?")) {
        return new Response(JSON.stringify({ messages: [{ id: "18c2a9f4e6b7d3a1" }] }), {
          status: 200,
        });
      }
      // /messages/18c2a9f4e6b7d3a1?format=full — the long path in question.
      return new Response(QUOTA_BODY, { status: 403 });
    });
    vi.stubGlobal("fetch", fetchMock);
    let message = "";
    try {
      await listGmailReplies({ limit: 10 });
    } catch (err) {
      message = (err as Error).message;
    }
    // Mirrors the message_120 truncation every call site applies (e.g.
    // oneshot.ts's inbox.source_failed logging) — this is the actual
    // acceptance bar, not just "the untruncated message is fine".
    const truncated = message.slice(0, 120);
    expect(truncated).toContain("RESOURCE_EXHAUSTED");
    // Both facts the issue calls out as necessary for diagnosis: WHICH
    // metric, and WHICH specific limit (per-user-per-second vs
    // per-minute-per-user vs the daily project ceiling) — not just the
    // coarser status.
    expect(truncated).toContain("quota metric 'Gmail API requests'");
    expect(truncated).toContain("limit 'Requests per minute per user'");
  });

  it("keeps the quota metric name legible within the existing 120-char log convention", async () => {
    stubFetchWith(QUOTA_BODY, 403);
    let message = "";
    try {
      await getGmailProfile();
    } catch (err) {
      message = (err as Error).message;
    }
    // Mirrors the message_120 truncation every call site applies (e.g.
    // oneshot.ts's inbox.source_failed logging) — this is the actual
    // acceptance bar, not just "the untruncated message is fine".
    const truncated = message.slice(0, 120);
    expect(truncated).toContain("RESOURCE_EXHAUSTED");
    expect(truncated).toContain("quota metric 'Gmail API requests'");
  });

  it("distinguishes a permission/scope failure from a quota failure by error.status", async () => {
    stubFetchWith(
      JSON.stringify({
        error: {
          code: 403,
          message: "The caller does not have permission",
          status: "PERMISSION_DENIED",
        },
      }),
      403,
    );
    await expect(getGmailProfile()).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it("falls back to the raw-slice behaviour when the body does not parse as Google's envelope", async () => {
    stubFetchWith("<html>502 Bad Gateway</html>", 502);
    await expect(getGmailProfile()).rejects.toThrow(
      "Gmail API failed (502): <html>502 Bad Gateway</html> [/profile]",
    );
  });

  it("falls back to the raw-slice behaviour when the JSON body has no error.message", async () => {
    stubFetchWith(JSON.stringify({ error: { code: 500 } }), 500);
    await expect(getGmailProfile()).rejects.toThrow(
      `Gmail API failed (500): ${JSON.stringify({ error: { code: 500 } })} [/profile]`,
    );
  });

  it("keeps the 401 branch unchanged — no body parsing, no status field", async () => {
    stubFetchWith(QUOTA_BODY, 401);
    await expect(getGmailProfile()).rejects.toThrow(/^Gmail auth rejected \(401\) —/);
  });

  it("does not read the response body on a 401 (auth errors must not wait on a slow body)", async () => {
    const textSpy = vi.fn().mockResolvedValue(QUOTA_BODY);
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).startsWith("https://oauth2.googleapis.com/")) return tokenResponse();
      return { ok: false, status: 401, text: textSpy } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(getGmailProfile()).rejects.toThrow(/^Gmail auth rejected \(401\) —/);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("cancels an unread body's stream on a 401 instead of leaving it open", async () => {
    // cancel() always returns a Promise per the ReadableStream spec — a
    // mock that returned undefined would let a `.catch()` on the call
    // site go unexercised, so resolve it like the real API does.
    const cancelSpy = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).startsWith("https://oauth2.googleapis.com/")) return tokenResponse();
      return {
        ok: false,
        status: 401,
        text: vi.fn(),
        body: { cancel: cancelSpy },
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(getGmailProfile()).rejects.toThrow(/^Gmail auth rejected \(401\) —/);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it("does not throw an unhandled rejection when a 401 body's cancel() rejects", async () => {
    const cancelSpy = vi.fn().mockRejectedValue(new Error("stream already locked"));
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).startsWith("https://oauth2.googleapis.com/")) return tokenResponse();
      return {
        ok: false,
        status: 401,
        text: vi.fn(),
        body: { cancel: cancelSpy },
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(getGmailProfile()).rejects.toThrow(/^Gmail auth rejected \(401\) —/);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it("does not blow up on a 401 when the response has no body at all", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).startsWith("https://oauth2.googleapis.com/")) return tokenResponse();
      return { ok: false, status: 401, text: vi.fn(), body: undefined } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(getGmailProfile()).rejects.toThrow(/^Gmail auth rejected \(401\) —/);
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

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

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
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
        ),
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
      if (u.startsWith("https://oauth2.googleapis.com/")) return tokenResponse();
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
                { name: "Message-ID", value: "<pat-msg-1@mail.acme.com>" },
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
      // Captured for In-Reply-To/References on a threaded reply.
      message_id: "<pat-msg-1@mail.acme.com>",
    });
    // Query excludes the founder's own sends at the source.
    const listCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/messages?"));
    expect(decodeURIComponent(String(listCall![0]))).toContain("-from:me");
  });

  it("returns an empty result when the inbox has no matches", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).startsWith("https://oauth2.googleapis.com/")) return tokenResponse();
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await listGmailReplies();
    expect(out.emails).toEqual([]);
    expect(out.count).toBe(0);
  });

  /**
   * Serve one message with the given payload/snippet and return its extracted
   * body. The body-extraction tiers below are the regression suite for the
   * "(no body)" bug: our outbound is HTML-only, reply clients mirror the
   * format, so HTML-only replies are the NORMAL case — and the old extractor
   * only ever read text/plain.
   */
  async function bodyFor(payload: unknown, snippet?: string): Promise<string> {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://oauth2.googleapis.com/")) return tokenResponse();
      if (u.includes("/messages?")) {
        return new Response(JSON.stringify({ messages: [{ id: "m1" }] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          id: "m1",
          threadId: "t1",
          internalDate: String(Date.UTC(2026, 5, 10)),
          ...(snippet ? { snippet } : {}),
          payload,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await listGmailReplies({ limit: 10 });
    return out.emails[0]?.body ?? "";
  }

  it("extracts a single-part text/html body, de-tagged", async () => {
    const body = await bodyFor({
      mimeType: "text/html",
      headers: [{ name: "From", value: "a@b.dev" }],
      body: { data: b64("<div>Thursday works.<br>— Jane</div>") },
    });
    expect(body).toBe("Thursday works.\n— Jane");
  });

  it("extracts HTML from multipart/alternative that carries ONLY html", async () => {
    const body = await bodyFor({
      mimeType: "multipart/alternative",
      headers: [{ name: "From", value: "a@b.dev" }],
      parts: [{ mimeType: "text/html", body: { data: b64("<p>only html here</p>") } }],
    });
    expect(body).toBe("only html here");
  });

  it("finds HTML nested inside multipart/related", async () => {
    const body = await bodyFor({
      mimeType: "multipart/mixed",
      headers: [{ name: "From", value: "a@b.dev" }],
      parts: [
        {
          mimeType: "multipart/related",
          parts: [{ mimeType: "text/html", body: { data: b64("<p>nested</p>") } }],
        },
      ],
    });
    expect(body).toBe("nested");
  });

  it("does not let a whitespace-only text/plain part mask the HTML alternative", async () => {
    const body = await bodyFor({
      mimeType: "multipart/alternative",
      headers: [{ name: "From", value: "a@b.dev" }],
      parts: [
        { mimeType: "text/plain", body: { data: b64(" \n \n") } },
        { mimeType: "text/html", body: { data: b64("<p>the real content</p>") } },
      ],
    });
    expect(body).toBe("the real content");
  });

  it("still prefers text/plain when both parts exist", async () => {
    const body = await bodyFor({
      mimeType: "multipart/alternative",
      headers: [{ name: "From", value: "a@b.dev" }],
      parts: [
        { mimeType: "text/plain", body: { data: b64("plain wins") } },
        { mimeType: "text/html", body: { data: b64("<p>html loses</p>") } },
      ],
    });
    expect(body).toBe("plain wins");
  });

  it("falls back to the snippet when the HTML converts to empty text (image-only mail)", async () => {
    const body = await bodyFor(
      {
        mimeType: "text/html",
        headers: [{ name: "From", value: "a@b.dev" }],
        body: { data: b64('<div><img src="cid:logo"></div>') },
      },
      "the snippet says this",
    );
    expect(body).toBe("the snippet says this");
  });

  it("falls back to Gmail's snippet when no part carries decodable data", async () => {
    const body = await bodyFor(
      {
        mimeType: "multipart/mixed",
        headers: [{ name: "From", value: "a@b.dev" }],
        parts: [{ mimeType: "text/html", body: {} }],
      },
      "snippet preview text",
    );
    expect(body).toBe("snippet preview text");
  });

  it("reports has_more when Gmail returns a nextPageToken", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://oauth2.googleapis.com/")) return tokenResponse();
      if (u.includes("/messages?")) {
        return new Response(JSON.stringify({ messages: [{ id: "m1" }], nextPageToken: "tok" }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          id: "m1",
          threadId: "t1",
          internalDate: String(Date.UTC(2026, 5, 10)),
          payload: {
            mimeType: "text/plain",
            headers: [{ name: "From", value: "a@b.dev" }],
            body: { data: Buffer.from("hi", "utf8").toString("base64url") },
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await listGmailReplies({ limit: 10 });
    expect(out.has_more).toBe(true);
  });
});
