import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "bun:sqlite";

// The scheduler's live-profile sweep: only live rows with a LinkedIn seed
// and no live read qualify, approved first; a trigger can opt its play out;
// the sweep stops where the read path stops (daily cap, login wall) and at
// its own row and spend caps; nothing runs without a connected account or a
// verified session. A read older than its max age is read again, and people
// in a cadence are re-read every 14 days with the reads left over.

let cfg: Record<string, unknown> = {};
let demo = false;
let triggers: Array<{ name: string; config_json: string | null }> = [];
let queue: Array<Record<string, unknown>> = [];
let cadences: Array<{ prospect_id: number; play_name: string; enrolled_at: string }> = [];
let prospects: Record<number, Record<string, unknown>> = {};
let readAccount: { workspace: string; accountId: string } | null = null;
const events: string[] = [];
const statements: string[] = [];
const loadedIds: number[] = [];

// Run the production projection against SQLite, with the same rows as the
// pure selector fixtures. Every connection is isolated and closed by its caller.
function queueDatabase(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE target_queue (
    id INTEGER, play_name TEXT, status TEXT, sent_at TEXT, send_started_at TEXT,
    payload_json TEXT, last_draft_json TEXT, found_at TEXT
  )`);
  const insert = db.prepare("INSERT INTO target_queue VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const row of queue) {
    insert.run(
      ...([
        row["id"],
        row["play_name"],
        row["status"],
        row["sent_at"],
        row["send_started_at"],
        row["payload_json"],
        "unused draft",
        "2026-10-01",
      ] as never[]),
    );
  }
  const query = db.query.bind(db);
  db.query = ((sql: string) => {
    statements.push(sql);
    return query(sql);
  }) as typeof db.query;
  return db;
}

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    demoMode: () => demo,
    loadConfig: () => ({ ...actual.loadConfig(), ...cfg }),
    logEvent: (kind: string) => {
      events.push(kind);
    },
    linkedInProfileReadAccount: () => readAccount,
    openLedgerDatabase: () => queueDatabase(),
    getLedger: () => ({
      filePath: ":memory:",
      listTriggers: () => triggers,
      getQueueRow: (id: number) => {
        loadedIds.push(id);
        return queue.find((r) => r["id"] === id) ?? null;
      },
      listQueue: (opts: { status: string }) => queue.filter((r) => r["status"] === opts.status),
      listActiveCadences: () => cadences,
      getProspectById: (id: number) => prospects[id] ?? null,
    }),
  };
});

const {
  countLiveReadsWaiting,
  listLiveReadRows,
  liveReadOffByPlay,
  selectCadenceRefreshCandidates,
  selectLiveSweepCandidates,
  sweepLiveProfiles,
} = await import("../src/_live-profile-sweep.ts");

const { getLedger } = await import("@oneshot-gtm/core");

const LI = "https://www.linkedin.com/in/";
function row(
  id: number,
  status: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
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
  demo = false;
  cfg = {
    linkedinBrowserProfileId: "prof_1",
    linkedinSessionCheckedAt: "2026-09-14T10:18:52.694Z",
    linkedinSessionInvalidAt: null,
  };
  triggers = [];
  cadences = [];
  prospects = {};
  readAccount = null;
  events.length = 0;
  statements.length = 0;
  loadedIds.length = 0;
  queue = [
    row(1, "pending", { name: "A", linkedinUrl: `${LI}a` }),
    row(2, "approved", { name: "B", linkedinUrl: `${LI}b` }),
    row(3, "pending", {
      name: "C",
      linkedinUrl: `${LI}c`,
      personResearch: { status: "complete", liveProfile: { url: `${LI}c`, readAt: "x" } },
    }),
    row(4, "pending", { name: "D", email: "d@x.dev" }),
    row(5, "pending", { name: "E", linkedinUrl: `${LI}e` }, { sent_at: "2026-09-13" }),
    row(6, "pending", { name: "F", linkedinUrl: `${LI}f` }, { play_name: "github-stars" }),
    row(7, "approved", { name: "G", linkedinUrl: `${LI}g` }),
  ];
});
afterEach(() => {
  delete process.env["LINKEDIN_SESSION_COOKIE"];
});

describe("selectLiveSweepCandidates", () => {
  it("keeps live LinkedIn rows without a live read, approved first then newest, and honours a play opt-out", () => {
    const picked = selectLiveSweepCandidates(queue as never, (play) => play === "github-stars");
    expect(picked.map((c) => c.row.id)).toEqual([7, 2, 1]);
    expect(picked[0]?.seed.url).toBe("https://linkedin.com/in/g");
  });

  it("re-reads an approved row once its read is 30 days old, never a pending one", () => {
    const now = Date.parse("2026-10-12T12:00:00.000Z");
    const readDaysAgo = (id: number, status: string, days: number) =>
      row(id, status, {
        name: `R${id}`,
        linkedinUrl: `${LI}r${id}`,
        personResearch: {
          status: "complete",
          liveProfile: {
            url: `${LI}r${id}`,
            readAt: new Date(now - days * 86_400_000).toISOString(),
          },
        },
      });
    const picked = selectLiveSweepCandidates(
      [
        readDaysAgo(31, "approved", 31),
        readDaysAgo(32, "approved", 29),
        // Opening a pending row reads it again; the sweep leaves it.
        readDaysAgo(33, "pending", 31),
      ] as never,
      () => false,
      now,
    );
    expect(picked.map((c) => c.row.id)).toEqual([31]);
  });

  it("ranks approved never read, then pending never read newest first, then approved re-reads", () => {
    const now = Date.parse("2026-10-12T12:00:00.000Z");
    const aged = (id: number) =>
      row(id, "approved", {
        name: `R${id}`,
        linkedinUrl: `${LI}r${id}`,
        personResearch: {
          status: "complete",
          liveProfile: {
            url: `${LI}r${id}`,
            readAt: new Date(now - 40 * 86_400_000).toISOString(),
          },
        },
      });
    const fresh = (id: number, status: string) =>
      row(id, status, { name: `N${id}`, linkedinUrl: `${LI}n${id}` });
    const picked = selectLiveSweepCandidates(
      [
        aged(90),
        fresh(10, "pending"),
        aged(5),
        fresh(11, "approved"),
        fresh(12, "pending"),
      ] as never,
      () => false,
      now,
    );
    expect(picked.map((c) => c.row.id)).toEqual([11, 12, 10, 90, 5]);
  });

  it("leaves a row alone for three days after an attempt that failed for a reason of its own", () => {
    const now = Date.parse("2026-10-12T12:00:00.000Z");
    const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    const tried = (id: number, status: string, hours: number, warning?: string) =>
      row(id, "pending", {
        name: `P${id}`,
        linkedinUrl: `${LI}p${id}`,
        personResearch: { status, researchedAt: ago(hours), ...(warning ? { warning } : {}) },
      });
    const rows = [
      // About the person: the page or the profile is someone else's, the read
      // failed, nobody has any history for them.
      tried(11, "partial", 2, "live profile skipped: different-person"),
      tried(12, "partial", 2, "live profile skipped: failed"),
      tried(
        13,
        "unavailable",
        2,
        "profile URL belongs to a different person (Jane Roe); title and verdict left as they were",
      ),
      tried(14, "unavailable", 2, "person research returned no organisation history"),
      // Long enough ago: tried again.
      tried(15, "partial", 73, "live profile skipped: failed"),
      // Not about the person: the session, the daily cap, a cost cap, a provider
      // that failed, a read that did not finish.
      tried(16, "partial", 2, "live profile skipped: session-invalid"),
      tried(17, "partial", 2, "live profile skipped: daily-limit"),
      tried(21, "partial", 2, "live profile skipped: interrupted"),
      tried(18, "unavailable", 2, "person research skipped: cost cap reached"),
      tried(19, "unavailable", 2, "person research failed"),
      // Researched with no live attempt recorded at all.
      tried(20, "complete", 2),
    ];
    const picked = selectLiveSweepCandidates(rows as never, () => false, now);
    expect(picked.map((c) => c.row.id)).toEqual([21, 20, 19, 18, 17, 16, 15]);
  });
});

describe("countLiveReadsWaiting", () => {
  it("counts live LinkedIn rows with no live read, whatever their last attempt, minus opted-out plays", () => {
    const rows = [
      ...queue,
      row(8, "pending", {
        name: "H",
        linkedinUrl: `${LI}h`,
        personResearch: {
          status: "partial",
          researchedAt: new Date().toISOString(),
          warning: "live profile skipped: failed",
        },
      }),
      row(9, "rejected", { name: "I", linkedinUrl: `${LI}i` }),
    ];
    queue = [
      ...rows,
      row(10, "pending", { linkedinUrl: `${LI}j` }, { send_started_at: "2026-10-01" }),
      row(11, "pending", {}, { payload_json: "broken JSON" }),
      row(12, "pending", {}, { payload_json: "null" }),
      row(13, "pending", { linkedinUrl: "https://x.com/first", profileUrl: `${LI}later` }),
      row(14, "pending", { linkedinUrl: "https://linkedin.com/company/acme" }),
      ...[
        "linkedinUrl",
        "sourceProfileUrl",
        "profileUrl",
        "authorUrl",
        "twitterUrl",
        "xUrl",
        "githubUrl",
      ].map((key, i) => row(20 + i, "pending", { [key]: "  linkedin.com/in/Zoë?test=1#bio  " })),
      ...[null, false, 0, "read", []].map((marker, i) =>
        row(30 + i, "approved", {
          linkedinUrl: `${LI}marker`,
          personResearch: { liveProfile: marker },
        }),
      ),
      row(40, "approved", { linkedinUrl: `${LI}read`, personResearch: { liveProfile: {} } }),
      row(41, "approved", {
        linkedinUrl: {},
        sourceProfileUrl: `${LI}fallback`,
        irrelevant: "x".repeat(100_000),
      }),
      row(42, "pending", { linkedinUrl: "http://[", sourceProfileUrl: `${LI}valid` }),
      row(43, "pending", { email: "a@example.test", name: "Email only" }),
      row(44, "approved", {
        linkedinUrl: `${LI}old`,
        personResearch: {
          liveProfile: { readAt: "2020-01-01" },
          researchedAt: new Date().toISOString(),
          warning: "live profile skipped: failed",
        },
      }),
      row(45, "approved", {
        linkedinUrl: `${LI}old`,
        personResearch: {
          liveProfile: { readAt: "2020-01-01" },
        },
      }),
    ];
    const projected = listLiveReadRows(getLedger());
    triggers = [
      { name: "github-stars", config_json: JSON.stringify({ linkedinProfileRead: false }) },
    ];
    const off = liveReadOffByPlay(getLedger());
    expect(countLiveReadsWaiting(projected, off)).toBe(countLiveReadsWaiting(queue as never, off));
    expect(countLiveReadsWaiting(projected, off)).toBe(18);
    const now = Date.now();
    expect(selectLiveSweepCandidates(projected, off, now).map((c) => c.row.id)).toEqual(
      selectLiveSweepCandidates(queue as never, off, now).map((c) => c.row.id),
    );
    expect(statements).toHaveLength(2);
    for (const sql of statements) {
      expect(sql).not.toMatch(/SELECT\s+\*/i);
      expect(sql).not.toMatch(/(?:SELECT|,)\s*payload_json\s*(?:,|FROM)/i);
      expect(sql).not.toContain("last_draft_json");
      expect(sql).toContain("json_extract");
    }
    expect(JSON.stringify(projected)).not.toContain("x".repeat(100_000));
    // 1, 2, 7 and 8; 3 is read, 4 has no LinkedIn seed, 5 is sent, 6 opted out, 9 is not live.
    expect(countLiveReadsWaiting(rows as never, (play) => play === "github-stars")).toBe(4);
  });
});

function prospect(id: number, dossier: unknown, url: string | null = `${LI}p${id}`) {
  return {
    id,
    name: `Person ${id}`,
    company: "Acme",
    email: `p${id}@acme.dev`,
    source: "luma",
    source_profile_url: url,
    linkedin_url: null,
    dossier_json: dossier == null ? null : JSON.stringify({ person: dossier }),
  };
}

describe("selectCadenceRefreshCandidates", () => {
  const now = Date.parse("2026-10-12T12:00:00.000Z");
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

  it("takes people never read or read 14+ days ago, once each, oldest enrolment first", () => {
    const people: Record<number, ReturnType<typeof prospect>> = {
      1: prospect(1, null),
      2: prospect(2, { status: "complete", liveProfile: { url: "u", readAt: daysAgo(15) } }),
      3: prospect(3, { status: "complete", liveProfile: { url: "u", readAt: daysAgo(3) } }),
      4: prospect(4, null, null),
      5: prospect(5, {
        status: "partial",
        researchedAt: daysAgo(1),
        warning: "live profile skipped: failed",
      }),
    };
    const picked = selectCadenceRefreshCandidates(
      [
        { prospect_id: 2, play_name: "luma-events", enrolled_at: "2026-10-01" },
        { prospect_id: 1, play_name: "luma-events", enrolled_at: "2026-10-02" },
        { prospect_id: 2, play_name: "show-hn", enrolled_at: "2026-10-03" },
        { prospect_id: 3, play_name: "luma-events", enrolled_at: "2026-09-01" },
        { prospect_id: 4, play_name: "luma-events", enrolled_at: "2026-09-02" },
        { prospect_id: 5, play_name: "luma-events", enrolled_at: "2026-09-03" },
      ],
      (id) => people[id] ?? null,
      now,
    );
    expect(picked.map((c) => [c.prospect.id, c.playName])).toEqual([
      [2, "luma-events"],
      [1, "luma-events"],
    ]);
    expect(picked[1]?.seed.url).toBe("https://linkedin.com/in/p1");
  });

  it("ages the prospect half's flattened liveProfileReadAt: a read within 14 days is skipped, an older one is taken", () => {
    const people: Record<number, ReturnType<typeof prospect>> = {
      1: prospect(1, { status: "complete", liveProfileReadAt: daysAgo(3) }),
      2: prospect(2, { status: "complete", liveProfileReadAt: daysAgo(15) }),
      3: prospect(3, { status: "complete", liveProfileReadAt: "not a date" }),
    };
    const picked = selectCadenceRefreshCandidates(
      [
        { prospect_id: 1, play_name: "luma-events", enrolled_at: "2026-10-01" },
        { prospect_id: 2, play_name: "luma-events", enrolled_at: "2026-10-02" },
        { prospect_id: 3, play_name: "luma-events", enrolled_at: "2026-10-03" },
      ],
      (id) => people[id] ?? null,
      now,
    );
    expect(picked.map((c) => c.prospect.id)).toEqual([2]);
  });
});

describe("sweepLiveProfiles", () => {
  const researched: number[] = [];
  const applied: number[] = [];
  let skips: Record<number, string> = {};
  const deps = {
    researchPerson: async (input: { subject: { queueId?: number }; remainingUsd: number }) => {
      const id = input.subject.queueId!;
      researched.push(id);
      const skipped = skips[id];
      return {
        dossier: {
          status: skipped ? "unavailable" : "complete",
          ...(skipped
            ? { warning: "person research failed" }
            : { liveProfile: { url: "u", readAt: "t" } }),
        },
        costUsd: 0.012,
        cached: false,
        ...(skipped ? { liveSkipped: skipped } : {}),
      };
    },
    applyPersonResearch: async (_l: unknown, r: { id: number }) => {
      expect(r).toEqual(queue.find((original) => original["id"] === r.id));
      applied.push(r.id);
      return { outcome: "patched", verdict: null, patch: {} };
    },
    applyPersonResearchToProspect: async (_l: unknown, p: { id: number }) => {
      applied.push(-p.id);
      return { outcome: "written", verdict: null, roleChanged: false };
    },
  } as never;

  beforeEach(() => {
    researched.length = 0;
    applied.length = 0;
    skips = {};
  });

  it("does nothing without a verified session or in demo mode", async () => {
    cfg = { ...cfg, linkedinSessionInvalidAt: "2026-09-14T11:00:00.000Z" };
    expect(await sweepLiveProfiles({}, deps)).toMatchObject({ ran: false, reason: "session" });
    cfg = { ...cfg, linkedinSessionInvalidAt: null };
    demo = true;
    expect(await sweepLiveProfiles({}, deps)).toMatchObject({ ran: false, reason: "demo" });
    expect(researched).toEqual([]);
  });

  it("runs through a connected account with no browser session at all", async () => {
    triggers = [
      { name: "github-stars", config_json: JSON.stringify({ linkedinProfileRead: false }) },
    ];
    cfg = { linkedinBrowserProfileId: null, linkedinSessionCheckedAt: null };
    expect(await sweepLiveProfiles({}, deps)).toMatchObject({ ran: false, reason: "session" });
    readAccount = { workspace: "beta", accountId: "acct-1" };
    expect(await sweepLiveProfiles({}, deps)).toMatchObject({ ran: true, researched: 3 });
  });

  it("re-reads people in a cadence with the reads the queue left over, writing only a read that came back", async () => {
    triggers = [
      { name: "github-stars", config_json: JSON.stringify({ linkedinProfileRead: false }) },
    ];
    prospects = {
      40: {
        id: 40,
        name: "Ada Quill",
        company: "Acme",
        email: "ada@acme.dev",
        source: "luma",
        source_profile_url: `${LI}ada`,
        linkedin_url: null,
        dossier_json: null,
      },
      41: {
        id: 41,
        name: "Bo Reed",
        company: "Acme",
        email: "bo@acme.dev",
        source: "luma",
        source_profile_url: `${LI}bo`,
        linkedin_url: null,
        dossier_json: null,
      },
    };
    cadences = [
      { prospect_id: 40, play_name: "luma-events", enrolled_at: "2026-10-01" },
      { prospect_id: 41, play_name: "luma-events", enrolled_at: "2026-10-02" },
    ];
    const seen: Array<{ prospectId?: number; liveMaxAgeMs?: number }> = [];
    const withProspects = {
      ...(deps as object),
      researchPerson: async (input: {
        subject: { queueId?: number; prospectId?: number };
        liveMaxAgeMs?: number;
      }) => {
        if (input.subject.prospectId !== undefined)
          seen.push({ prospectId: input.subject.prospectId, liveMaxAgeMs: input.liveMaxAgeMs });
        const failed = input.subject.prospectId === 41;
        return {
          dossier: failed
            ? { status: "partial", warning: "live profile skipped: interrupted" }
            : { status: "complete", liveProfile: { url: "u", readAt: "t" } },
          costUsd: 0.01,
          cached: false,
          ...(failed ? { liveSkipped: "interrupted" } : {}),
        };
      },
    } as never;
    const r = await sweepLiveProfiles({ maxRows: 5 }, withProspects);
    expect(r).toMatchObject({ researched: 3, read: 3, refreshed: 1 });
    expect(seen.map((s) => [s.prospectId, s.liveMaxAgeMs])).toEqual([
      [40, 14 * 86_400_000],
      [41, 14 * 86_400_000],
    ]);
    expect(applied).toEqual([7, 2, 1, -40]);

    applied.length = 0;
    seen.length = 0;
    expect(await sweepLiveProfiles({ maxRows: 3 }, withProspects)).toMatchObject({ refreshed: 0 });
    expect(seen).toEqual([]);
  });

  it("researches the candidates in order, counts live reads and spend, and reads the trigger opt-out", async () => {
    triggers = [
      { name: "github-stars", config_json: JSON.stringify({ linkedinProfileRead: false }) },
    ];
    const r = await sweepLiveProfiles({}, deps);
    expect(r).toMatchObject({ ran: true, candidates: 3, researched: 3, read: 3 });
    expect(r.costUsd).toBeCloseTo(0.036, 5);
    expect(researched).toEqual([7, 2, 1]);
    expect(applied).toEqual([7, 2, 1]);
    expect(events).toContain("live_profile_sweep.done");
    expect(loadedIds).toEqual([7, 2, 1]);
    expect(statements).toHaveLength(2);
    for (const sql of statements) expect(sql).not.toMatch(/SELECT\s+\*/i);
  });

  it("stops at the daily cap and on a login wall, after applying that row's provider result", async () => {
    skips = { 2: "daily-limit" };
    const capped = await sweepLiveProfiles({}, deps);
    expect(capped).toMatchObject({ researched: 2, read: 1, stoppedBy: "daily-limit" });
    expect(applied).toEqual([7, 2]);

    researched.length = applied.length = 0;
    skips = { 7: "session-invalid" };
    const walled = await sweepLiveProfiles({}, deps);
    expect(walled).toMatchObject({ researched: 1, read: 0, stoppedBy: "session-invalid" });
  });

  it("stops at its own row and spend caps", async () => {
    expect(await sweepLiveProfiles({ maxRows: 1 }, deps)).toMatchObject({
      researched: 1,
      stoppedBy: "max-rows",
    });
    expect(loadedIds).toEqual([7]);
    researched.length = 0;
    const capped = await sweepLiveProfiles({ maxCostUsd: 0.02 }, deps);
    expect(capped).toMatchObject({ researched: 1, stoppedBy: "budget" });
    expect(capped.costUsd).toBeLessThanOrEqual(0.02);
  });

  it("starts no row and writes nothing after the scheduler's deadline", async () => {
    expect(await sweepLiveProfiles({ deadlineAt: Date.now() - 1 }, deps)).toMatchObject({
      researched: 0,
      stoppedBy: "deadline",
    });
    expect(applied).toEqual([]);
    const late = {
      ...(deps as object),
      researchPerson: async (input: { subject: { queueId?: number } }) => {
        researched.push(input.subject.queueId!);
        vi.setSystemTime(Date.now() + 61 * 60_000);
        return {
          dossier: { status: "complete", liveProfile: { url: "u", readAt: "t" } },
          costUsd: 0.012,
          cached: false,
        };
      },
    } as never;
    vi.useFakeTimers();
    try {
      const r = await sweepLiveProfiles({ deadlineAt: Date.now() + 60 * 60_000 }, late);
      expect(r).toMatchObject({ researched: 1, stoppedBy: "deadline" });
      expect(applied).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
