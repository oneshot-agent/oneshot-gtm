import { beforeEach, describe, expect, it, vi } from "vitest";

// gatherReplyContext's spend discipline: free context always, paid research
// only for unknown senders on real domains, cache hits cost $0, and failures
// degrade instead of blocking the draft.

const ledger = {
  getProspectById: vi.fn(),
  getInboxThreads: vi.fn(() => new Map()),
  listInboxRepliesForProspect: vi.fn(() => []),
  getCachedEnrichment: vi.fn(() => null),
  setCachedEnrichment: vi.fn(),
  setCachedEnrichmentFailure: vi.fn(),
};

const webReadMock = vi.fn();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    logEvent: () => {},
    webRead: webReadMock,
  };
});

const safeEnrichMock = vi.fn();
vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return { ...actual, safeEnrich: safeEnrichMock };
});

const { gatherReplyContext, siteDomainFor } = await import("../src/api/_reply-research.ts");

beforeEach(() => {
  vi.clearAllMocks();
  ledger.getProspectById.mockReturnValue(null);
  ledger.getInboxThreads.mockReturnValue(new Map());
  ledger.getCachedEnrichment.mockReturnValue(null);
  safeEnrichMock.mockResolvedValue({
    result: { status: "completed", profile: { name: "Aladdin" }, cost: 0.05 },
    receiptId: 42,
  });
  webReadMock.mockResolvedValue({
    result: { markdown: "x402 payments, live on my site", cost: 0.01 },
    receiptId: 43,
  });
});

describe("gatherReplyContext", () => {
  it("uses the stored prospect dossier for free — no paid calls", async () => {
    ledger.getProspectById.mockReturnValue({ dossier_json: '{"title":"CTO","hook":"x402"}' });
    const ctx = await gatherReplyContext({
      fromEmail: "aladdin@aliyev.site",
      prospectId: 7,
      threadKey: null,
    });
    expect(ctx.dossier).toContain("x402");
    expect(ctx.costUsd).toBe(0);
    expect(ctx.researched).toBe(false);
    expect(safeEnrichMock).not.toHaveBeenCalled();
    expect(webReadMock).not.toHaveBeenCalled();
  });

  it("researches an unknown sender on a real domain: enrich + site read, cost summed", async () => {
    const ctx = await gatherReplyContext({
      fromEmail: "aladdin@aliyev.site",
      prospectId: null,
      threadKey: null,
    });
    expect(safeEnrichMock).toHaveBeenCalledWith(
      { email: "aladdin@aliyev.site" },
      expect.objectContaining({ playName: "inbox-reply" }),
    );
    expect(webReadMock).toHaveBeenCalledWith(
      { url: "https://aliyev.site" },
      expect.objectContaining({ playName: "inbox-reply" }),
    );
    expect(ctx.dossier).toContain("Aladdin");
    expect(ctx.dossier).toContain("x402 payments");
    expect(ctx.costUsd).toBeCloseTo(0.06);
    expect(ctx.researched).toBe(true);
  });

  it("spends nothing on a dud domain (personal email providers)", async () => {
    const ctx = await gatherReplyContext({
      fromEmail: "someone@gmail.com",
      prospectId: null,
      threadKey: null,
    });
    expect(safeEnrichMock).not.toHaveBeenCalled();
    expect(webReadMock).not.toHaveBeenCalled();
    expect(ctx.dossier).toBeNull();
    expect(ctx.costUsd).toBe(0);
  });

  it("a cached enrich (receiptId 0) reports $0 and researched=false", async () => {
    safeEnrichMock.mockResolvedValue({
      result: { status: "completed", profile: { name: "Aladdin" }, cost: 0.05 },
      receiptId: 0,
    });
    webReadMock.mockRejectedValue(new Error("site down"));
    const ctx = await gatherReplyContext({
      fromEmail: "aladdin@aliyev.site",
      prospectId: null,
      threadKey: null,
    });
    expect(ctx.dossier).toContain("Aladdin");
    expect(ctx.costUsd).toBe(0);
    expect(ctx.researched).toBe(false);
  });

  it("serves the site read from cache without a second spend", async () => {
    ledger.getCachedEnrichment.mockImplementation((key: string) =>
      key === "webread:aliyev.site"
        ? {
            result_json: JSON.stringify({ text: "cached site text" }),
            fetched_at: new Date().toISOString(),
            status: null,
          }
        : null,
    );
    const ctx = await gatherReplyContext({
      fromEmail: "aladdin@aliyev.site",
      prospectId: null,
      threadKey: null,
    });
    expect(webReadMock).not.toHaveBeenCalled();
    expect(ctx.dossier).toContain("cached site text");
  });

  it("degrades to no dossier when all research fails — never throws", async () => {
    safeEnrichMock.mockResolvedValue({
      result: { status: "failed", profile: null, cost: 0 },
      receiptId: 0,
    });
    webReadMock.mockRejectedValue(new Error("unreachable"));
    const ctx = await gatherReplyContext({
      fromEmail: "aladdin@aliyev.site",
      prospectId: null,
      threadKey: null,
    });
    expect(ctx.dossier).toBeNull();
    expect(ctx.costUsd).toBe(0);
  });

  it("includes this thread's sent replies from the ledger", async () => {
    ledger.getInboxThreads.mockReturnValue(
      new Map([
        ["t1", { draftBody: null, sent: [{ body: "already replied once", sentAt: "2026-08-20" }] }],
      ]),
    );
    const ctx = await gatherReplyContext({
      fromEmail: "someone@gmail.com",
      prospectId: null,
      threadKey: "t1",
    });
    expect(ctx.threadSent).toEqual([{ body: "already replied once", sentAt: "2026-08-20" }]);
  });
});

describe("review-finding regressions (#35)", () => {
  it("reads the registrable site for mail-subdomain senders", async () => {
    await gatherReplyContext({
      fromEmail: "person@mail.acme.com",
      prospectId: null,
      threadKey: null,
    });
    expect(webReadMock).toHaveBeenCalledWith(
      { url: "https://acme.com" },
      expect.objectContaining({ playName: "inbox-reply" }),
    );
  });

  it("siteDomainFor strips only well-known mail labels", () => {
    expect(siteDomainFor("mail.acme.com")).toBe("acme.com");
    expect(siteDomainFor("smtp.acme.co")).toBe("acme.co");
    expect(siteDomainFor("aliyev.site")).toBe("aliyev.site");
    // Not a mail label — a real subdomain company site passes through.
    expect(siteDomainFor("labs.acme.com")).toBe("labs.acme.com");
  });

  it("a cache-write failure does not discard a successful site read", async () => {
    ledger.setCachedEnrichment.mockImplementation(() => {
      throw new Error("SQLITE_BUSY");
    });
    const ctx = await gatherReplyContext({
      fromEmail: "aladdin@aliyev.site",
      prospectId: null,
      threadKey: null,
    });
    // The fetched site text must still reach the dossier.
    expect(ctx.dossier).toContain("x402 payments");
  });

  it("a cache-READ failure falls through to a live read instead of throwing", async () => {
    ledger.getCachedEnrichment.mockImplementation(() => {
      throw new Error("corrupt db");
    });
    const ctx = await gatherReplyContext({
      fromEmail: "aladdin@aliyev.site",
      prospectId: null,
      threadKey: null,
    });
    expect(webReadMock).toHaveBeenCalled();
    expect(ctx.dossier).toContain("x402 payments");
  });
});
