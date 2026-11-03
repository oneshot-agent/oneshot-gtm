import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import type { QueueShow } from "@oneshot-gtm/shared-types";
import { QueueStore } from "../src/ledger-queue.ts";
import { runLedgerMigrations } from "../src/ledger-schema.ts";

/*
 * /queue's Sort, Show and Channel filters run in the store's query, before
 * the page is cut: `listQueue` takes `dir`, `offset`, `show` and `channel`,
 * `countQueue` counts the same rows, and "Approve pending" approves exactly
 * the rows the filtered page lists.
 */

let db: Database;
let store: QueueStore;

beforeEach(() => {
  db = new Database(":memory:");
  runLedgerMigrations(db);
  store = new QueueStore(db);
});

afterEach(() => {
  db.close();
});

const NO_OFFER_PLAYS = ["pmf-survey"];
const OFFER = { offer: "A one-week audit of the Acme checkout.", steps: "We run it." };
const DRAFT = { subject: "Hello", body: "A draft", flags: [], sent: false };

let n = 0;
function row(
  opts: {
    play?: string;
    payload?: Record<string, unknown>;
    draft?: unknown;
    channel?: string;
    status?: "pending" | "approved";
    foundAt?: string;
  } = {},
): number {
  const id = store.enqueueTarget({
    playName: opts.play ?? "intro",
    payload: { name: "Dana", email: `dana${++n}@acme.example`, ...opts.payload },
    dedupeKey: `k-${n}`,
    source: "find:test",
  })!;
  db.query(
    `UPDATE target_queue SET channel = ?, status = ?, found_at = ?, last_draft_json = ? WHERE id = ?`,
  ).run(
    opts.channel ?? "email",
    opts.status ?? "pending",
    opts.foundAt ?? `2026-10-${String(10 + n).padStart(2, "0")} 09:00:00`,
    opts.draft === undefined
      ? null
      : typeof opts.draft === "string"
        ? opts.draft
        : JSON.stringify(opts.draft),
    id,
  );
  return id;
}

const byId = (ids: number[]): number[] => ids.toSorted((a, b) => a - b);

function shown(show: QueueShow, extra: Parameters<QueueStore["listQueue"]>[0] = {}): number[] {
  return store
    .listQueue({ show: { show, noOfferPlays: NO_OFFER_PLAYS }, ...extra })
    .map((r) => r.id);
}

