import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Ledger } from "@oneshot-gtm/core";

// gatherReplyContext's spend discipline: free context always, paid research
// only for unknown senders on real domains, cache hits cost $0, and failures
// degrade instead of blocking the draft.

const ledger = {
  getProspectById: vi.fn(),
  getInboxThreads: vi.fn(() => new Map()),
  listInboxRepliesForProspect: vi.fn(() => []),
  getCachedEnrichment: vi.fn<Ledger["getCachedEnrichment"]>(() => null),
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

const { gatherReplyContext, profileUrlFor, siteDomainFor } =
  await import("../src/api/_reply-research.ts");

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

describe("dud-domain senders fall back to the finder's profile URL", () => {
  // A stargazer replies from gmail: no company site to read, nothing for
  // enrich to key on. Before this, the drafter got zero facts about them and
  // recycled whatever the intro email had asserted.
  it("reads source_profile_url when the email domain is a dud", async () => {
    ledger.getProspectById.mockReturnValue({
      dossier_json: null,
      source_profile_url: "https://github.com/rishibanota",
    });
    webReadMock.mockResolvedValue({
      result: { markdown: "remembrandt — local agent memory", cost: 0.01 },
      receiptId: 43,
    });

    const ctx = await gatherReplyContext({
      fromEmail: "someone@gmail.com",
      prospectId: 647,
      threadKey: null,
    });

    expect(webReadMock).toHaveBeenCalledWith(
      { url: "https://github.com/rishibanota" },
      expect.objectContaining({ playName: "inbox-reply" }),
    );
    expect(ctx.dossier).toContain("PROFILE (https://github.com/rishibanota)");
    expect(ctx.dossier).toContain("remembrandt");
    expect(ctx.costUsd).toBe(0.01);
    // The dud domain still buys no enrich — this is one page read, not a tier.
    expect(safeEnrichMock).not.toHaveBeenCalled();
  });

  it("spends nothing when a dud-domain prospect has no profile URL", async () => {
    ledger.getProspectById.mockReturnValue({ dossier_json: null, source_profile_url: null });
    const ctx = await gatherReplyContext({
      fromEmail: "someone@gmail.com",
      prospectId: 647,
      threadKey: null,
    });
    expect(webReadMock).not.toHaveBeenCalled();
    expect(ctx.dossier).toBeNull();
    expect(ctx.costUsd).toBe(0);
  });

  it("skips the profile read for non-human inbound (skipPaid)", async () => {
    ledger.getProspectById.mockReturnValue({
      dossier_json: null,
      source_profile_url: "https://github.com/rishibanota",
    });
    const ctx = await gatherReplyContext({
      fromEmail: "someone@gmail.com",
      prospectId: 647,
      threadKey: null,
      skipPaid: true,
    });
    expect(webReadMock).not.toHaveBeenCalled();
    expect(ctx.dossier).toBeNull();
  });

  it("prefers a stored dossier over the profile read", async () => {
    ledger.getProspectById.mockReturnValue({
      // Carries real signal (a title), so it is a genuine Tier-1 hit — the
      // shape the demo seeder and the research backfill both write.
      dossier_json: '{"title":"CTO","company":"Acme","hook":"already known"}',
      source_profile_url: "https://github.com/rishibanota",
    });
    const ctx = await gatherReplyContext({
      fromEmail: "someone@gmail.com",
      prospectId: 647,
      threadKey: null,
    });
    expect(webReadMock).not.toHaveBeenCalled();
    expect(ctx.dossier).toContain("already known");
  });

  it("a CONTENTLESS stored dossier does not block the profile read", async () => {
    // A failed enrich serializes to a non-empty string. Treating that as a
    // Tier-1 hit would hand the drafter no facts AND skip the tier that has some.
    ledger.getProspectById.mockReturnValue({
      dossier_json: JSON.stringify({ status: "failed", profile: null, cost: 0 }),
      source_profile_url: "https://github.com/rishibanota",
    });
    webReadMock.mockResolvedValue({
      result: { markdown: "remembrandt — local agent memory", cost: 0.01 },
      receiptId: 43,
    });

    const ctx = await gatherReplyContext({
      fromEmail: "someone@gmail.com",
      prospectId: 647,
      threadKey: null,
    });

    expect(webReadMock).toHaveBeenCalled();
    expect(ctx.dossier).toContain("remembrandt");
    expect(ctx.dossier).not.toContain("failed");
  });

  it("profileUrlFor rejects anything that isn't a fetchable profile page", () => {
    expect(profileUrlFor("https://github.com/rishibanota")).toBe("https://github.com/rishibanota");
    expect(profileUrlFor(null)).toBeNull();
    expect(profileUrlFor("   ")).toBeNull();
    expect(profileUrlFor("rishibanota")).toBeNull();
    expect(profileUrlFor("mailto:a@b.com")).toBeNull();
    // A bare host is the finder's fallback, not a person's profile.
    expect(profileUrlFor("https://github.com")).toBeNull();
    expect(profileUrlFor("https://github.com/")).toBeNull();
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
