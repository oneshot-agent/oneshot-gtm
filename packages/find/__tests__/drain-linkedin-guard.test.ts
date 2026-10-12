import { beforeEach, describe, expect, it } from "vitest";
import { getLedger } from "@oneshot-gtm/core";
import { drainQueue } from "../src/drain.ts";

// Production drain dispatch against the real ledger, the real guarded sender
// and a real (temp) shared DB: only the OneShot transport is a fake. Proves
// the drain reaches the guard and that a refused row never reaches the wire (#787).

const calls: Array<Record<string, unknown>> = [];
const sender = {
  accountId: "acct-1",
  workspace: "gtm",
  call: async (op: Record<string, unknown>) => {
    calls.push(op);
    if (op["kind"] === "account") return {};
    return { invitation_id: `inv-${calls.length}`, status: "sent" };
  },
};

function approve(payload: Record<string, unknown>, key: string): number {
  const ledger = getLedger();
  const id = ledger.enqueueTarget({
    playName: "luma-events",
    payload,
    dedupeKey: key,
    source: "test",
    channel: "linkedin",
  })!;
  ledger.setQueueDraft({
    id,
    draft: {
      subject: "LinkedIn invite",
      body: "hello there",
      flags: [],
      sent: false,
      receiptIds: [],
      dryRun: false,
    },
  });
  ledger.setQueueStatus({ id, status: "approved", decidedBy: "human" });
  return id;
}

beforeEach(() => {
  calls.length = 0;
});

describe("drainQueue reaches the LinkedIn invite guard", () => {
  it("refuses a repo name, an X URL and a profile twice, counts them per reason, sends one", async () => {
    const good = {
      name: "Dana Lee",
      company: "Acme",
      email: "dana@acme.example",
      linkedinUrl: "https://www.linkedin.com/in/dana-lee",
    };
    const repo = approve(
      { ...good, name: "SWE-agent", linkedinUrl: "https://www.linkedin.com/in/swe" },
      "k1",
    );
    const xUrl = approve({ ...good, name: "Sam Park", linkedinUrl: "https://x.com/sampark" }, "k2");
    const ok = approve(good, "k3");
    const dup = approve(
      {
        ...good,
        name: "Dana L",
        email: "other@acme.example",
        linkedinUrl: "https://de.linkedin.com/in/Dana-Lee/en",
      },
      "k4",
    );

    const out = await drainQueue({ playName: "luma-events", dryRun: false, linkedIn: sender });

    expect(out.errors).toEqual([]);
    expect(out.sent).toBe(1);
    expect(out.skipped).toEqual({ "not-a-person": 1, "invalid-profile": 1, "already-invited": 1 });
    expect(calls.filter((c) => c["kind"] === "invite")).toHaveLength(1);
    const ledger = getLedger();
    expect(ledger.getQueueRow(ok)?.status).toBe("sent");
    for (const id of [repo, xUrl, dup]) {
      const row = ledger.getQueueRow(id)!;
      // Back in front of the founder with the reason persisted, never sent or dropped.
      expect(row.status).toBe("pending");
      const draft = JSON.parse(row.last_draft_json!) as { flags: string[]; sent: boolean };
      expect(draft.sent).toBe(false);
      expect(draft.flags[0]).toMatch(/^(not-a-person|invalid-profile|already-invited):/);
    }
  });
});
