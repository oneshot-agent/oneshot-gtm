import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "bun:sqlite";
import { QUEUE_SHOWS, type QueueListResponse, type QueueShow } from "@oneshot-gtm/shared-types";
import { NO_OFFER_PLAYS } from "@oneshot-gtm/plays";
import { Ledger } from "../../../packages/core/src/ledger.ts";

// /queue's Sort, Show and Channel filters (GET /api/queue `order`, `show`,
// `channel`, `offset`), over a real ledger: the ledger's SQL agrees with the
// chips' JS (`rowMatchesShow` over `toView`), a `ready` page reads past the
// rows a JS-only hold drops so it stays full, the total is the filtered one,
// and "Approve pending" approves exactly the filtered rows.

let ledger: Ledger;

vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  getLedger: () => ledger,
  logEvent: () => {},
}));
vi.mock("@oneshot-gtm/find", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/find")>("@oneshot-gtm/find")),
  scheduleNewsfeedOnApproval: () => {},
}));

const {
  listQueueRoute,
  approveAllRoute,
  rowMatchesShow,
  toView,
  setApproveScanWindowForTests,
  setShowScanLimitsForTests,
} = await import("../src/api/queue.ts");

const PLAY = "queue-show-filters-play";
const OFFER = { offer: "A one-week audit of the Acme checkout.", steps: "We run it." };
const DRAFT = { subject: "Hello", body: "A draft", flags: [], sent: false };

function raw(): Database {
  return (ledger as unknown as { db: Database }).db;
}

let n = 0;
function row(
  opts: {
    play?: string;
    payload?: Record<string, unknown>;
    draft?: unknown;
    channel?: string;
    status?: "pending" | "approved" | "sent";
    foundAt?: string;
  } = {},
): number {
  const id = ledger.enqueueTarget({
    playName: opts.play ?? PLAY,
    payload: { name: "Dana", email: `dana${++n}@acme.example`, ...opts.payload },
    dedupeKey: `k-${n}`,
    source: "find:test",
  })!;
  raw()
    .query(
      "UPDATE target_queue SET channel = ?, status = ?, found_at = ?, last_draft_json = ? WHERE id = ?",
    )
    .run(
      opts.channel ?? "email",
      opts.status ?? "pending",
      opts.foundAt ??
        new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString().slice(0, 19).replace("T", " "),
      opts.draft === undefined
        ? null
        : typeof opts.draft === "string"
          ? opts.draft
          : JSON.stringify(opts.draft),
      id,
    );
  return id;
}

async function list(query: string): Promise<QueueListResponse> {
  const res = listQueueRoute(new Request(`http://localhost/api/queue?${query}`));
  return (await res.json()) as QueueListResponse;
}

const ids = (body: QueueListResponse): number[] => body.rows.map((r) => r.id);
const sorted = (xs: number[]): number[] => xs.toSorted((a, b) => a - b);

beforeEach(() => {
  ledger = new Ledger(":memory:");
  n = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  ledger.close();
});

/** Rows covering every branch the filters read. */
function seedFixtures(): void {
  const offers = [
    undefined,
    OFFER,
    { ...OFFER, relevance: "weak" },
    { ...OFFER, relevance: "weak", editedBy: "founder" },
    { ...OFFER, relevance: "weak", weakApprovedAt: "2026-10-01T00:00:00Z" },
    { ...OFFER, relevance: "weak", weakApprovedAt: "  " },
    { offer: "  ", steps: "x" },
    { offer: "An offer", steps: 3 },
  ];
  const drafts = [
    undefined,
    DRAFT,
    { ...DRAFT, flags: ["rule-of-three"] },
    { ...DRAFT, sent: true },
    { subject: "No body" },
    "{not json",
    { ...DRAFT, flags: "not-an-array" },
  ];
  const fits = [{}, { icpVerdict: "pass" }, { icpVerdict: "reject" }, { icpVerdict: "unclear" }];
  let i = 0;
  for (const offer of offers) {
    for (const draft of drafts) {
      const fit = fits[i % fits.length]!;
      const mismatch = i % 5 === 0 ? { emailMismatch: { emailDomain: "elsewhere.example" } } : {};
      row({
        play: i % 9 === 0 ? "pmf-survey" : PLAY,
        payload: { ...(offer ? { offer } : {}), ...fit, ...mismatch },
        draft,
        channel: i % 4 === 0 ? "linkedin" : "email",
        status: i % 7 === 0 ? "sent" : i % 3 === 0 ? "approved" : "pending",
      });
      i++;
    }
  }
  // A payload that is not JSON never matches a payload test, and never throws.
  const bad = row();
  raw().query("UPDATE target_queue SET payload_json = '{oops' WHERE id = ?").run(bad);
}

