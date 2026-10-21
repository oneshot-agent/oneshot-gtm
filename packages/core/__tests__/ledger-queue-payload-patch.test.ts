import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";

// Issue #592: the backfill writes through a guarded primitive, not a bare
// UPDATE. A row that got sent (or started sending) between listing and
// writing must be left alone, and the caller must be told.

let ledger: Ledger;
let dbPath: string;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-payload-patch-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

function enqueue(payload: Record<string, unknown>, status?: "pending" | "approved" | "rejected") {
  const id = ledger.enqueueTarget({
    playName: "show-hn",
    payload,
    dedupeKey: `k-${Math.random().toString(36).slice(2)}`,
    source: "find:show-hn",
    ...(status ? { initialStatus: status } : {}),
  })!;
  if (status === "approved") ledger.setQueueStatus({ id, status: "approved" });
  return id;
}

function payloadOf(id: number): Record<string, unknown> {
  return JSON.parse(ledger.getQueueRow(id)!.payload_json) as Record<string, unknown>;
}

describe("Ledger.patchLiveQueuePayload", () => {
  it("merges the patch into a pending or approved row and keeps the other keys", () => {
    const id = enqueue({ name: "A", postTitle: "Show HN: X" });
    expect(
      ledger.patchLiveQueuePayload({ id, patch: { fitReason: "fits", fitReasonSource: "notes" } }),
    ).toBe(true);
    expect(payloadOf(id)).toEqual({
      name: "A",
      postTitle: "Show HN: X",
      fitReason: "fits",
      fitReasonSource: "notes",
    });
    const approved = enqueue({ name: "B" }, "approved");
    expect(ledger.patchLiveQueuePayload({ id: approved, patch: { fitReason: "ok" } })).toBe(true);
    expect(payloadOf(approved)["fitReason"]).toBe("ok");
  });

  it("refuses a sent row, an in-flight row, a rejected row, and an unknown id", () => {
    const sent = enqueue({ name: "S" }, "approved");
    ledger.setQueueStatus({ id: sent, status: "sent" });
    expect(ledger.patchLiveQueuePayload({ id: sent, patch: { fitReason: "x" } })).toBe(false);
    expect(payloadOf(sent)["fitReason"]).toBeUndefined();

    const inflight = enqueue({ name: "I" }, "approved");
    expect(
      ledger.claimQueueSendingMarker({ id: inflight, startedAtIso: new Date().toISOString() }),
    ).toBe(true);
    expect(ledger.patchLiveQueuePayload({ id: inflight, patch: { fitReason: "x" } })).toBe(false);

    const rejected = enqueue({ name: "R" }, "rejected");
    expect(ledger.patchLiveQueuePayload({ id: rejected, patch: { fitReason: "x" } })).toBe(false);

    expect(ledger.patchLiveQueuePayload({ id: 999_999, patch: { fitReason: "x" } })).toBe(false);
  });
});

describe("Ledger.patchLiveQueuePayload compare-and-set", () => {
  it("writes only while every expected path still holds its value", () => {
    const id = enqueue({ name: "A", offer: { offer: "first", relevance: "weak" } });
    const expectFirst = [
      { path: "$.offer.offer", value: "first" },
      { path: "$.offer.editedBy", value: null },
    ];
    expect(
      ledger.patchLiveQueuePayload({
        id,
        patch: { offer: { weakApprovedAt: "t1" } },
        expect: expectFirst,
      }),
    ).toBe(true);
    expect(payloadOf(id)["offer"]).toEqual({
      offer: "first",
      relevance: "weak",
      weakApprovedAt: "t1",
    });

    ledger.patchLiveQueuePayload({
      id,
      patch: { offer: { offer: "second", weakApprovedAt: null } },
    });
    expect(
      ledger.patchLiveQueuePayload({
        id,
        patch: { offer: { weakApprovedAt: "t2" } },
        expect: expectFirst,
      }),
    ).toBe(false);
    expect(payloadOf(id)["offer"]).toEqual({ offer: "second", relevance: "weak" });
  });
});

