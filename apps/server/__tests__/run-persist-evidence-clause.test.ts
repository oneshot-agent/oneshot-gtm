import { expect, it } from "vitest";
import { getLedger } from "@oneshot-gtm/core";
import { persistDraftsToQueue } from "../src/api/run.ts";

// A run's draft reaches /queue review through persistDraftsToQueue. The
// LinkedIn funnel (#792) splits invites by whether the note carried an
// evidence clause, so the flag has to survive into the stored draft: without
// it a later send from the queue is counted as "unrecorded". Real ledger, in
// the per-file temp ONESHOT_GTM_HOME (vitest.setup.ts).

function storedDraft(key: string): Record<string, unknown> {
  const row = getLedger().getQueueRowByDedupe("luma-events", key)!;
  return JSON.parse(row.last_draft_json!) as Record<string, unknown>;
}

function persist(
  key: string,
  evidenceClause?: boolean,
  channel: "email" | "linkedin" = "linkedin",
): void {
  getLedger().enqueueTarget({
    playName: "luma-events",
    payload: { name: "Dana Lee", linkedinUrl: "https://www.linkedin.com/in/dana-lee" },
    dedupeKey: key,
    source: "test",
    channel,
  });
  persistDraftsToQueue({
    playName: "luma-events",
    drafted: [
      {
        subject: "LinkedIn invite",
        body: "hello there",
        flags: [],
        receiptIds: [],
        sent: false,
        ...(evidenceClause !== undefined ? { evidenceClause } : {}),
      },
    ],
    dryRun: true,
    indexToDedupeKey: new Map([[0, key]]),
    configKeys: new Map([
      ["email", "k-email"],
      ["linkedin", "k-linkedin"],
    ]),
  });
}

it("a run's draft keeps its evidence-clause flag in the queue, true or false", () => {
  persist("with-clause", true);
  expect(storedDraft("with-clause")["evidenceClause"]).toBe(true);
  persist("without-clause", false);
  expect(storedDraft("without-clause")["evidenceClause"]).toBe(false);
});

it("a draft with no flag (an email) stores none", () => {
  persist("no-flag");
  expect("evidenceClause" in storedDraft("no-flag")).toBe(false);
});

it("an unsent run draft carries the key read before the batch drafted", () => {
  persist("keyed", undefined, "email");
  expect(storedDraft("keyed")["configKey"]).toBe("k-email");
});

it("a run's email draft on a LinkedIn row carries no key, so it reads stale there", () => {
  // The play drafts email; the row is a LinkedIn first touch. A LinkedIn key
  // would let the drain send the email text as a reviewed connection note.
  persist("email-on-linkedin");
  expect("configKey" in storedDraft("email-on-linkedin")).toBe(false);
});
