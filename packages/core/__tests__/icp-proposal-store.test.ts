import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../src/ledger.ts";
import { normalizeIcpText } from "../src/icp-proposal-store.ts";

// Learning-loop v2 (issue #750): the store gates the model call behind a
// lease/cooldown, holds generated proposals, and guards the founder's
// decision path. These tests exercise the store directly (the same surface
// `icp-proposals.ts` and the API routes call through `ledger.icpProposals`).

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-icp-proposal-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledger = new Ledger(dbPath);
});

afterEach(() => {
  ledger.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
});

describe("IcpProposalStore.beginEvaluation lease/cooldown", () => {
  it("grants a lease when idle, then refuses a second concurrent lease", () => {
    const token = ledger.icpProposals.beginEvaluation(1_000, 86_400_000, 300_000);
    expect(token).not.toBeNull();
    expect(ledger.icpProposals.beginEvaluation(1_500, 86_400_000, 300_000)).toBeNull();
  });

  it("refuses a new lease before the cooldown elapses, even after finishing", () => {
    const token = ledger.icpProposals.beginEvaluation(1_000, 86_400_000, 300_000)!;
    ledger.icpProposals.finish(token);
    // Cooldown is measured from attempted_ms, not from finish: a completed
    // evaluation still spends the daily window.
    expect(ledger.icpProposals.beginEvaluation(1_000 + 60_000, 86_400_000, 300_000)).toBeNull();
    expect(
      ledger.icpProposals.beginEvaluation(1_000 + 86_400_000, 86_400_000, 300_000),
    ).not.toBeNull();
  });

  it("a stale lease releases once its lease window elapses", () => {
    const token = ledger.icpProposals.beginEvaluation(1_000, 86_400_000, 300_000)!;
    expect(ledger.icpProposals.beginEvaluation(1_000 + 100_000, 86_400_000, 300_000)).toBeNull();
    // Past until_ms (1_000 + 300_000) but still inside the cooldown window
    // measured from attempted_ms: the crashed lease clears, but the cooldown
    // still applies to the next attempt.
    expect(ledger.icpProposals.beginEvaluation(1_000 + 300_001, 86_400_000, 300_000)).toBeNull();
    void token;
  });

  it("fail() clears the lease without spending the cooldown from a fresh baseline", () => {
    const token = ledger.icpProposals.beginEvaluation(1_000, 86_400_000, 300_000)!;
    ledger.icpProposals.fail(token, "boom");
    // Still governed by the cooldown measured from the original attempt.
    expect(ledger.icpProposals.beginEvaluation(1_000 + 1_000, 86_400_000, 300_000)).toBeNull();
    expect(
      ledger.icpProposals.beginEvaluation(1_000 + 86_400_000, 86_400_000, 300_000),
    ).not.toBeNull();
  });

  it("finish/fail with a stale token is a no-op against a lease someone else already won", () => {
    const token = ledger.icpProposals.beginEvaluation(1_000, 86_400_000, 300_000)!;
    expect(ledger.icpProposals.finish("not-the-token")).toBe(false);
    // The real lease is still held.
    expect(ledger.icpProposals.beginEvaluation(1_100, 86_400_000, 300_000)).toBeNull();
    expect(ledger.icpProposals.finish(token)).toBe(true);
  });
});