describe("listQueue show filters", () => {
  it("lists and counts each show value", () => {
    const ready = row({ payload: { offer: OFFER }, draft: DRAFT });
    const flagged = row({
      payload: { offer: OFFER },
      draft: { ...DRAFT, flags: ["rule-of-three"] },
    });
    const noDraft = row({ payload: { offer: OFFER } });
    const weak = row({ payload: { offer: { ...OFFER, relevance: "weak" } }, draft: DRAFT });
    const weakApproved = row({
      payload: { offer: { ...OFFER, relevance: "weak", weakApprovedAt: "2026-10-01" } },
    });
    const founderWeak = row({
      payload: { offer: { ...OFFER, relevance: "weak", editedBy: "founder" } },
    });
    const survey = row({ play: "pmf-survey", draft: DRAFT });
    const noOffer = row({ draft: DRAFT });
    const sentDraft = row({ payload: { offer: OFFER }, draft: { ...DRAFT, sent: true } });
    const badDraft = row({ payload: { offer: OFFER }, draft: "{not json" });

    const expected: Record<QueueShow, number[]> = {
      "offer-ready": [
        ready,
        flagged,
        noDraft,
        weakApproved,
        founderWeak,
        survey,
        sentDraft,
        badDraft,
      ],
      "has-draft": [ready, flagged, weak, survey, noOffer],
      "no-draft": [noDraft, weakApproved, founderWeak],
      // A clean draft with its offer ready; the route then drops JS holds.
      ready: [ready, survey],
      // A flagged draft, or an unsent email row whose payload may hold the
      // send (here none carries a fit verdict, so every unsent row may).
      held: [ready, flagged, noDraft, weak, weakApproved, founderWeak, survey, noOffer, badDraft],
    };
    for (const show of Object.keys(expected) as QueueShow[]) {
      expect(byId(shown(show)), show).toEqual(expected[show]);
      expect(
        store.countQueue({ show: { show, noOfferPlays: NO_OFFER_PLAYS } }),
        `${show} count`,
      ).toBe(expected[show].length);
    }
  });

  it("never counts a malformed draft as flagged", () => {
    const flagged = row({ payload: { icpVerdict: "pass" }, draft: { ...DRAFT, flags: ["x"] } });
    const malformed = row({ payload: { icpVerdict: "pass" }, draft: '{"flags": ["x"]' });
    expect(shown("held")).toEqual([flagged]);
    expect(shown("held")).not.toContain(malformed);
  });

  it("narrows held candidates by the payload's fit verdict", () => {
    const pass = row({ payload: { icpVerdict: "pass" } });
    const reject = row({ payload: { icpVerdict: "reject" } });
    const mismatch = row({
      payload: { icpVerdict: "pass", emailMismatch: { emailDomain: "x.io" } },
    });
    const weak = row({ payload: { icpVerdict: "pass", offer: { ...OFFER, relevance: "weak" } } });
    const flagged = row({ payload: { icpVerdict: "pass" }, draft: { ...DRAFT, flags: ["x"] } });
    const linkedin = row({ payload: { icpVerdict: "reject" }, channel: "linkedin" });
    expect(shown("held").toSorted((a, b) => a - b)).toEqual([reject, mismatch, weak, flagged]);
    expect(shown("held")).not.toContain(pass);
    expect(shown("held")).not.toContain(linkedin);
  });

  it("orders newest or oldest first and pages with an offset", () => {
    const a = row({ foundAt: "2026-10-01 09:00:00", draft: DRAFT });
    const b = row({ foundAt: "2026-10-03 09:00:00", draft: DRAFT });
    const c = row({ foundAt: "2026-10-02 09:00:00" });
    const d = row({ foundAt: "2026-10-04 09:00:00", draft: DRAFT });
    expect(store.listQueue({ status: "pending" }).map((r) => r.id)).toEqual([d, b, c, a]);
    expect(store.listQueue({ status: "pending", dir: "asc" }).map((r) => r.id)).toEqual([
      a,
      c,
      b,
      d,
    ]);
    expect(shown("has-draft", { status: "pending", dir: "asc", limit: 1, offset: 1 })).toEqual([b]);
    expect(shown("has-draft", { status: "pending", limit: 2, offset: 1 })).toEqual([b, a]);
    expect(
      store.countQueue({ status: "pending", show: { show: "has-draft", noOfferPlays: [] } }),
    ).toBe(3);
  });

  it("filters by channel, reading an unknown stored channel as email", () => {
    const email = row();
    const linkedin = row({ channel: "linkedin" });
    const odd = row({ channel: "carrier-pigeon" });
    const x = row({ channel: "x" });
    const ids = (channel: string) =>
      store
        .listQueue({ channel })
        .map((r) => r.id)
        .toSorted((p, q) => p - q);
    expect(ids("email")).toEqual([email, odd]);
    expect(ids("linkedin")).toEqual([linkedin]);
    expect(ids("x")).toEqual([x]);
    expect(store.countQueue({ channel: "linkedin" })).toBe(1);
  });

  it("counts rows per play under a status", () => {
    row({ play: "intro" });
    row({ play: "intro" });
    row({ play: "pmf-survey", status: "approved" });
    expect(store.queueCountsByPlay({ status: "pending" })).toEqual({ intro: 2 });
    expect(store.queueCountsByPlay()).toEqual({ intro: 2, "pmf-survey": 1 });
  });
});

describe("approveAllPending with filters", () => {
  it("approves only the pending rows the filters list", () => {
    const ready = row({ payload: { offer: OFFER }, draft: DRAFT });
    const noDraft = row({ payload: { offer: OFFER } });
    const linkedin = row({ payload: { offer: OFFER }, draft: DRAFT, channel: "linkedin" });
    const approved = store.approveAllPending({
      show: { show: "has-draft", noOfferPlays: NO_OFFER_PLAYS },
      channel: "email",
    });
    expect(approved).toBe(1);
    expect(store.getQueueRow(ready)?.status).toBe("approved");
    expect(store.getQueueRow(noDraft)?.status).toBe("pending");
    expect(store.getQueueRow(linkedin)?.status).toBe("pending");
  });

  it("limits the batch to explicit ids, and an empty pick approves nothing", () => {
    const a = row();
    const b = row();
    expect(store.approveAllPending({ ids: [] })).toBe(0);
    expect(store.approveAllPending({ ids: [b] })).toBe(1);
    expect(store.getQueueRow(a)?.status).toBe("pending");
    expect(store.getQueueRow(b)?.status).toBe("approved");
    // A pick past one statement's worth of ids is approved whole.
    const many = Array.from({ length: 450 }, () => row());
    expect(store.approveAllPending({ ids: [...many, b] })).toBe(450);
  });
});