describe("show filters: SQL and the chips' JS agree", () => {
  it("matches exactly for offer-ready, has-draft and no-draft, and is a superset for ready and held", () => {
    seedFixtures();
    const every = ledger.listQueue({ limit: 10_000 });
    const noOfferPlays = [...NO_OFFER_PLAYS];
    for (const show of QUEUE_SHOWS) {
      const js = sorted(every.filter((r) => rowMatchesShow(show, r, toView(r))).map((r) => r.id));
      const sql = sorted(
        ledger.listQueue({ limit: 10_000, show: { show, noOfferPlays } }).map((r) => r.id),
      );
      if (show === "ready" || show === "held") {
        expect(
          js.every((id) => sql.includes(id)),
          show,
        ).toBe(true);
      } else {
        expect(sql, show).toEqual(js);
      }
      expect(js.length, `${show} matches some fixtures`).toBeGreaterThan(0);
    }
  });

  it("lists exactly the JS matches through the route for every show value", async () => {
    seedFixtures();
    const every = ledger.listQueue({ status: "pending", limit: 10_000 });
    for (const show of QUEUE_SHOWS) {
      const body = await list(`status=pending&show=${show}&limit=500`);
      const js = every.filter((r) => rowMatchesShow(show, r, toView(r))).map((r) => r.id);
      expect(sorted(ids(body)), show).toEqual(sorted(js));
      expect(body.total, show).toBe(js.length);
      expect(body.totalIsLowerBound, show).toBeUndefined();
    }
  });
});

