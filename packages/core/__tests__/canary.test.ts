import { beforeEach, describe, expect, it, vi } from "vitest";

// Drives the inbox-placement canary: pick two mailboxes, send a real message,
// then look up where the RECEIVING account filed it. This is the only path that
// can distinguish "accepted" from "accepted and filtered into spam".

type Identity = {
  id: string;
  provider: string;
  address: string | null;
  maxPerDay: number | null;
  warmup: null;
};

let identities: Identity[] = [];
/** Queue of findPlacedMessage results — one shift per poll. */
let pollResults: Array<null | {
  id: string;
  labelIds: string[];
  placement: string;
  auth: { spf: string; dkim: string; dmarc: string };
  receivedAt: string;
}> = [];
let sentMessages: Array<{ to: string; fromEmail: string; subject: string; htmlBody: string }> = [];
let recordedCanaries: unknown[] = [];
let realCopy: { subject: string; body: string; playName: string } | null = null;
let sentMessageIdResult: string | null = "<CAB123@mail.gmail.com>";
let lastQuery = "";
let pollCount = 0;

vi.mock("../src/config.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
  return {
    ...actual,
    loadConfig: () => ({
      ...actual.loadConfig(),
      founderName: "Jane Doe",
      productOneLiner: "a thing",
    }),
  };
});

vi.mock("../src/identities.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../src/identities.ts")>("../src/identities.ts");
  return {
    ...actual,
    resolveIdentities: () => identities,
    gmailAccountFor: (i: Identity) => ({ id: i.id, refreshToken: "rt" }),
  };
});

vi.mock("../src/gmail.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/gmail.ts")>("../src/gmail.ts");
  return {
    ...actual,
    sendGmailMessage: async (input: {
      to: string;
      fromEmail: string;
      subject: string;
      htmlBody: string;
    }) => {
      sentMessages.push(input);
      return { id: "sent-1", threadId: "t-1" };
    },
    getSentMessageId: async () => sentMessageIdResult,
    findPlacedMessage: async (query: string) => {
      lastQuery = query;
      pollCount++;
      return pollResults.shift() ?? null;
    },
    getGmailProfile: async () => ({ emailAddress: "fallback@corp.example" }),
  };
});

vi.mock("../src/ledger.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/ledger.ts")>("../src/ledger.ts");
  return {
    ...actual,
    getLedger: () => ({
      latestSentEmailCopy: () => realCopy,
      recordCanaryResult: (r: unknown) => {
        recordedCanaries.push(r);
        return 1;
      },
    }),
  };
});

const { runPlacementCanary, resolveCanaryPair } = await import("../src/canary.ts");
const { classifyPlacement } = await import("../src/gmail.ts");

const noSleep = async (): Promise<void> => undefined;

function gmailIdentity(id: string, address: string): Identity {
  return { id, provider: "gmail", address, maxPerDay: 40, warmup: null };
}

function placed(labelIds: string[], auth = { spf: "pass", dkim: "pass", dmarc: "pass" }) {
  return {
    id: "recv-1",
    labelIds,
    placement: classifyPlacement(labelIds),
    auth,
    receivedAt: "2026-08-13T10:00:00.000Z",
  };
}

beforeEach(() => {
  identities = [
    gmailIdentity("gmail:a@one.example", "a@one.example"),
    gmailIdentity("gmail:b@two.example", "b@two.example"),
  ];
  pollResults = [];
  sentMessages = [];
  recordedCanaries = [];
  realCopy = null;
  sentMessageIdResult = "<CAB123@mail.gmail.com>";
  lastQuery = "";
  pollCount = 0;
});

