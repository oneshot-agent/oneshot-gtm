import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Provider dispatch test: with emailProvider=gmail, sendEmail/listInbox must
// route to the Gmail REST path (mocked fetch) and never construct the OneShot
// SDK agent. Config + ledger are mocked so no real ~/.oneshot-gtm is touched.

const recordReceipt = vi.fn().mockReturnValue(42);
const assignSender = vi.fn((_email: string, identityId: string) => identityId);
// Per-test config + token-store overrides (merged over the real loadConfig output).
let cfgOverride: Record<string, unknown> = {};
let tokenStoreOverride: Record<string, { refreshToken: string; address: string }> = {};

vi.mock("../src/config.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
  return {
    ...actual,
    loadConfig: () => ({
      ...actual.loadConfig(),
      emailProvider: "gmail",
      emailIdentities: null,
      founderName: "Jane Doe",
      ...cfgOverride,
    }),
    // Keep the token store out of the real ~/.oneshot-gtm.
    loadGmailTokens: () => tokenStoreOverride,
  };
});

vi.mock("../src/ledger.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/ledger.ts")>("../src/ledger.ts");
  return {
    ...actual,
    getLedger: () => ({
      recordReceipt,
      // Rotation routing dependencies: fresh prospect, no pins, no history.
      getSenderAssignment: () => null,
      hasPriorEmailSend: () => false,
      assignSender,
      countEmailSendsSince: () => 0,
      firstEmailSendAt: () => null,
    }),
  };
});

const { sendEmail, listInbox } = await import("../src/oneshot.ts");
const { _resetGmailCache } = await import("../src/gmail.ts");

const GMAIL_KEYS = ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"] as const;
let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  envSnapshot = {};
  for (const k of GMAIL_KEYS) {
    envSnapshot[k] = process.env[k];
    process.env[k] = "test";
  }
  _resetGmailCache();
  recordReceipt.mockClear();
  cfgOverride = {};
  tokenStoreOverride = {};
});

afterEach(() => {
  for (const k of GMAIL_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  _resetGmailCache();
  vi.unstubAllGlobals();
});

function mkMsg(id: string, at: string) {
  return {
    id,
    threadId: `t-${id}`,
    internalDate: String(new Date(at).getTime()),
    payload: {
      headers: [
        { name: "From", value: `${id}@p.com` },
        { name: "Subject", value: `re ${id}` },
      ],
    },
  };
}

function stubGmailFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), {
        status: 200,
      });
    }
    if (u.endsWith("/profile")) {
      return new Response(JSON.stringify({ emailAddress: "jane@gmail.com" }), { status: 200 });
    }
    if (u.endsWith("/messages/send")) {
      return new Response(JSON.stringify({ id: "gm-123", threadId: "th-1" }), { status: 200 });
    }
    if (u.includes("/messages?")) {
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("sendEmail — gmail provider dispatch", () => {
  it("sends via Gmail, records a cost-0 receipt, and returns a compatible shape", async () => {
    const fetchMock = stubGmailFetch();
    const out = await sendEmail(
      { to: "pat@acme.com", subject: "hi", body: "line one\nline two" },
      { playName: "show-hn" },
    );

    expect(out.receiptId).toBe(42);
    expect(out.result.cost).toBe(0);
    expect(out.result.request_id).toBe("gm-123");
    expect(recordReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        playName: "show-hn",
        callType: "email.send",
        costUsd: 0,
        oneshotRequestId: "gm-123",
        signedReceipt: expect.objectContaining({ provider: "gmail", thread_id: "th-1" }),
      }),
    );

    // From = authenticated account with founder display name; body html-ified.
    const sendCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/messages/send"));
    const { raw } = JSON.parse(String((sendCall![1] as RequestInit).body)) as { raw: string };
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain('From: "Jane Doe" <jane@gmail.com>');
    expect(mime).toContain("line one<br>\nline two");
  });
});

describe("listInbox — gmail provider dispatch", () => {
  it("routes to the Gmail replies path", async () => {
    stubGmailFetch();
    const out = await listInbox({ limit: 5 });
    expect(out.agent_id).toBe("gmail");
    expect(out.emails).toEqual([]);
  });
});

describe("listInbox — multi-identity merge", () => {
  it("one failing source doesn't blind the others (oneshot fails, gmail still polls)", async () => {
    // Pool: one oneshot identity (will fail — no wallet creds in test env)
    // and one gmail identity (mocked fetch succeeds).
    cfgOverride = {
      emailIdentities: [
        { id: "os-1", provider: "oneshot", sendingDomain: "x.com", maxPerDay: null, warmup: null },
        { id: "gmail:jane@gmail.com", provider: "gmail", maxPerDay: 50, warmup: null },
      ],
    };
    tokenStoreOverride = {
      "gmail:jane@gmail.com": { refreshToken: "rt-jane", address: "jane@gmail.com" },
    };
    stubGmailFetch();
    const out = await listInbox({ limit: 10 });
    expect(out.agent_id).toBe("gmail");
    expect(out.emails).toEqual([]);
  });

  it("merges two gmail accounts, dedupes by id, sorts newest-first", async () => {
    cfgOverride = {
      emailIdentities: [
        { id: "gmail:a@x.com", provider: "gmail", maxPerDay: 50, warmup: null },
        { id: "gmail:b@x.com", provider: "gmail", maxPerDay: 50, warmup: null },
      ],
    };
    // Distinct refresh tokens per account → distinct access tokens → the list
    // endpoint can identify the caller by Authorization header. No reliance on
    // call ordering, which is nondeterministic under the merge's parallelMap.
    tokenStoreOverride = {
      "gmail:a@x.com": { refreshToken: "rt-a", address: "a@x.com" },
      "gmail:b@x.com": { refreshToken: "rt-b", address: "b@x.com" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("oauth2.googleapis.com")) {
          const refresh = new URLSearchParams(String(init?.body)).get("refresh_token");
          return new Response(
            JSON.stringify({ access_token: `at-${refresh}`, expires_in: 3600 }),
            { status: 200 },
          );
        }
        const auth = String((init?.headers as Record<string, string>)?.["Authorization"] ?? "");
        if (u.includes("/messages?")) {
          // Both accounts see the shared m-dup plus one unique message each.
          const unique = auth.endsWith("at-rt-a") ? "m-old" : "m-new";
          return new Response(JSON.stringify({ messages: [{ id: "m-dup" }, { id: unique }] }), {
            status: 200,
          });
        }
        if (u.includes("/messages/m-dup")) {
          return new Response(JSON.stringify(mkMsg("m-dup", "2026-06-10T10:00:00Z")), {
            status: 200,
          });
        }
        if (u.includes("/messages/m-old")) {
          return new Response(JSON.stringify(mkMsg("m-old", "2026-06-09T10:00:00Z")), {
            status: 200,
          });
        }
        if (u.includes("/messages/m-new")) {
          return new Response(JSON.stringify(mkMsg("m-new", "2026-06-11T10:00:00Z")), {
            status: 200,
          });
        }
        throw new Error(`unexpected fetch: ${u}`);
      }),
    );
    const out = await listInbox({ limit: 10 });
    expect(out.emails.map((e) => e.id)).toEqual(["m-new", "m-dup", "m-old"]);
    expect(out.agent_id).toBe("gmail+gmail");
  });
});
