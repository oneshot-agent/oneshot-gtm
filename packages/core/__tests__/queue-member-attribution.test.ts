import { afterEach, beforeEach, expect, it } from "vitest";
import { Ledger } from "../src/ledger.ts";
let ledger: Ledger;
let id: number;
beforeEach(() => {
  ledger = new Ledger(":memory:");
  id = ledger.enqueueTarget({
    playName: "show-hn",
    payload: {},
    dedupeKey: "member",
    source: "manual",
  })!;
});
afterEach(() => ledger.close());
it("machine decisions never accept a member, and replace stale human attribution", () => {
  ledger.setQueueStatus({ id, status: "approved", member: "mia@example.com" });
  ledger.setQueueStatus({
    id,
    status: "rejected",
    decidedBy: "machine",
    member: "ignored@example.com",
  });
  expect(ledger.getQueueRow(id)).toMatchObject({ decided_by: "machine", decided_by_member: null });
  ledger.setQueueStatus({
    id,
    status: "approved",
    decidedBy: "machine",
    member: "ignored@example.com",
  });
  expect(ledger.getQueueRow(id)).toMatchObject({ decided_by: "machine", decided_by_member: null });
  ledger.setQueueStatus({ id, status: "sent", member: "ignored@example.com" });
  expect(ledger.getQueueRow(id)).toMatchObject({ decided_by: "machine", decided_by_member: null });
});
it("an unattended send retains the human approval, and a sent row cannot be reapproved", () => {
  ledger.approveAllPending({ member: "mia@example.com" });
  ledger.setQueueStatus({ id, status: "sent" });
  expect(ledger.getQueueRow(id)).toMatchObject({
    decided_by: "human_bulk",
    decided_by_member: "mia@example.com",
  });
  expect(() =>
    ledger.setQueueStatus({ id, status: "approved", member: "other@example.com" }),
  ).toThrow(/already sent/);
  expect(ledger.getQueueRow(id)?.decided_by_member).toBe("mia@example.com");
});
it("a failed draft compare-and-set cannot overwrite the saved editor", () => {
  const row = ledger.getQueueRow(id)!;
  const draft = {
    subject: "Hi",
    body: "Hello",
    flags: [],
    sent: false,
    receiptIds: [],
    dryRun: true,
  };
  const input = { id, previousDraft: null, previousPayload: row.payload_json, draft };
  expect(ledger.setQueueDraftIfCurrent({ ...input, member: "mia@example.com" })).toBe(true);
  expect(ledger.setQueueDraftIfCurrent({ ...input, member: "other@example.com" })).toBe(false);
  expect(JSON.parse(ledger.getQueueRow(id)!.last_draft_json!).editedBy).toBe("mia@example.com");
});
