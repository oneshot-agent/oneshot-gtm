import { describe, expect, it } from "vitest";
import { blockingFlags, SOFT_REVIEW_FLAGS } from "../src/index.ts";

// The soft/hard flag split is the shared contract between the server send gate
// (apps/server/src/api/queue.ts) and the queue UI's send button
// (apps/web/src/routes/queue.tsx). If they ever disagree, a held draft becomes
// either un-sendable or silently auto-sent — so pin the behavior here.

describe("blockingFlags", () => {
  it("treats stale-event as soft (founder-overridable, not blocking)", () => {
    expect(SOFT_REVIEW_FLAGS).toContain("stale-event");
    expect(blockingFlags(["stale-event"])).toEqual([]);
  });

  it("keeps lint/dedup flags blocking", () => {
    expect(blockingFlags(["em-dash"])).toEqual(["em-dash"]);
    expect(blockingFlags(["already-contacted", "rule-of-three"])).toEqual([
      "already-contacted",
      "rule-of-three",
    ]);
  });

  it("strips only the soft flags from a mixed set", () => {
    expect(blockingFlags(["stale-event", "body-too-long"])).toEqual(["body-too-long"]);
  });

  it("returns empty for a clean draft", () => {
    expect(blockingFlags([])).toEqual([]);
  });
});
