import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Ledger } from "../../../packages/core/src/ledger.ts";
import { SharedPeople } from "../../../packages/core/src/shared-people.ts";

// GET /api/inbox builds every conversation from reads made once for the
// page (#935): the prospect rows, the persisted replies and the sent steps
// of every replying prospect, one read each. No conversation re-reads its
// prospect, its replies or its steps, so the ledger reads of a request are
// constant in the number of replying prospects. Real ledger with the shared
// person registry a workspace ledger opens in production (so the prospects'
// shared identities are part of what is counted), spied.

let root: string;
let ledger: Ledger;

vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  getLedger: () => ledger,
  loadConfig: () => ({ sendingDomain: "mysender.com" }),
  logEvent: () => {},
  resolveIdentities: () => [],
  listInbox: async () => ({ emails: [], has_more: false }),
  listRepliesFrom: async () => [],
}));

const { listInboxRoute, _resetLiveInboxCache } = await import("../src/api/inbox.ts");

const PLAY = "inbox-conversation-reads-play";

/** A prospect with one sent outreach step and one persisted reply to it. */
function replier(i: number): number {
  const email = `owner${i}@firm${i}.example`;
  const id = ledger.upsertProspect({
    name: `Owner ${i}`,
    email,
    company: `Firm ${i}`,
    source: PLAY,
  });
  ledger.recordSequenceEvent({
    prospectId: id,
    playName: PLAY,
    stepIndex: 0,
    channel: "email",
    status: "replied",
    metadata: { subject: `hello ${i}`, body: `outreach ${i}` },
  });
  ledger.recordInboxReply({
    id: `reply-${i}`,
    threadKey: `thread-${i}`,
    prospectId: id,
    playName: PLAY,
    fromEmail: email,
    subject: `Re: hello ${i}`,
    body: `answer ${i}`,
    receivedAt: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T10:00:00.000Z`,
  });
  return id;
}

type Conversation = { prospectId: number; items: Array<{ kind: string; body: string | null }> };

/** One request, past the shared live-inbox read, so every call takes the same path. */
async function conversations(): Promise<Conversation[]> {
  _resetLiveInboxCache();
  const res = await listInboxRoute(new Request("http://localhost/api/inbox"));
  return ((await res.json()) as { conversations: Conversation[] }).conversations;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "inbox-conversation-reads-"));
  ledger = new Ledger(join(root, "ledger.sqlite"), {
    sharedPeoplePath: join(root, "shared.sqlite"),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  ledger.close();
  rmSync(root, { recursive: true, force: true });
});

describe("listInboxRoute conversation reads", () => {
  it("reads the page once: a request's ledger reads are constant in the number of replying prospects", async () => {
    const FEW = 3;
    const MORE = 15;
    const ids = Array.from({ length: FEW }, (_, i) => replier(i));
    // Settles what a first request reads once per process (the singleton the
    // mailbox view opens), so the two measured requests take the same path.
    await conversations();

    const query = vi.spyOn(Database.prototype, "query");
    const perProspect = {
      getProspectById: vi.spyOn(ledger, "getProspectById"),
      listInboxRepliesForProspect: vi.spyOn(ledger, "listInboxRepliesForProspect"),
      listSequenceEventsForProspect: vi.spyOn(ledger, "listSequenceEventsForProspect"),
    };
    const page = {
      listProspectsByIds: vi.spyOn(ledger, "listProspectsByIds"),
      listInboxRepliesForProspects: vi.spyOn(ledger, "listInboxRepliesForProspects"),
      listSequenceEventsForProspects: vi.spyOn(ledger, "listSequenceEventsForProspects"),
    };

    expect(await conversations()).toHaveLength(FEW);
    const readsForFew = query.mock.calls.length;
    expect(readsForFew).toBeGreaterThan(0);

    for (let i = FEW; i < MORE; i++) ids.push(replier(i));
    // Every replier is linked to a shared person, so each conversation's
    // identity comes from the registry: one bulk read, never one per person.
    const personIds = ids.map((id) => ledger.getProspectById(id)!.shared_person_id!);
    expect(new Set(personIds).size).toBe(MORE);
    perProspect.getProspectById.mockClear();
    const personGet = vi.spyOn(SharedPeople.prototype, "get");
    const personGetMany = vi.spyOn(SharedPeople.prototype, "getMany");
    query.mockClear();
    const views = await conversations();
    expect(views).toHaveLength(MORE);
    // The whole point (#935): the same number of reads for five times the prospects.
    expect(query.mock.calls.length).toBe(readsForFew);

    for (const spy of Object.values(perProspect)) expect(spy).not.toHaveBeenCalled();
    expect(personGet).not.toHaveBeenCalled();
    expect(personGetMany).toHaveBeenCalledTimes(1);
    expect(personGetMany.mock.calls[0]![0].toSorted()).toEqual(personIds.toSorted());
    for (const spy of Object.values(page)) {
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[1]![0]).toHaveLength(MORE);
    }

    // And every conversation still carries what those reads hold.
    for (const [i, id] of ids.entries()) {
      const v = views.find((c) => c.prospectId === id)!;
      expect(v.items.map((it) => `${it.kind}:${it.body}`).toSorted()).toEqual([
        `outreach:outreach ${i}`,
        `reply:answer ${i}`,
      ]);
    }
  });
});
