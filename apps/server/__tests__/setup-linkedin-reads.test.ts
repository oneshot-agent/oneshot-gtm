import { beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "bun:sqlite";

// GET /api/setup carries the live-read counter: what reads go through (the
// connected account, else a verified browser session, else nothing), today's
// reads over the day the cap counts, the cap, and how many unsent rows wait
// for a first read. A count the cache cannot answer shows the cap (the reads
// fail closed on it).

const state = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  statements: [] as string[],
  listQueue: vi.fn(),
  account: null as null | { workspace: string; accountId: string },
  accountThrows: false,
  queue: [] as Array<Record<string, unknown>>,
  triggers: [] as Array<{ name: string; config_json: string | null }>,
  /** Reads counted since a given ISO start: UTC midnight vs local midnight differ. */
  countSince: (_since: string): number => 0,
}));

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), ...state.cfg }),
    listSendingDomains: () => Promise.resolve([]),
    identityCapacities: () => new Map(),
    linkedInProfileReadAccount: () => {
      if (state.accountThrows) throw new Error("inbox store unreadable");
      return state.account;
    },
    openLedgerDatabase: (_path: string, opts: { readonly: boolean }) => {
      expect(opts).toEqual({ readonly: true });
      const db = new Database(":memory:");
      db.exec(`CREATE TABLE target_queue (
        id INTEGER, play_name TEXT, status TEXT, sent_at TEXT, send_started_at TEXT,
        payload_json TEXT, found_at TEXT
      )`);
      const insert = db.prepare("INSERT INTO target_queue VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const row of state.queue) {
        insert.run(
          ...([
            row["id"],
            row["play_name"],
            row["status"],
            row["sent_at"],
            row["send_started_at"],
            row["payload_json"],
            "2026-10-01",
          ] as never[]),
        );
      }
      const query = db.query.bind(db);
      db.query = ((sql: string) => {
        state.statements.push(sql);
        return query(sql);
      }) as typeof db.query;
      return db;
    },
    getLedger: () => ({
      filePath: ":memory:",
      listQueue: state.listQueue,
      listTriggers: () => state.triggers,
      countCachedEnrichmentSince: (_prefix: string, since: string) => state.countSince(since),
    }),
  };
});

const { getSetupStatus, linkedInReadsView } = await import("../src/api/setup.ts");
const { loadConfig } = await import("@oneshot-gtm/core");

const LI = "https://www.linkedin.com/in/";
function row(id: number, status: string, payload: Record<string, unknown>, extra = {}) {
  return {
    id,
    play_name: "luma-events",
    source: "luma",
    notes: null,
    status,
    prospect_id: null,
    sent_at: null,
    send_started_at: null,
    payload_json: JSON.stringify(payload),
    ...extra,
  };
}

beforeEach(() => {
  state.cfg = {
    linkedinBrowserProfileId: null,
    linkedinSessionCheckedAt: null,
    linkedinSessionInvalidAt: null,
  };
  state.statements.length = 0;
  state.listQueue
    .mockReset()
    .mockImplementation((opts: { status: string }) =>
      state.queue.filter((r) => r["status"] === opts.status),
    );
  state.account = null;
  state.accountThrows = false;
  state.triggers = [];
  state.countSince = () => 0;
  state.queue = [
    row(1, "pending", { name: "A", linkedinUrl: `${LI}a` }),
    row(2, "approved", { name: "B", linkedinUrl: `${LI}b` }),
    row(3, "pending", {
      name: "C",
      linkedinUrl: `${LI}c`,
      personResearch: { status: "complete", liveProfile: { url: `${LI}c`, readAt: "x" } },
    }),
    row(4, "pending", { name: "D", email: "d@x.dev" }),
    row(5, "approved", { name: "E", linkedinUrl: `${LI}e` }, { send_started_at: "2026-10-20" }),
    row(6, "pending", { name: "F", linkedinUrl: `${LI}f` }, { play_name: "github-stars" }),
  ];
});

describe("linkedInReadsView", () => {
  it("reads through the account, counts from 00:00 UTC, and counts the rows waiting", () => {
    state.account = { workspace: "beta", accountId: "acct-1" };
    state.triggers = [
      { name: "github-stars", config_json: JSON.stringify({ linkedinProfileRead: false }) },
    ];
    const utcMidnight = new Date();
    utcMidnight.setUTCHours(0, 0, 0, 0);
    state.countSince = (since) => (since === utcMidnight.toISOString() ? 41 : 7);
    expect(linkedInReadsView(loadConfig())).toEqual({
      via: "account",
      today: 41,
      perDay: 95,
      // 1 and 2: 3 is read, 4 has no LinkedIn seed, 5 is sending, 6 opted out.
      waiting: 2,
    });
    expect(state.listQueue).not.toHaveBeenCalled();
    expect(state.statements).toHaveLength(2);
    for (const sql of state.statements) {
      expect(sql).not.toMatch(/SELECT\s+\*/i);
      expect(sql).not.toMatch(/(?:SELECT|,)\s*payload_json\s*(?:,|FROM)/i);
      expect(sql).not.toContain("last_draft_json");
      expect(sql).toContain("json_extract");
    }
  });

  it("falls back to a verified browser session, counted over the local day, with the configured cap", () => {
    state.cfg = {
      linkedinBrowserProfileId: "prof_1",
      linkedinSessionCheckedAt: "2026-10-01T10:00:00.000Z",
      linkedinSessionInvalidAt: null,
      linkedinReadsPerDay: 30,
    };
    const localMidnight = new Date();
    localMidnight.setHours(0, 0, 0, 0);
    state.countSince = (since) => (since === localMidnight.toISOString() ? 12 : 99);
    expect(linkedInReadsView(loadConfig())).toMatchObject({
      via: "browser",
      today: 12,
      perDay: 30,
      waiting: 3,
    });
  });

  it("is null when neither can read, and an unreadable inbox store counts as no account", () => {
    state.accountThrows = true;
    state.cfg = {
      linkedinBrowserProfileId: "prof_1",
      linkedinSessionCheckedAt: "2026-10-01T10:00:00.000Z",
      linkedinSessionInvalidAt: "2026-10-02T10:00:00.000Z",
    };
    expect(linkedInReadsView(loadConfig())).toMatchObject({ via: null, today: 0, waiting: 3 });
  });

  it("shows the cap when the count cannot be read (the reads fail closed)", () => {
    state.account = { workspace: "beta", accountId: "acct-1" };
    state.countSince = () => {
      throw new Error("cache down");
    };
    expect(linkedInReadsView(loadConfig())).toMatchObject({ today: 95, perDay: 95 });
  });
});

describe("GET /api/setup", () => {
  it("answers with linkedinReads", async () => {
    state.account = { workspace: "beta", accountId: "acct-1" };
    const res = await getSetupStatus(
      new Request("http://localhost/api/setup", { headers: { host: "127.0.0.1:3030" } }),
    );
    const body = (await res.json()) as { linkedinReads: unknown };
    expect(body.linkedinReads).toEqual({ via: "account", today: 0, perDay: 95, waiting: 3 });
  });
});
