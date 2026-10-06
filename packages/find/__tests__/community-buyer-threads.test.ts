import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "@oneshot-gtm/core";
let ledger: Ledger;
const search = vi.fn(),
  read = vi.fn(),
  model = vi.fn(),
  fetcher = vi.fn();
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  getLedger: () => ledger,
  loadConfig: () => ({ icpOneLiner: "small business CRM buyers" }),
  webSearch: (...args: unknown[]) => search(...args),
  webRead: (...args: unknown[]) => read(...args),
}));
vi.mock("@oneshot-gtm/intel", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel")),
  completeWithReceipt: (...args: unknown[]) => model(...args),
}));
const { runCommunityBuyerThreadsFinder: run, parseCommunityClassification } =
  await import("../src/community-buyer-threads.ts");
const opts = {
  dryRun: false,
  keywords: ["CRM"],
  platforms: ["hacker-news" as const],
  sinceDays: 7,
};
const title = "Which CRM supports exports?";
const hit = () => ({
  objectID: "42",
  title,
  author: "buyer",
  created_at: new Date(Date.now() - 86400000).toISOString(),
  story_text: title,
});
const verdict = (over = {}) => ({
  relevance: "relevant",
  intent: "recommendation",
  reason: "Asks for a CRM recommendation",
  evidence: title,
  ...over,
});
beforeEach(() => {
  ledger = new Ledger(":memory:");
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockImplementation(async () => Response.json({ hits: [hit()], nbPages: 1 }));
  model.mockImplementation(async () => ({ content: JSON.stringify(verdict()), receiptId: 1 }));
  search.mockResolvedValue({ result: { results: [], cost: 0.01 } });
});
afterEach(() => {
  ledger.close();
  vi.unstubAllGlobals();
});

describe("community finder", () => {
  it("queues evidence without contacts and deduplicates subsequent runs before model spend", async () => {
    expect((await run(opts)).enqueued).toBe(1);
    const row = ledger.getQueueRowByDedupe("community-reply", "hacker-news:42")!;
    expect(row.channel).toBe("hacker-news");
    expect(row.status).toBe("pending");
    expect(JSON.parse(row.payload_json)).toMatchObject({
      handle: "buyer",
      supportingText: title,
      classification: verdict(),
    });
    expect(JSON.parse(row.payload_json).email).toBeUndefined();
    expect((await run(opts)).droppedDuplicate).toBe(1);
    expect(model).toHaveBeenCalledTimes(1);
  });
  it("keeps uncertain matches reviewable and persists exclusions", async () => {
    model.mockResolvedValueOnce({
      content: JSON.stringify(verdict({ relevance: "uncertain", intent: "uncertain" })),
    });
    await run(opts);
    expect(ledger.getQueueRowByDedupe("community-reply", "hacker-news:42")?.status).toBe("pending");
    fetcher.mockResolvedValueOnce(
      Response.json({ hits: [{ ...hit(), objectID: "43" }], nbPages: 1 }),
    );
    model.mockResolvedValueOnce({
      content: JSON.stringify(
        verdict({ relevance: "unrelated", intent: "none", reason: "An advertisement" }),
      ),
    });
    expect((await run(opts)).droppedIcp).toBe(1);
    expect(ledger.getQueueRowByDedupe("community-reply", "hacker-news:43")?.notes).toContain(
      "An advertisement",
    );
  });
  it("distinguishes an empty search, partial failure and total failure", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ hits: [] }));
    expect((await run(opts)).perSource?.[0]).toMatchObject({ records: 0 });
    fetcher.mockRejectedValueOnce(new Error("HN unavailable"));
    const partial = await run({ ...opts, platforms: ["hacker-news", "reddit"] });
    expect(partial.perSource?.[0]?.error).toContain("HN unavailable");
    expect(partial.perSource?.[1]?.error).toBeUndefined();
    expect(partial.halted).toBeUndefined();
    fetcher.mockRejectedValueOnce(new Error("HN unavailable"));
    expect((await run(opts)).halted).toContain("sources failed");
  });
  it("leaves classifier failures retryable and rejects invented evidence", async () => {
    model.mockRejectedValueOnce(new Error("model offline"));
    await run(opts);
    expect(ledger.getQueueRowByDedupe("community-reply", "hacker-news:42")).toBeNull();
    expect((await run(opts)).enqueued).toBe(1);
    expect(() =>
      parseCommunityClassification(JSON.stringify(verdict({ evidence: "invented" })), title),
    ).toThrow();
  });
  it("enforces lookback and budget before classification", async () => {
    fetcher.mockResolvedValueOnce(
      Response.json({ hits: [{ ...hit(), created_at: "2020-01-01" }] }),
    );
    expect((await run(opts)).enqueued).toBe(0);
    expect(model).not.toHaveBeenCalled();
    expect((await run({ ...opts, maxCostUsd: 0 })).halted).toContain("max-cost");
    expect(model).not.toHaveBeenCalled();
  });
  it("extracts Reddit evidence and canonicalizes repeated URL variants", async () => {
    const date = new Date(Date.now() - 86400000).toISOString();
    search.mockResolvedValue({
      result: {
        cost: 0.01,
        results: [
          { url: "https://old.reddit.com/r/crm/comments/abc123/title/?utm_source=x" },
          { url: "https://www.reddit.com/comments/abc123/" },
        ],
      },
    });
    read.mockResolvedValue({ result: { cost: 0.01, markdown: `${title}\nbuyer\n${date}` } });
    model.mockResolvedValueOnce({
      content: JSON.stringify({
        title,
        handle: "buyer",
        publishedAt: date,
        dateEvidence: date,
        supportingText: title,
      }),
    });
    const out = await run({ ...opts, platforms: ["reddit"] });
    expect(out.enqueued).toBe(1);
    expect(out.droppedDuplicate).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(ledger.getQueueRowByDedupe("community-reply", "reddit:abc123")?.channel).toBe("reddit");
  });
  it("does not turn an unreadable Reddit page into a negative classification", async () => {
    search.mockResolvedValue({
      result: { results: [{ url: "https://www.reddit.com/comments/abc123/" }] },
    });
    read.mockResolvedValue({ result: { markdown: "" } });
    const out = await run({ ...opts, platforms: ["reddit"] });
    expect(out.perSource?.[0]?.error).toContain("unreadable");
    expect(ledger.getQueueRowByDedupe("community-reply", "reddit:abc123")).toBeNull();
  });
});
