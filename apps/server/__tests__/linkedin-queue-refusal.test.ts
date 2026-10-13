import { describe, expect, it, vi } from "vitest";
import { getLedger } from "@oneshot-gtm/core";

// A manual /queue send the invite guard refuses, against the real ledger in the
// per-file temp ONESHOT_GTM_HOME (vitest.setup.ts): the reason and the
// recoverable disposition must survive into the next queue read (#787).
// Only the OneShot transport and the connected account are faked.

const linkedInCalls: Array<Record<string, unknown>> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    linkedInOutreachAccount: () => ({ workspace: "alpha", accountId: "acct-refusal" }),
  };
});
vi.mock("../src/linkedin-client.ts", () => ({
  callLinkedIn: async (_workspace: string, op: Record<string, unknown>) => {
    linkedInCalls.push(op);
    if (op["kind"] === "account") return {};
    return { invitation_id: "inv-1", status: "sent" };
  },
}));

const { sendDraftRoute, listQueueRoute } = await import("../src/api/queue.ts");

const post = () => new Request("http://localhost/api/queue/1/send", { method: "POST" });

function approvedRow(payload: Record<string, unknown>, key: string): number {
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

describe("a refused manual LinkedIn send persists its reason", () => {
  it("saves the guard flag and returns the row to pending, readable on the next queue read", async () => {
    const id = approvedRow(
      { name: "SWE-agent", linkedinUrl: "https://www.linkedin.com/in/swe-agent" },
      "refusal-1",
    );

    const res = await sendDraftRoute(post(), { id: String(id) });
    expect(res.status).toBe(409);
    expect(linkedInCalls.filter((c) => c["kind"] === "invite")).toHaveLength(0);

    // A fresh read from the ledger, not the route's response.
    const row = getLedger().getQueueRow(id)!;
    expect(row.status).toBe("pending");
    expect(row.sent_at).toBeNull();
    expect(row.send_started_at).toBeNull();
    const draft = JSON.parse(row.last_draft_json!) as {
      flags: string[];
      sent: boolean;
      body: string;
    };
    expect(draft.sent).toBe(false);
    expect(draft.body).toBe("hello there");
    expect(draft.flags[0]).toMatch(/^not-a-person:/);

    // What /queue renders from.
    const list = (await (
      await listQueueRoute(new Request("http://localhost/api/queue?status=pending"))
    ).json()) as { rows?: Array<{ id: number; lastDraft: { flags: string[] } | null }> };
    const listed = (list.rows ?? []).find((r) => r.id === id);
    expect(listed?.lastDraft?.flags[0]).toMatch(/^not-a-person:/);
  });

  it("is recoverable: fix the row, approve it again, and the same row sends", async () => {
    const id = approvedRow(
      { name: "Se7en", linkedinUrl: "https://www.linkedin.com/in/dana-fix" },
      "refusal-2",
    );
    expect((await sendDraftRoute(post(), { id: String(id) })).status).toBe(409);

    const ledger = getLedger();
    ledger.updateQueuePayload({
      id,
      payload: { name: "Dana Fix", linkedinUrl: "https://www.linkedin.com/in/dana-fix" },
    });
    ledger.setQueueStatus({ id, status: "approved", decidedBy: "human" });
    const again = await sendDraftRoute(post(), { id: String(id) });
    expect(again.status).toBe(200);
    expect(linkedInCalls.filter((c) => c["kind"] === "invite")).toHaveLength(1);
  });
});
