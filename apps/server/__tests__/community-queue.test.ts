import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "@oneshot-gtm/core";
let ledger: Ledger;
const send = vi.fn();
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  getLedger: () => ledger,
  sendEmail: (...args: unknown[]) => send(...args),
  isDraining: () => false,
}));
const { markSentRoute, sendDraftRoute, toView } = await import("../src/api/queue.ts");
const { listPlays } = await import("../src/api/plays.ts");
const target = {
  platform: "hacker-news",
  threadId: "42",
  postUrl: "https://news.ycombinator.com/item?id=42",
  postTitle: "Which CRM?",
  handle: "buyer",
  publishedAt: "2026-10-04",
  supportingText: "Which CRM supports CSV?",
  retrievedAt: "2026-10-05",
};
const req = () => new Request("http://localhost/api/queue/1/mark-sent", { method: "POST" });
beforeEach(() => {
  ledger = new Ledger(":memory:");
  send.mockClear();
});
afterEach(() => ledger.close());
function row(channel: "email" | "hacker-news" = "hacker-news") {
  const id = ledger.enqueueTarget({
    playName: "community-reply",
    channel,
    dedupeKey: "hacker-news:42",
    source: "find:community-buyer-threads",
    payload: { ...target, email: "injected@example.com" },
  })!;
  ledger.setQueueStatus({ id, status: "approved" });
  ledger.setQueueDraft({
    id,
    draft: {
      subject: "Reply",
      body: "Helpful reply",
      flags: [],
      sent: false,
      receiptIds: [],
      dryRun: true,
    },
  });
  return id;
}
describe("community queue endpoints", () => {
  it("uses the normal view and manual completion endpoint exactly once", async () => {
    const id = row();
    expect(toView(ledger.getQueueRow(id)!)).toMatchObject({
      sender: "manual",
      channel: "hacker-news",
      status: "approved",
    });
    const responses = await Promise.all([
      markSentRoute(req(), { id: String(id) }),
      markSentRoute(req(), { id: String(id) }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const completed = ledger.getQueueRow(id)!;
    expect(completed.status).toBe("sent");
    const events = ledger.listSequenceEventsForProspect(completed.prospect_id!);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.metadata_json!)).toMatchObject({
      postUrl: target.postUrl,
      manual: true,
      queueId: id,
    });
    expect(ledger.getCadence(completed.prospect_id!, "community-reply")).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["hacker-news", "email"] as const)(
    "blocks automatic sending even with an email field and stored channel %s",
    async (channel) => {
      const id = row(channel);
      expect((await sendDraftRoute(req(), { id: String(id) })).status).toBe(400);
      expect(ledger.getQueueRow(id)?.status).toBe("approved");
      expect(send).not.toHaveBeenCalled();
    },
  );
  it("reports accurate manual channels and descriptions in the existing catalogue", async () => {
    const response = listPlays(new Request("http://localhost/api/plays"));
    const data = (await response.json()) as {
      plays: Array<{
        name: string;
        channels: string[];
        followupCount: number;
        description: { whenToUse: string };
      }>;
    };
    expect(data.plays.every((p) => p.description?.whenToUse)).toBe(true);
    expect(data.plays.find((p) => p.name === "community-reply")).toMatchObject({
      channels: ["reddit", "hacker-news"],
      followupCount: 0,
    });
    expect(data.plays.find((p) => p.name === "x-amplify-dm")?.channels).toEqual(["x"]);
  });
});