describe("atomic queue draft generation", () => {
  const draft = {
    subject: "s",
    body: "b",
    flags: [],
    sent: false,
    receiptIds: [],
    dryRun: true,
    angle: {
      text: "new argument",
      origin: "generated",
      fingerprint: "v1",
      history: ["new argument"],
    },
  };
  it("persists angle metadata and rejects a stale competing writer", () => {
    const id = enqueue({ name: "A" });
    const row = ledger.getQueueRow(id)!;
    const input = { id, previousDraft: null, previousPayload: row.payload_json, draft };
    expect(ledger.setQueueDraftIfCurrent(input)).toBe(true);
    expect(JSON.parse(ledger.getQueueRow(id)!.last_draft_json!).angle).toEqual(draft.angle);
    expect(ledger.setQueueDraftIfCurrent(input)).toBe(false);
    expect(ledger.getQueueRow(id)!.payload_json).toBe(row.payload_json);
  });
  it("does not overwrite after payload changes or a send", () => {
    const id = enqueue({ name: "A" });
    const row = ledger.getQueueRow(id)!;
    const input = { id, previousDraft: null, previousPayload: row.payload_json, draft };
    ledger.updateQueuePayload({ id, payload: { name: "B" } });
    expect(ledger.setQueueDraftIfCurrent(input)).toBe(false);
    ledger.setQueueStatus({ id, status: "sent" });
    expect(
      ledger.setQueueDraftIfCurrent({
        ...input,
        previousPayload: ledger.getQueueRow(id)!.payload_json,
      }),
    ).toBe(false);
  });
  it("does not save a draft written for a channel the row has since left", () => {
    const id = enqueue({
      name: "A",
      email: "a@x.dev",
      linkedinUrl: "https://www.linkedin.com/in/a",
    });
    const row = ledger.getQueueRow(id)!;
    expect(ledger.setQueueChannel(id, "linkedin")).toBe("changed");
    const input = {
      id,
      previousDraft: null,
      previousPayload: row.payload_json,
      previousChannel: row.channel,
      draft,
    };
    expect(ledger.setQueueDraftIfCurrent(input)).toBe(false);
    expect(ledger.setQueueDraftIfCurrent({ ...input, previousChannel: "linkedin" })).toBe(true);
  });
});

describe("setQueueChannel", () => {
  it("keeps the draft when asked for the channel the row is already on", () => {
    const id = enqueue({ name: "A", email: "a@x.dev" });
    ledger.setQueueDraft({
      id,
      draft: { subject: "s", body: "b", flags: [], sent: false, receiptIds: [], dryRun: true },
    });
    expect(ledger.setQueueChannel(id, "email")).toBe("changed");
    expect(ledger.getQueueRow(id)!.last_draft_json).not.toBeNull();
  });

  it("refuses while a send or a live drain lease holds the row", () => {
    const sending = enqueue({ name: "A" }, "approved");
    expect(
      ledger.claimQueueSendingMarker({ id: sending, startedAtIso: new Date().toISOString() }),
    ).toBe(true);
    expect(ledger.setQueueChannel(sending, "linkedin")).toBe("busy");

    const leased = enqueue({ name: "B" }, "approved");
    expect(ledger.dequeueApproved({ playName: "show-hn" }).map((r) => r.id)).toContain(leased);
    expect(ledger.setQueueChannel(leased, "linkedin")).toBe("busy");
    expect(ledger.getQueueRow(leased)!.channel).toBe("email");

    ledger.setQueueStatus({ id: leased, status: "sent" });
    expect(ledger.setQueueChannel(leased, "linkedin")).toBe("sent");
  });
});