describe("resolveCanaryPair", () => {
  it("refuses when only one Gmail account is connected", () => {
    // A self-send is never filtered, so a single account would always read
    // "inbox" and mean nothing.
    identities = [gmailIdentity("gmail:a@one.example", "a@one.example")];
    expect(() => resolveCanaryPair()).toThrow(/two authorized Gmail accounts/);
  });

  it("refuses when no Gmail account is connected", () => {
    identities = [];
    expect(() => resolveCanaryPair()).toThrow(/two authorized Gmail accounts/);
  });

  it("ignores non-Gmail identities when counting", () => {
    identities = [
      gmailIdentity("gmail:a@one.example", "a@one.example"),
      { id: "oneshot:x", provider: "oneshot", address: null, maxPerDay: null, warmup: null },
    ];
    expect(() => resolveCanaryPair()).toThrow(/found 1/);
  });

  it("defaults to the first two identities", () => {
    const { from, to } = resolveCanaryPair();
    expect(from.id).toBe("gmail:a@one.example");
    expect(to.id).toBe("gmail:b@two.example");
  });

  it("honours explicit ids", () => {
    const { from, to } = resolveCanaryPair({
      fromIdentityId: "gmail:b@two.example",
      toIdentityId: "gmail:a@one.example",
    });
    expect(from.id).toBe("gmail:b@two.example");
    expect(to.id).toBe("gmail:a@one.example");
  });

  it("refuses an explicit self-send", () => {
    expect(() =>
      resolveCanaryPair({
        fromIdentityId: "gmail:a@one.example",
        toIdentityId: "gmail:a@one.example",
      }),
    ).toThrow(/self-send/);
  });

  it("rejects an unknown identity id", () => {
    expect(() => resolveCanaryPair({ fromIdentityId: "gmail:nope" })).toThrow(/no Gmail identity/);
  });
});