describe("GET /api/queue sort, show, channel and offset", () => {
  it("returns the filtered total and pages it with an offset, either way round", async () => {
    const a = row({ draft: DRAFT });
    row();
    const b = row({ draft: DRAFT });
    const c = row({ draft: DRAFT });
    const first = await list("status=pending&show=has-draft&limit=2");
    expect(ids(first)).toEqual([c, b]);
    expect(first.total).toBe(3);
    expect(first.order).toBe("newest");
    expect(ids(await list("status=pending&show=has-draft&limit=2&offset=2"))).toEqual([a]);
    const oldest = await list("status=pending&show=has-draft&order=oldest&limit=2");
    expect(ids(oldest)).toEqual([a, b]);
    expect(oldest.order).toBe("oldest");
    // Without a show filter the total is the status's.
    expect((await list("status=pending&limit=1")).total).toBe(4);
  });

  it("filters by channel", async () => {
    const email = row();
    const linkedin = row({ channel: "linkedin" });
    expect(ids(await list("status=pending&channel=linkedin"))).toEqual([linkedin]);
    expect(ids(await list("status=pending&channel=email"))).toEqual([email]);
    // An unknown channel is refused, never read as no filter.
    expect(
      listQueueRoute(new Request("http://localhost/api/queue?status=pending&channel=fax")).status,
    ).toBe(400);
  });

  it("keeps a ready page full past the rows a fit or mismatch hold drops", async () => {
    // Five ready rows, oldest; then 230 newer rows the SQL keeps as ready but
    // a JS-only hold drops: more than one scan window of them.
    const ready = Array.from({ length: 5 }, () => row({ payload: { offer: OFFER }, draft: DRAFT }));
    for (let i = 0; i < 230; i++) {
      row({
        payload: {
          offer: OFFER,
          ...(i % 2 === 0
            ? { icpVerdict: "reject" }
            : { icpVerdict: "pass", emailMismatch: { emailDomain: "elsewhere.example" } }),
        },
        draft: DRAFT,
      });
    }
    const page = await list("status=pending&show=ready&limit=3");
    expect(ids(page)).toEqual(ready.toReversed().slice(0, 3));
    expect(page.total).toBe(5);
    expect(page.totalIsLowerBound).toBeUndefined();
    // The next page starts after the candidate that filled this one: the 230
    // held rows and three ready ones.
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(233);
    const rest = await list(`status=pending&show=ready&limit=3&offset=${page.nextOffset}`);
    expect(ids(rest)).toEqual(ready.toReversed().slice(3));
    expect(rest.hasMore).toBe(false);
    // Held lists the dropped rows and none of the ready ones.
    const held = await list("status=pending&show=held&limit=500");
    expect(held.total).toBe(230);
    expect(ids(held).some((id) => ready.includes(id))).toBe(false);
  });

  it("reports a floor when the scan stops before the last candidate", async () => {
    const insert = raw().prepare(
      `INSERT INTO target_queue (play_name, payload_json, dedupe_key, source, status, found_at, last_draft_json)
       VALUES (?, ?, ?, 'find:test', 'pending', ?, ?)`,
    );
    raw().transaction(() => {
      for (let i = 0; i < 2300; i++) {
        insert.run(
          PLAY,
          JSON.stringify({ email: `p${i}@acme.example`, icpVerdict: "pass", offer: OFFER }),
          `bulk-${i}`,
          `2026-10-01 ${String(Math.floor(i / 60) % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00`,
          JSON.stringify(DRAFT),
        );
      }
    })();
    const page = await list("status=pending&show=ready&limit=50");
    expect(page.rows).toHaveLength(50);
    expect(page.totalIsLowerBound).toBe(true);
    expect(page.total).toBeGreaterThanOrEqual(2000);
    expect(page.total).toBeLessThan(2300);
  });

  it("resumes a scan that stopped on its budget, so every match is reached once", async () => {
    setShowScanLimitsForTests({ window: 5, budget: 8, max: 10 });
    try {
      // Oldest first: 25 held, 3 ready, 12 held, 2 ready. A request reads at
      // most ten candidates, so the first pages come back empty but not done.
      const held = () => row({ payload: { offer: OFFER, icpVerdict: "reject" }, draft: DRAFT });
      const ready = () => row({ payload: { offer: OFFER }, draft: DRAFT });
      const expected: number[] = [];
      for (let i = 0; i < 25; i++) held();
      for (let i = 0; i < 3; i++) expected.push(ready());
      for (let i = 0; i < 12; i++) held();
      for (let i = 0; i < 2; i++) expected.push(ready());

      const first = await list("status=pending&show=ready&order=oldest&limit=3");
      expect(ids(first)).toEqual([]);
      expect(first.hasMore).toBe(true);
      expect(first.nextOffset).toBe(10);
      expect(first.totalIsLowerBound).toBe(true);

      const seen: number[] = [];
      let page = first;
      let requests = 1;
      while (page.hasMore) {
        page = await list(
          `status=pending&show=ready&order=oldest&limit=3&offset=${page.nextOffset}`,
        );
        seen.push(...ids(page));
        requests++;
        expect(requests).toBeLessThan(20);
      }
      expect(seen).toEqual(expected);
      expect(page.nextOffset).toBe(42);
    } finally {
      setShowScanLimitsForTests({ window: 200, budget: 2000, max: 10_000 });
    }
  });

  it("pages a plain list by row offset, and says when it is done", async () => {
    const all = Array.from({ length: 5 }, () => row());
    const first = await list("status=pending&order=oldest&limit=3");
    expect(ids(first)).toEqual(all.slice(0, 3));
    expect(first).toMatchObject({ nextOffset: 3, hasMore: true, total: 5 });
    const second = await list("status=pending&order=oldest&limit=3&offset=3");
    expect(ids(second)).toEqual(all.slice(3));
    expect(second).toMatchObject({ nextOffset: 5, hasMore: false });
  });

  it("filters the ranked window before ranking, and finishes ready in JS", async () => {
    const drafted = row({ payload: { offer: OFFER }, draft: DRAFT });
    row({ payload: { offer: OFFER } });
    const held = row({ payload: { offer: OFFER, icpVerdict: "reject" }, draft: DRAFT });
    const hasDraft = await list("status=pending&order=ranked&show=has-draft");
    expect(hasDraft.order).toBe("ranked");
    expect(sorted(ids(hasDraft))).toEqual([drafted, held]);
    expect(hasDraft.total).toBe(2);
    const ready = await list("status=pending&order=ranked&show=ready");
    expect(ids(ready)).toEqual([drafted]);
    expect(ready.total).toBe(1);
  });

  it("reports a floor when the ranking window is full", async () => {
    const insert = raw().prepare(
      `INSERT INTO target_queue (play_name, payload_json, dedupe_key, source, status, last_draft_json)
       VALUES (?, ?, ?, 'find:test', 'pending', ?)`,
    );
    raw().transaction(() => {
      for (let i = 0; i < 1005; i++) {
        insert.run(
          PLAY,
          JSON.stringify({ email: `r${i}@acme.example`, icpVerdict: "pass", offer: OFFER }),
          `ranked-${i}`,
          JSON.stringify(DRAFT),
        );
      }
    })();
    const plain = await list("status=pending&order=ranked&limit=10");
    expect(plain.total).toBe(1000);
    expect(plain.totalIsLowerBound).toBe(true);
    const ready = await list("status=pending&order=ranked&show=ready&limit=10");
    expect(ready.rows).toHaveLength(10);
    expect(ready.totalIsLowerBound).toBe(true);
    // A window with room left counts every row.
    const few = await list("status=pending&order=ranked&show=no-draft");
    expect(few.total).toBe(0);
    expect(few.totalIsLowerBound).toBeUndefined();
  });

  it("lists every play with rows under the status, whatever the page shows", async () => {
    row({ play: "alpha" });
    row({ play: "beta", draft: DRAFT });
    row({ play: "gamma", status: "approved" });
    const body = await list("status=pending&show=has-draft&play=beta");
    expect(body.playCounts).toEqual({ alpha: 1, beta: 1 });
  });
});

