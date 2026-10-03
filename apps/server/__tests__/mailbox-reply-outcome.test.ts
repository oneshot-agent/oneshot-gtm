import { expect, it } from "vitest";
import type { OutboundSend } from "@oneshot-gtm/core";
import { mailboxReplyOutcome } from "../src/api/replies.ts";

// The composer reads a mailbox reply's state from its outbound_sends row.

const row = (over: Partial<OutboundSend>): OutboundSend =>
  ({
    status: "pending",
    submittedAt: null,
    confirmedAt: null,
    dateHeader: null,
    firstAttemptAt: "2026-10-01T10:00:00.000Z",
    error: null,
    ...over,
  }) as OutboundSend;

it("maps every outbound status to a composer state", () => {
  expect(mailboxReplyOutcome(null)).toBeNull();
  expect(mailboxReplyOutcome(row({ status: "pending" }))).toEqual({ status: "pending" });
  expect(
    mailboxReplyOutcome(row({ status: "submitted", submittedAt: "2026-10-01T10:00:01.000Z" })),
  ).toEqual({ status: "sent", sentAt: "2026-10-01T10:00:01.000Z" });
  expect(mailboxReplyOutcome(row({ status: "confirmed" }))?.status).toBe("sent");
  expect(mailboxReplyOutcome(row({ status: "failed", error: "SMTP rejected the reply." }))).toEqual(
    { status: "failed", error: "SMTP rejected the reply." },
  );
  for (const status of ["uncertain", "not_found"] as const) {
    expect(mailboxReplyOutcome(row({ status }))).toEqual({
      status: "uncertain",
      error: "Delivery is not confirmed yet.",
    });
  }
});
