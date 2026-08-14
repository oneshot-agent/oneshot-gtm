import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetGmailCache, listGmailBounces } from "../src/gmail.ts";

// Pagination for the bounce sweep. Stopping at the first Gmail results page
// leaves hard-bounced recipients unsuppressed AND reports a falsely low bounce
// rate — a silent undercount, the worst failure mode for a check whose job is
// to notice trouble.

const GMAIL_KEYS = ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"] as const;
let envSnapshot: Record<string, string | undefined> = {};
let listCalls: string[] = [];

/** A DSN payload naming one dead address, keyed by message id. */
function dsnMessage(id: string) {
  const report = [
    `Final-Recipient: rfc822; dead-${id}@corp.example`,
    "Action: failed",
    "Status: 5.1.1",
  ].join("\r\n");
  return {
    id,
    threadId: `t-${id}`,
    internalDate: "1755000000000",
    payload: {
      mimeType: "multipart/report",
      headers: [{ name: "From", value: "mailer-daemon@googlemail.com" }],
      parts: [
        {
          mimeType: "message/delivery-status",
          body: { data: Buffer.from(report).toString("base64url") },
        },
      ],
    },
  };
}

/** Serves `pages` of ids, each page linking to the next. */
function stubGmail(pages: string[][]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      const parsed = new URL(u);
      // Matched on the parsed hostname, not a substring: `includes()` would
      // also match a URL that merely mentions the host elsewhere in its path
      // or query, which is exactly the routing bug this stub would then hide.
      if (parsed.hostname === "oauth2.googleapis.com") {
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), {
          status: 200,
        });
      }
      if (parsed.pathname.endsWith("/messages")) {
        listCalls.push(u);
        const token = parsed.searchParams.get("pageToken");
        const index = token ? Number(token) : 0;
        const ids = pages[index] ?? [];
        const hasNext = index + 1 < pages.length;
        return new Response(
          JSON.stringify({
            messages: ids.map((id) => ({ id })),
            ...(hasNext ? { nextPageToken: String(index + 1) } : {}),
          }),
          { status: 200 },
        );
      }
      const id = parsed.pathname.split("/messages/")[1] ?? "x";
      return new Response(JSON.stringify(dsnMessage(id)), { status: 200 });
    }),
  );
}

beforeEach(() => {
  envSnapshot = {};
  for (const k of GMAIL_KEYS) {
    envSnapshot[k] = process.env[k];
    process.env[k] = "test";
  }
  listCalls = [];
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

describe("listGmailBounces pagination", () => {
  it("follows nextPageToken across every page", async () => {
    stubGmail([["a1", "a2"], ["b1", "b2"], ["c1"]]);
    const bounces = await listGmailBounces(undefined, { id: "acct", refreshToken: "rt" });

    expect(bounces).toHaveLength(5);
    expect(bounces.map((b) => b.messageId).toSorted()).toEqual(["a1", "a2", "b1", "b2", "c1"]);
    expect(listCalls).toHaveLength(3);
  });

  it("stops after a single page when there is no next token", async () => {
    stubGmail([["only1", "only2"]]);
    const bounces = await listGmailBounces(undefined, { id: "acct", refreshToken: "rt" });

    expect(bounces).toHaveLength(2);
    expect(listCalls).toHaveLength(1);
  });

  it("handles an empty mailbox without paging", async () => {
    stubGmail([[]]);
    expect(await listGmailBounces(undefined, { id: "acct", refreshToken: "rt" })).toEqual([]);
    expect(listCalls).toHaveLength(1);
  });

  it("honours the total limit rather than walking an endless mailbox", async () => {
    // Every page advertises a next token; the cap is what terminates the walk.
    stubGmail([["a"], ["b"], ["c"], ["d"], ["e"], ["f"]]);
    const bounces = await listGmailBounces({ limit: 3 }, { id: "acct", refreshToken: "rt" });
    expect(bounces.length).toBeLessThanOrEqual(3);
    expect(listCalls.length).toBeLessThanOrEqual(3);
  });

  it("never requests a page larger than the Gmail per-page maximum", async () => {
    stubGmail([["a"]]);
    await listGmailBounces({ limit: 5000 }, { id: "acct", refreshToken: "rt" });
    const maxResults = new URL(listCalls[0]!).searchParams.get("maxResults");
    expect(Number(maxResults)).toBeLessThanOrEqual(100);
  });
});