describe("Approve pending with a filter on", () => {
  async function approveAll(body: Record<string, unknown>): Promise<number> {
    const res = await approveAllRoute(
      new Request("http://localhost/api/queue/approve-all", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    return ((await res.json()) as { approved: number }).approved;
  }

  it("refuses an unknown show or channel instead of approving every pending row", async () => {
    const pending = row({ payload: { offer: OFFER }, draft: DRAFT });
    for (const body of [{ show: "redy" }, { channel: "fax" }]) {
      const res = await approveAllRoute(
        new Request("http://localhost/api/queue/approve-all", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
      expect(res.status).toBe(400);
    }
    expect(ledger.getQueueRow(pending)?.status).toBe("pending");
    const list = await listQueueRoute(new Request("http://localhost/api/queue?show=redy"));
    expect(list.status).toBe(400);
  });

  it("approves only the rows the filtered list shows, JS holds included", async () => {
    const ready = row({ payload: { offer: OFFER }, draft: DRAFT });
    const fitHeld = row({ payload: { offer: OFFER, icpVerdict: "reject" }, draft: DRAFT });
    const noDraft = row({ payload: { offer: OFFER } });
    const linkedin = row({ payload: { offer: OFFER }, draft: DRAFT, channel: "linkedin" });
    expect(await approveAll({ show: "ready", channel: "email" })).toBe(1);
    expect(ledger.getQueueRow(ready)?.status).toBe("approved");
    for (const id of [fitHeld, noDraft, linkedin]) {
      expect(ledger.getQueueRow(id)?.status).toBe("pending");
    }
    expect(await approveAll({ show: "has-draft" as QueueShow })).toBe(2);
    expect(ledger.getQueueRow(noDraft)?.status).toBe("pending");
  });

  it("approves matches past the first scan window", async () => {
    setApproveScanWindowForTests(3);
    try {
      // Ten ready rows, a fit-held one between each pair: the matches span
      // every window of three, the last one past the ninth row.
      const ready: number[] = [];
      for (let i = 0; i < 10; i++) {
        ready.push(row({ payload: { offer: OFFER }, draft: DRAFT }));
        row({ payload: { offer: OFFER, icpVerdict: "reject" }, draft: DRAFT });
      }
      expect(await approveAll({ show: "ready" })).toBe(10);
      for (const id of ready) expect(ledger.getQueueRow(id)?.status).toBe("approved");
      expect(ledger.countQueue({ status: "pending" })).toBe(10);
    } finally {
      setApproveScanWindowForTests(1000);
    }
  });
});