describe("runPlacementCanary", () => {
  it("reports a clean inbox delivery", async () => {
    pollResults = [placed(["INBOX", "CATEGORY_PERSONAL"])];
    const result = await runPlacementCanary({ sleep: noSleep });

    expect(result.placement).toBe("inbox");
    expect(result.fromAddress).toBe("a@one.example");
    expect(result.toAddress).toBe("b@two.example");
    expect(result.auth).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass" });
  });

  it("reports spam — the outcome the test exists to catch", async () => {
    pollResults = [placed(["SPAM"], { spf: "fail", dkim: "none", dmarc: "fail" })];
    const result = await runPlacementCanary({ sleep: noSleep });

    expect(result.placement).toBe("spam");
    expect(result.auth.dmarc).toBe("fail");
  });

  it("reports Promotions rather than calling a tab-binned message delivered", async () => {
    pollResults = [placed(["INBOX", "CATEGORY_PROMOTIONS"])];
    expect((await runPlacementCanary({ sleep: noSleep })).placement).toBe("promotions");
  });

  it("searches by the Message-ID Gmail actually assigned", async () => {
    // Gmail rewrites any Message-ID we supply, so the id must be read back off
    // the sent copy or the receiving-side lookup matches nothing.
    pollResults = [placed(["INBOX"])];
    await runPlacementCanary({ sleep: noSleep });
    expect(lastQuery).toBe("rfc822msgid:CAB123@mail.gmail.com");
  });

  it("falls back to a subject+sender query when the Message-ID can't be read", async () => {
    sentMessageIdResult = null;
    pollResults = [placed(["INBOX"])];
    await runPlacementCanary({ sleep: noSleep });
    expect(lastQuery).toContain("from:a@one.example");
    expect(lastQuery).toContain("subject:");
  });

  it("bounds the fallback query to this run, so an earlier canary can't match", async () => {
    // The subject is REPLAYED copy, so a previous canary of the same play is a
    // valid match for it — an unbounded query would report that older run's
    // placement as if it were this one's.
    sentMessageIdResult = null;
    realCopy = { subject: "your Series A", body: "b", playName: "post-funding" };
    pollResults = [placed(["INBOX"])];
    const before = Math.floor(Date.now() / 1000);
    await runPlacementCanary({ sleep: noSleep });

    const after = lastQuery.match(/after:(\d+)/)?.[1];
    expect(after).toBeDefined();
    // Bounded to roughly now, not an open-ended window.
    expect(Number(after)).toBeGreaterThan(before - 120);
    expect(lastQuery).not.toContain("newer_than");
  });

  it("keeps polling until the message shows up", async () => {
    pollResults = [null, null, placed(["INBOX"])];
    const result = await runPlacementCanary({ sleep: noSleep, deadlineMs: 60_000 });
    expect(result.placement).toBe("inbox");
    expect(pollCount).toBe(3);
  });

  it("reports not_delivered rather than guessing when nothing arrives", async () => {
    // Silence is ambiguous — dropped, or just slow. Calling it "spam" would be
    // a fabricated verdict.
    pollResults = [];
    const result = await runPlacementCanary({ sleep: noSleep, deadlineMs: 0 });
    expect(result.placement).toBe("not_delivered");
    expect(result.latencyMs).toBeNull();
    expect(result.auth).toEqual({ spf: "unknown", dkim: "unknown", dmarc: "unknown" });
  });

  it("replays real shipping copy when the ledger has any", async () => {
    // Filters judge CONTENT — a verdict on invented filler wouldn't transfer.
    realCopy = { subject: "your Series A", body: "Hey — saw the round.", playName: "post-funding" };
    pollResults = [placed(["INBOX"])];
    const result = await runPlacementCanary({ sleep: noSleep });

    expect(result.sourcePlay).toBe("post-funding");
    expect(result.subject).toBe("your Series A");
    expect(sentMessages[0]?.htmlBody).toContain("saw the round");
  });

  it("escapes HTML in replayed copy with the real send path's encoder", async () => {
    // Unescaped & < > would reach the filter as different content from what
    // ships — the canary would then be measuring the wrong message.
    realCopy = {
      subject: "Q&A",
      body: "Tips & tricks for <founders>\nsecond line",
      playName: "post-funding",
    };
    pollResults = [placed(["INBOX"])];
    await runPlacementCanary({ sleep: noSleep });

    const html = sentMessages[0]?.htmlBody ?? "";
    expect(html).toContain("&amp;");
    expect(html).toContain("&lt;founders&gt;");
    expect(html).not.toContain("<founders>");
    expect(html).toContain("<br>");
  });

  it("flags a generic sample when there is no real send to replay", async () => {
    realCopy = null;
    pollResults = [placed(["INBOX"])];
    const result = await runPlacementCanary({ sleep: noSleep });
    expect(result.sourcePlay).toBeNull();
  });

  it("flags a same-domain pair, whose result can't be trusted", async () => {
    // Internal Workspace routing skips filtering and authentication, so this
    // would read clean no matter how a stranger's server would treat us.
    identities = [
      gmailIdentity("gmail:a@corp.example", "a@corp.example"),
      gmailIdentity("gmail:b@corp.example", "b@corp.example"),
    ];
    pollResults = [placed(["INBOX"])];
    expect((await runPlacementCanary({ sleep: noSleep })).sameDomain).toBe(true);
  });

  it("does not flag cross-domain pairs", async () => {
    pollResults = [placed(["INBOX"])];
    expect((await runPlacementCanary({ sleep: noSleep })).sameDomain).toBe(false);
  });

  it("sends from the chosen identity to the chosen one", async () => {
    pollResults = [placed(["INBOX"])];
    await runPlacementCanary({ sleep: noSleep });
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({ to: "b@two.example", fromEmail: "a@one.example" });
  });

  it("records the result so doctor can report it without re-sending", async () => {
    pollResults = [placed(["INBOX", "CATEGORY_PROMOTIONS"])];
    await runPlacementCanary({ sleep: noSleep });
    expect(recordedCanaries).toHaveLength(1);
    expect(recordedCanaries[0]).toMatchObject({
      fromIdentity: "gmail:a@one.example",
      toIdentity: "gmail:b@two.example",
      placement: "promotions",
    });
  });
});
