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

function persist(key: string, evidenceClause?: boolean): void {
  getLedger().enqueueTarget({
    playName: "luma-events",
    payload: { name: "Dana Lee", linkedinUrl: "https://www.linkedin.com/in/dana-lee" },
    dedupeKey: key,
    source: "test",
    channel: "linkedin",
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
