import { beforeEach, expect, it } from "vitest";
import { getLedger, loadConfig, saveConfig } from "@oneshot-gtm/core";
import type { ReplyThread } from "@oneshot-gtm/shared-types";
import { threadContextVersion } from "../src/api/replies-view.ts";

// Approving an answer from the code changes what a reply thread's drafts
// were written against, so cached reply options read as stale.

const thread = {
  key: "email:t1",
  channel: "email",
  workspace: null,
  prospectId: null,
  messages: [
    { id: "m1", direction: "inbound", body: "How do approvals work?", at: "", human: true },
  ],
} as unknown as ReplyThread;

beforeEach(() => {
  saveConfig({ ...loadConfig(), productBrief: "Widgets approves things." });
  getLedger().codeAnswers.db.exec("DELETE FROM code_answers");
});

it("the thread context version moves when a code answer is approved", () => {
  const before = threadContextVersion(thread, "test");
  const store = getLedger().codeAnswers;
  const { record } = store.capture({ question: "What happens on a double approval?" })!;
  store.recordDerive(record.id, {
    status: "pending",
    answer: "Only the first approval goes through.",
    files: [],
    commit: "1".repeat(40),
    promptVersion: "v",
    digest: "d",
  });
  // Pending is not in the brief yet.
  expect(threadContextVersion(thread, "test")).toBe(before);
  store.approve(record.id, { by: "founder" });
  expect(threadContextVersion(thread, "test")).not.toBe(before);
});