describe("isLinkedInProfileKnown", () => {
  it("matches a live queue row in any play, or a prospect, on the canonical profile", () => {
    expect(ledger.isLinkedInProfileKnown("https://www.linkedin.com/in/dana-lee")).toBe(false);
    enqueue({ name: "Dana", linkedinUrl: "https://linkedin.com/in/Dana-Lee/" });
    expect(ledger.isLinkedInProfileKnown("https://www.linkedin.com/in/dana-lee")).toBe(true);

    ledger.upsertProspect({
      name: "Sam",
      email: null,
      linkedin_url: "https://www.linkedin.com/in/sam-k",
      source: "t",
    });
    expect(ledger.isLinkedInProfileKnown("https://linkedin.com/in/sam-k?trk=x")).toBe(true);
  });

  it("ignores rejected and sent rows", () => {
    enqueue({ name: "R", linkedinUrl: "https://www.linkedin.com/in/rej" }, "rejected");
    expect(ledger.isLinkedInProfileKnown("https://www.linkedin.com/in/rej")).toBe(false);
  });
});

describe("Ledger.patchSentQueueOffer", () => {
  const offer = { offer: "get every renewal signed", steps: "drafts it", relevance: "weak" };

  it("writes only the offer keys, and only on a sent row", () => {
    const sent = enqueue({ name: "A", email: "a@x.dev", yourEdge: "e" });
    ledger.setQueueStatus({ id: sent, status: "sent" });
    const pending = enqueue({ name: "B" });
    const approved = enqueue({ name: "C" }, "approved");

    expect(ledger.patchSentQueueOffer({ id: sent, offer, offerCandidates: [offer] })).toBe(true);
    expect(payloadOf(sent)).toEqual({
      name: "A",
      email: "a@x.dev",
      yourEdge: "e",
      offer,
      offerCandidates: [offer],
    });
    expect(ledger.patchSentQueueOffer({ id: pending, offer })).toBe(false);
    expect(ledger.patchSentQueueOffer({ id: approved, offer })).toBe(false);
    expect(payloadOf(pending)).toEqual({ name: "B" });
    expect(payloadOf(approved)).toEqual({ name: "C" });
    expect(ledger.patchSentQueueOffer({ id: 999_999, offer })).toBe(false);
  });

  it("merges the offer key by key, a null deleting one, and keeps the candidates when not given", () => {
    const id = enqueue({ name: "A" });
    ledger.setQueueStatus({ id, status: "sent" });
    ledger.patchSentQueueOffer({ id, offer, offerCandidates: [offer] });
    expect(
      ledger.patchSentQueueOffer({
        id,
        offer: { weakApprovedAt: "2026-10-21T00:00:00Z", relevance: null },
      }),
    ).toBe(true);
    expect(payloadOf(id)).toEqual({
      name: "A",
      offer: { offer: offer.offer, steps: offer.steps, weakApprovedAt: "2026-10-21T00:00:00Z" },
      offerCandidates: [offer],
    });
  });

  it("is a compare-and-set with expect", () => {
    const id = enqueue({ name: "A" });
    ledger.setQueueStatus({ id, status: "sent" });
    ledger.patchSentQueueOffer({ id, offer });
    const stamp = { weakApprovedAt: "now" };
    expect(
      ledger.patchSentQueueOffer({
        id,
        offer: stamp,
        expect: [{ path: "$.offer.offer", value: "another offer" }],
      }),
    ).toBe(false);
    expect(
      ledger.patchSentQueueOffer({
        id,
        offer: stamp,
        expect: [{ path: "$.offer.offer", value: offer.offer }],
      }),
    ).toBe(true);
    expect((payloadOf(id)["offer"] as Record<string, unknown>)["weakApprovedAt"]).toBe("now");
  });

  it("latestSentQueueRow names the row's id", () => {
    const id = enqueue({ name: "A", email: "a@x.dev" });
    ledger.setQueueStatus({ id, status: "sent" });
    expect(ledger.latestSentQueueRow("show-hn", "A@x.dev ")).toMatchObject({ id });
  });
});
