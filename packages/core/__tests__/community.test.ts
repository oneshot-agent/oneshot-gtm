import { describe, expect, it, vi } from "vitest";
import { communityProfile, communityThread, communityUrl } from "../src/community.ts";
import { channelAddresses, firstTouchSender } from "../src/channels.ts";
import { Ledger } from "../src/ledger.ts";

const target = {
  platform: "reddit" as const,
  threadId: "abc123",
  postUrl: "https://www.reddit.com/comments/abc123/",
  postTitle: "Which CRM?",
  handle: "founder",
  publishedAt: "2026-10-04T00:00:00Z",
  supportingText: "Which CRM handles exports?",
  retrievedAt: "2026-10-05T00:00:00Z",
};

describe("community identity", () => {
  it("canonicalizes thread URLs, independent of tracking, title and comment links", () => {
    expect(
      communityUrl("https://old.reddit.com/r/crm/comments/abc123/title/comment/?utm_source=x"),
    ).toEqual(communityUrl(target.postUrl));
    expect(communityUrl("https://news.ycombinator.com/item?id=42&utm_source=x")?.threadId).toBe(
      "42",
    );
    expect(communityUrl("https://reddit.com.evil.test/comments/abc123")).toBeNull();
    expect(communityUrl("javascript:alert(1)")).toBeNull();
  });
  it("requires evidence and an actual platform handle, not a real identity", () => {
    expect(communityThread(target)).not.toBeNull();
    expect(communityThread({ ...target, supportingText: "" })).toBeNull();
    expect(communityProfile("reddit", "[deleted]")).toBeNull();
    expect(communityThread({ ...target, platform: "hacker-news" })).toBeNull();
    expect(channelAddresses({ ...target, email: "injected@example.com" })).toEqual(["reddit"]);
    expect(firstTouchSender("reddit")).toBe("manual");
    expect(firstTouchSender("hacker-news")).toBe("manual");
  });
});

function queued(ledger: Ledger, key = "reddit:abc123") {
  const id = ledger.enqueueTarget({
    playName: "community-reply",
    channel: "reddit",
    source: "find:community-buyer-threads",
    dedupeKey: key,
    payload: target,
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
  return {
    id,
    profileUrl: communityProfile("reddit", "founder")!,
    name: "founder",
    draftJson: ledger.getQueueRow(id)!.last_draft_json!,
    metadata: { body: "Helpful reply", postUrl: target.postUrl },
  };
}

describe("manual confirmation transaction", () => {
  it("records a thread once, reuses handle identity, and never enrolls a cadence", () => {
    const ledger = new Ledger(":memory:");
    try {
      const input = queued(ledger);
      const first = ledger.recordManualQueueSend(input);
      expect(ledger.recordManualQueueSend(input)).toEqual(first);
      expect(ledger.getQueueRow(input.id)?.status).toBe("sent");
      expect(ledger.listSequenceEventsForProspect(first.prospectId)).toHaveLength(1);
      expect(ledger.getProspectById(first.prospectId)?.email).toBeNull();
      expect(ledger.getCadence(first.prospectId, "community-reply")).toBeNull();
      const second = ledger.recordManualQueueSend(queued(ledger, "reddit:another"));
      expect(second.prospectId).toBe(first.prospectId);
      expect(ledger.listSequenceEventsForProspect(first.prospectId)).toHaveLength(2);
    } finally {
      ledger.close();
    }
  });
  it("rolls back the event, prospect and status if draft closure fails", () => {
    const ledger = new Ledger(":memory:");
    try {
      const input = queued(ledger);
      const close = vi.spyOn(ledger, "closeQueueDraftVersion").mockImplementation(() => {
        throw new Error("disk failure");
      });
      expect(() => ledger.recordManualQueueSend(input)).toThrow("disk failure");
      expect(ledger.getQueueRow(input.id)?.status).toBe("approved");
      expect(ledger.getQueueRow(input.id)?.prospect_id).toBeNull();
      close.mockRestore();
      const out = ledger.recordManualQueueSend(input);
      expect(ledger.listSequenceEventsForProspect(out.prospectId)).toHaveLength(1);
    } finally {
      ledger.close();
    }
  });
  it("refuses an unapproved row or a draft changed since review", () => {
    const ledger = new Ledger(":memory:");
    try {
      const input = queued(ledger);
      expect(() => ledger.recordManualQueueSend({ ...input, draftJson: "stale" })).toThrow(
        "draft changed",
      );
      ledger.setQueueStatus({ id: input.id, status: "rejected" });
      expect(() => ledger.recordManualQueueSend(input)).toThrow("approve");
    } finally {
      ledger.close();
    }
  });
});