describe("IcpProposalStore proposal lifecycle", () => {
  const insertOne = (proposedIcp = "B2B fintech CTOs at Series A startups") =>
    ledger.icpProposals.insert({
      currentIcp: "B2B fintech founders",
      proposedIcp,
      evidenceSummary: "Recent approvals skew toward technical buyers.",
      createdAt: "2026-09-29T00:00:00.000Z",
    });

  it("insert + list round-trips a pending proposal", () => {
    const inserted = insertOne();
    expect(inserted.status).toBe("pending");
    const pending = ledger.icpProposals.list("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      currentIcp: "B2B fintech founders",
      proposedIcp: "B2B fintech CTOs at Series A startups",
      evidenceSummary: "Recent approvals skew toward technical buyers.",
    });
    expect(ledger.icpProposals.list("approved")).toEqual([]);
    expect(ledger.icpProposals.list()).toHaveLength(1);
  });

  it("hasPendingDuplicate matches on normalized text, not exact casing/punctuation", () => {
    insertOne("B2B fintech CTOs at Series A startups.");
    expect(ledger.icpProposals.hasPendingDuplicate("b2b fintech ctos at series a startups")).toBe(
      true,
    );
    expect(ledger.icpProposals.hasPendingDuplicate("Completely different audience")).toBe(false);
  });

  it("decide() flips pending -> approved/dismissed and rejects a second decision on the same row", () => {
    const inserted = insertOne();
    const decided = ledger.icpProposals.decide(inserted.id, "approved", "2026-09-29T01:00:00Z");
    expect("view" in decided).toBe(true);
    if ("view" in decided) {
      expect(decided.view.status).toBe("approved");
      expect(decided.view.decidedAt).toBe("2026-09-29T01:00:00Z");
    }
    const again = ledger.icpProposals.decide(inserted.id, "dismissed", "2026-09-29T02:00:00Z");
    expect("error" in again).toBe(true);
    if ("error" in again) expect(again.error).toContain("already approved");
  });

  it("decide() on an unknown id returns a named error", () => {
    const result = ledger.icpProposals.decide("nope", "approved", "2026-09-29T00:00:00Z");
    expect("error" in result).toBe(true);
  });

  it("revertToPending puts an approved row back to pending (config-write-failure compensation)", () => {
    const inserted = insertOne();
    ledger.icpProposals.decide(inserted.id, "approved", "2026-09-29T01:00:00Z");
    ledger.icpProposals.revertToPending(inserted.id);
    expect(ledger.icpProposals.get(inserted.id)).toMatchObject({
      status: "pending",
      decidedAt: null,
    });
  });

  it("wasJustDismissed is true only when the MOST RECENTLY DECIDED proposal, of any text, was a dismissal of this text", () => {
    const first = insertOne("Series A fintech CTOs");
    ledger.icpProposals.decide(first.id, "dismissed", "2026-09-29T01:00:00Z");
    expect(ledger.icpProposals.wasJustDismissed("Series A fintech CTOs")).toBe(true);
    expect(ledger.icpProposals.wasJustDismissed("Unrelated text")).toBe(false);

    // A later decision — on a DIFFERENT text — is now the most recent decided
    // row, so the ban on the original text lifts (it does not need to be
    // decided again to overtake the dismissal, and in practice can't be: the
    // generator's own duplicate-of-a-dismissal guard blocks re-proposing an
    // identical text while it's still banned).
    const second = insertOne("A completely different rewrite");
    ledger.icpProposals.decide(second.id, "approved", "2026-09-29T02:00:00Z");
    expect(ledger.icpProposals.wasJustDismissed("Series A fintech CTOs")).toBe(false);
  });

  it("dismissStalePending flips every pending row to dismissed, leaving already-decided rows untouched", () => {
    const a = insertOne("Rewrite A");
    const b = insertOne("Rewrite B");
    const c = insertOne("Rewrite C");
    ledger.icpProposals.decide(c.id, "approved", "2026-09-29T01:00:00Z");
    ledger.icpProposals.dismissStalePending("2026-09-29T02:00:00Z");
    expect(ledger.icpProposals.get(a.id)).toMatchObject({
      status: "dismissed",
      decidedAt: "2026-09-29T02:00:00Z",
    });
    expect(ledger.icpProposals.get(b.id)).toMatchObject({
      status: "dismissed",
      decidedAt: "2026-09-29T02:00:00Z",
    });
    // Already-decided row is untouched, not re-stamped.
    expect(ledger.icpProposals.get(c.id)).toMatchObject({
      status: "approved",
      decidedAt: "2026-09-29T01:00:00Z",
    });
  });
});

describe("normalizeIcpText", () => {
  it("collapses case and punctuation differences to the same key", () => {
    expect(normalizeIcpText("B2B, Fintech CTOs!")).toBe(normalizeIcpText("b2b fintech ctos"));
  });
});

describe("Ledger.countHumanIcpDecisions / recentIcpDecisions", () => {
  it("counts only human-decided rows from ICP-eligible plays with valid JSON payloads", () => {
    // Human approval on an eligible play: counts.
    ledger.enqueueTarget({
      playName: "show-hn",
      payload: { title: "Ada raises Seed" },
      dedupeKey: "a",
      source: "find:show-hn",
    });
    ledger.setQueueStatus({ id: 1, status: "approved", decidedBy: "human" });

    // Machine-decided row on an eligible play: does not count.
    ledger.enqueueTarget({
      playName: "show-hn",
      payload: { title: "Bot post" },
      dedupeKey: "b",
      source: "find:show-hn",
    });
    ledger.setQueueStatus({ id: 2, status: "rejected", decidedBy: "machine" });

    // Human-decided row on a play NOT in the ICP example set: does not count.
    ledger.enqueueTarget({
      playName: "x-amplify-dm",
      payload: { title: "Some DM" },
      dedupeKey: "c",
      source: "find:x-amplify-dm",
    });
    ledger.setQueueStatus({ id: 3, status: "approved", decidedBy: "human" });

    expect(ledger.countHumanIcpDecisions()).toBe(1);
    expect(ledger.recentIcpDecisions(20)).toHaveLength(1);
  });

  it("counts stay in sync with recentIcpDecisions as more human decisions accrue", () => {
    for (let i = 0; i < 5; i++) {
      ledger.enqueueTarget({
        playName: "post-funding",
        payload: { title: `Round ${i}` },
        dedupeKey: `k${i}`,
        source: "find:post-funding",
      });
      ledger.setQueueStatus({ id: i + 1, status: "approved", decidedBy: "human" });
    }
    expect(ledger.countHumanIcpDecisions()).toBe(5);
    expect(ledger.recentIcpDecisions(3)).toHaveLength(3);
    expect(ledger.recentIcpDecisions(20)).toHaveLength(5);
  });
});
