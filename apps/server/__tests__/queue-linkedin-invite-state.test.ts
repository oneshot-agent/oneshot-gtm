import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../../../packages/core/src/ledger.ts";

// GET /api/queue: a sent LinkedIn row says where its invite stands, so /queue
// offers Withdraw only while the invite is pending. Read for the whole page
// at once. Real ledger.

let ledger: Ledger;

vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  getLedger: () => ledger,
  logEvent: () => {},
}));

const { listQueueRoute } = await import("../src/api/queue.ts");

const PLAY = "queue-linkedin-invite-state-play";

let n = 0;
/** A sent LinkedIn row with its prospect, and the invite it went out with. */
function sentRow(meta: Record<string, unknown> = {}): { id: number; prospectId: number } {
  const slug = `person-${++n}`;
  const linkedinUrl = `https://www.linkedin.com/in/${slug}`;
  const id = ledger.enqueueTarget({
    playName: PLAY,
    payload: { name: "Dana Lee", linkedinUrl },
    dedupeKey: `k-${slug}`,
    source: "find:test",
    channel: "linkedin",
  })!;
  ledger.setQueueStatus({ id, status: "sent" });
  const prospectId = ledger.upsertProspect({ name: "Dana Lee", linkedin_url: linkedinUrl });
  ledger.setQueueProspectId(id, prospectId);
  ledger.recordLinkedInInviteEvent({
    prospectId,
    playName: PLAY,
    stepIndex: 0,
    status: "sent",
    metadata: { invitationId: `inv-${slug}`, queueId: id, ...meta },
  });
  return { id, prospectId };
}

async function list(): Promise<Array<Record<string, any>>> {
  const res = listQueueRoute(new Request("http://localhost/api/queue?status=sent"));
  return ((await res.json()) as { rows: Array<Record<string, any>> }).rows;
}

beforeEach(() => {
  ledger = new Ledger(":memory:");
});
afterEach(() => {
  vi.restoreAllMocks();
  ledger.close();
});

describe("a sent LinkedIn row's invite state", () => {
  it("reads pending, withdrawn and accepted for the page in one query", async () => {
    const pending = sentRow();
    const withdrawn = sentRow();
    ledger.recordLinkedInInviteEvent({
      prospectId: withdrawn.prospectId,
      playName: PLAY,
      stepIndex: 0,
      status: "withdrawn",
      metadata: { withdrawnBy: "timeout" },
    });
    const accepted = sentRow({ acceptedAt: "2026-10-20T00:00:00Z" });

    const bulk = vi.spyOn(ledger, "listLinkedInInviteEventsForProspects");
    const single = vi.spyOn(ledger, "listLinkedInInviteEvents");
    const rows = await list();

    expect(bulk).toHaveBeenCalledTimes(1);
    expect(single).not.toHaveBeenCalled();
    const of = (id: number) => rows.find((r) => r["id"] === id)!;
    expect(of(pending.id)["linkedinInvite"]).toEqual({ state: "pending" });
    expect(of(withdrawn.id)["linkedinInvite"]).toEqual({
      state: "withdrawn",
      withdrawnBy: "timeout",
    });
    expect(of(accepted.id)["linkedinInvite"]).toEqual({ state: "accepted" });
  });

  it("reads a row whose invite a later row replaced as ended, not pending", async () => {
    const first = sentRow({ queueId: 9999 });
    const [view] = await list();
    expect(view!["id"]).toBe(first.id);
    expect(view!["linkedinInvite"]).toEqual({ state: "ended" });
  });

  it("leaves a known connection and an email row without an invite state", async () => {
    sentRow({ via: "profile-read", inviteStatus: "already_connected" });
    const emailId = ledger.enqueueTarget({
      playName: PLAY,
      payload: { name: "Sam Park", email: "sam@firm.example" },
      dedupeKey: "k-email",
      source: "find:test",
    })!;
    ledger.setQueueStatus({ id: emailId, status: "sent" });
    const rows = await list();
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).not.toHaveProperty("linkedinInvite");
  });
});
