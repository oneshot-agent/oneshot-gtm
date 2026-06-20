import { describe, expect, it } from "vitest";
import type { InboxReplyView } from "@oneshot-gtm/shared-types";
import { matchesReplyFilter } from "../src/lib/replyFilter.ts";

function reply(matched: InboxReplyView["matched"]): InboxReplyView {
  return {
    id: "1",
    fromEmail: "a@x.com",
    fromRaw: "a@x.com",
    subject: "s",
    receivedAt: "2026-06-18T00:00:00Z",
    body: "",
    sourceIdentityId: null,
    sourceProvider: null,
    threadId: null,
    messageId: null,
    matched,
    thread: null,
  };
}

const matched = reply({ name: "Pat", company: "Acme", playName: "show-hn", cadenceStatus: "active" });
const noMatch = reply(null);

describe("matchesReplyFilter", () => {
  it("'all' keeps every reply", () => {
    expect(matchesReplyFilter(matched, "all")).toBe(true);
    expect(matchesReplyFilter(noMatch, "all")).toBe(true);
  });

  it("'matched' keeps only replies tied to a prospect", () => {
    expect(matchesReplyFilter(matched, "matched")).toBe(true);
    expect(matchesReplyFilter(noMatch, "matched")).toBe(false);
  });

  it("'no-match' keeps only unmatched replies", () => {
    expect(matchesReplyFilter(noMatch, "no-match")).toBe(true);
    expect(matchesReplyFilter(matched, "no-match")).toBe(false);
  });
});
