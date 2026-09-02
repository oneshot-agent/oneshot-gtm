import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { Ledger } from "../src/ledger.ts";

let dbPath: string;
let ledger: Ledger;

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-outcomes-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
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

const rawDb = (): Database => (ledger as unknown as { db: Database }).db;

function sentRow(email: string | null, opts: { prospectId?: number; play?: string } = {}): number {
  const id = ledger.enqueueTarget({
    playName: opts.play ?? "post-funding",
    payload: email ? { name: "x", email } : { name: "x" },
    dedupeKey: `k-${Math.random().toString(36).slice(2)}`,
    source: "test",
  })!;
  if (opts.prospectId !== undefined) ledger.setQueueProspectId(id, opts.prospectId);
  ledger.setQueueStatus({ id, status: "sent" });
  return id;
}

function insertReply(prospectId: number, kind: string | null, receivedAt = "2026-09-01T10:00:00Z") {
  rawDb()
    .prepare(
      `INSERT INTO inbox_replies(id, thread_key, prospect_id, from_email, body, received_at, kind)
       VALUES(?, 't', ?, 'x@y.z', 'hi', ?, ?)`,
    )
    .run(`r-${Math.random().toString(36).slice(2)}`, prospectId, receivedAt, kind);
}

describe("listSentOutcomeRows", () => {
  it("joins by prospect_id directly and by email fallback (case/whitespace)", () => {
    const direct = ledger.upsertProspect({ email: "direct@acme.dev" });
    const idDirect = sentRow(null, { prospectId: direct });
    const fallback = ledger.upsertProspect({ email: "fallback@acme.dev" });
    const idFallback = sentRow("  Fallback@Acme.DEV  "); // no prospect_id on the row
    const idUnjoinable = sentRow("nobody@unknown.dev");

    const rows = ledger.listSentOutcomeRows();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(idDirect)!.joined_prospect_id).toBe(direct);
    expect(byId.get(idFallback)!.joined_prospect_id).toBe(fallback);
    expect(byId.get(idUnjoinable)!.joined_prospect_id).toBeNull();
  });

  it("counts only human replies — machine kinds no, pre-classifier NULL yes", () => {
    const pHuman = ledger.upsertProspect({ email: "h@a.dev" });
    const pAuto = ledger.upsertProspect({ email: "a@a.dev" });
    const pLegacy = ledger.upsertProspect({ email: "l@a.dev" });
    const idHuman = sentRow(null, { prospectId: pHuman });
    const idAuto = sentRow(null, { prospectId: pAuto });
    const idLegacy = sentRow(null, { prospectId: pLegacy });
    insertReply(pHuman, "human");
    insertReply(pAuto, "auto");
    insertReply(pAuto, "auto_permanent");
    insertReply(pLegacy, null); // pre-v23: NULL reads as human

    const byId = new Map(ledger.listSentOutcomeRows().map((r) => [r.id, r]));
    expect(byId.get(idHuman)!.first_email_reply_at).not.toBeNull();
    expect(byId.get(idAuto)!.first_email_reply_at).toBeNull();
    expect(byId.get(idLegacy)!.first_email_reply_at).not.toBeNull();
  });

  it("surfaces LinkedIn replies and positive deal outcomes; deal_lost is never a rank", () => {
    const pLi = ledger.upsertProspect({ email: "li@a.dev" });
    const idLi = sentRow(null, { prospectId: pLi });
    rawDb()
      .prepare(
        `INSERT INTO channel_events(prospect_id, channel, event_type, source, external_event_id, occurred_at)
         VALUES(?, 'linkedin', 'reply', 'expandi', 'e1', '2026-09-01T09:00:00Z')`,
      )
      .run(pLi);

    const pDeal = ledger.upsertProspect({ email: "deal@a.dev" });
    const idDeal = sentRow(null, { prospectId: pDeal });
    ledger.recordOutcome({ prospectId: pDeal, outcome: "meeting_booked" });

    const pLost = ledger.upsertProspect({ email: "lost@a.dev" });
    const idLost = sentRow(null, { prospectId: pLost });
    ledger.recordOutcome({ prospectId: pLost, outcome: "deal_lost" });

    const byId = new Map(ledger.listSentOutcomeRows().map((r) => [r.id, r]));
    expect(byId.get(idLi)!.first_channel_reply_at).not.toBeNull();
    expect(byId.get(idDeal)!.deal_rank).toBe(2);
    // deal_outcomes is positives-only by construction; a lost deal is not
    // evidence of anything at the send-label level.
    expect(byId.get(idLost)!.deal_rank).toBeNull();
  });

  it("scopes by play and returns only sent rows", () => {
    sentRow(null, { play: "show-hn" });
    const pending = ledger.enqueueTarget({
      playName: "show-hn",
      payload: {},
      dedupeKey: "p1",
      source: "test",
    })!;
    const rows = ledger.listSentOutcomeRows({ playName: "show-hn" });
    expect(rows).toHaveLength(1);
    expect(rows.map((r) => r.id)).not.toContain(pending);
    expect(ledger.listSentOutcomeRows({ playName: "luma-events" })).toHaveLength(0);
  });
});

describe("listValueTaggedReceipts", () => {
  it("returns only value-tagged receipts with goal ids", () => {
    rawDb()
      .prepare(
        `INSERT INTO receipts(play_name, call_type, cost_usd, goal_id, value_tag)
         VALUES('post-funding', 'email.send', 0.1, 'goal_abc', '{"type":"engagement"}')`,
      )
      .run();
    rawDb()
      .prepare(
        `INSERT INTO receipts(play_name, call_type, cost_usd)
         VALUES('post-funding', 'email.send', 0.1)`,
      )
      .run();
    const tagged = ledger.listValueTaggedReceipts();
    expect(tagged).toHaveLength(1);
    expect(tagged[0]).toEqual({ goal_id: "goal_abc", value_tag: '{"type":"engagement"}' });
  });
});
