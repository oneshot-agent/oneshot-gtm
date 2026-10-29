import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/queue/:id/read-profile: opening a row reads its LinkedIn profile
// through the sweep's per-row path. A row read in the last 30 days, a row
// that is not live and a row without a LinkedIn seed are not read; a read
// the cap or the session stopped writes nothing; two clicks share one read;
// a read that moved the role rewrites the offer and then the draft, unless
// the founder wrote the offer.

const LI = "https://www.linkedin.com/in/";

const state = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  account: { workspace: "beta", accountId: "acct-1" } as null | {
    workspace: string;
    accountId: string;
  },
  demo: false,
  triggers: [] as Array<{ name: string; config_json: string | null }>,
  research: null as null | ((input: Record<string, unknown>) => Promise<unknown>),
  researchCalls: [] as Array<Record<string, unknown>>,
  applyCalls: [] as Array<{ id: number; opts: Record<string, unknown> }>,
  /** What the write does to the row: the payload patch and the outcome. */
  apply: {
    patch: {} as Record<string, unknown>,
    outcome: "patched" as string,
  },
  offerCalls: [] as number[],
  offerResult: { offer: { offer: "new" }, candidates: [] } as unknown,
  draftCalls: [] as Array<{ id: number; opts: unknown }>,
  draftResult: { status: 200, body: { subject: "s", body: "b" } } as {
    status: number;
    body: unknown;
  },
  events: [] as string[],
}));

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    demoMode: () => state.demo,
    loadConfig: () => ({
      ...actual.loadConfig(),
      linkedinBrowserProfileId: null,
      linkedinSessionCheckedAt: null,
      linkedinSessionInvalidAt: null,
    }),
    logEvent: (kind: string) => {
      state.events.push(kind);
    },
    linkedInProfileReadAccount: () => state.account,
    getLedger: () => ({
      getQueueRow: () => (state.row ? { ...state.row } : null),
      listTriggers: () => state.triggers,
    }),
  };
});

vi.mock("@oneshot-gtm/find", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/find")>("@oneshot-gtm/find");
  return {
    ...actual,
    researchPerson: async (input: Record<string, unknown>) => {
      state.researchCalls.push(input);
      return state.research!(input);
    },
    applyPersonResearch: async (
      _ledger: unknown,
      row: { id: number; payload_json: string },
      dossier: Record<string, unknown>,
      opts: Record<string, unknown>,
    ) => {
      state.applyCalls.push({ id: row.id, opts });
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      state.row = {
        ...state.row,
        ...(state.apply.outcome === "rejected" ? { status: "rejected" } : {}),
        payload_json: JSON.stringify({
          ...payload,
          ...state.apply.patch,
          personResearch: dossier,
        }),
      };
      return { outcome: state.apply.outcome, verdict: null, patch: state.apply.patch };
    },
  };
});

vi.mock("@oneshot-gtm/plays", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays")),
  playMakesOffer: () => true,
}));

vi.mock("../src/api/queue-offer.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/queue-offer.ts")>()),
  regenerateQueueRowOffer: async (row: { id: number }) => {
    state.offerCalls.push(row.id);
    return state.offerResult;
  },
}));

vi.mock("../src/api/queue.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/queue.ts")>()),
  regenerateQueueDraft: async (id: number, opts: unknown) => {
    state.draftCalls.push({ id, opts });
    return state.draftResult;
  },
}));

const { readProfileRoute } = await import("../src/api/queue-read-profile.ts");

function post(id = 5): Promise<Response> {
  return readProfileRoute(
    new Request(`http://x/api/queue/${id}/read-profile`, { method: "POST" }),
    { id: String(id) },
  );
}

const ROLE = { title: "Head of Ops", company: "Acme" };

function liveDossier(role = ROLE) {
  return {
    version: 1,
    status: "complete",
    researchedAt: new Date().toISOString(),
    seed: { url: `${LI}dana` },
    currentRole: role,
    organizations: [],
    liveProfile: { url: `${LI}dana`, readAt: new Date().toISOString() },
    costUsd: 0.01,
    cached: false,
  };
}

beforeEach(() => {
  state.row = {
    id: 5,
    play_name: "luma-events",
    source: "luma",
    notes: null,
    status: "pending",
    prospect_id: null,
    sent_at: null,
    send_started_at: null,
    last_draft_json: JSON.stringify({ subject: "old", body: "old" }),
    payload_json: JSON.stringify({
      name: "Dana Lee",
      title: "Head of Ops",
      company: "Acme",
      linkedinUrl: `${LI}dana`,
      offer: { offer: "old offer" },
      personResearch: {
        status: "partial",
        currentRole: ROLE,
        organizations: [],
      },
    }),
  };
  state.account = { workspace: "beta", accountId: "acct-1" };
  state.demo = false;
  state.triggers = [];
  state.research = async () => ({ dossier: liveDossier(), costUsd: 0.01, cached: false });
  state.researchCalls = [];
  state.applyCalls = [];
  state.apply = { patch: {}, outcome: "patched" };
  state.offerCalls = [];
  state.offerResult = { offer: { offer: "new" }, candidates: [] };
  state.draftCalls = [];
  state.draftResult = { status: 200, body: { subject: "s", body: "b" } };
  state.events = [];
});

describe("POST /api/queue/:id/read-profile", () => {
  it("reads the profile and writes it through the sweep's path", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      read: true,
      skipped: null,
      roleChanged: false,
      redrafted: false,
      outcome: "patched",
    });
    expect(state.researchCalls).toHaveLength(1);
    expect(state.researchCalls[0]).toMatchObject({
      seed: { url: "https://linkedin.com/in/dana" },
      playName: "luma-events",
      subject: { queueId: 5 },
      liveProfile: true,
      // An opened row reads on the whole day's cap, not the sweep's paced share.
      liveReadOpened: true,
    });
    expect(state.applyCalls).toEqual([{ id: 5, opts: expect.objectContaining({ rejudge: true }) }]);
    expect(state.offerCalls).toEqual([]);
    expect(state.draftCalls).toEqual([]);
    expect(state.events).toContain("queue_read_profile.done");
  });

  it("404s a missing row", async () => {
    state.row = null;
    expect((await post()).status).toBe(404);
  });

  it("does not read a row that is not live", async () => {
    state.row = { ...state.row, status: "rejected" };
    expect(await (await post()).json()).toMatchObject({ read: false, skipped: "not-live" });
    state.row = { ...state.row, status: "approved", send_started_at: "2026-10-20T10:00:00Z" };
    expect(await (await post()).json()).toMatchObject({ read: false, skipped: "not-live" });
    expect(state.researchCalls).toEqual([]);
  });

  it("does not read a row without a LinkedIn seed, or one whose play switched reads off", async () => {
    state.row = { ...state.row, payload_json: JSON.stringify({ name: "D", email: "d@x.dev" }) };
    expect(await (await post()).json()).toMatchObject({
      read: false,
      skipped: "no-seed",
      outcome: "skipped",
    });
    state.row = { ...state.row, payload_json: JSON.stringify({ linkedinUrl: `${LI}dana` }) };
    state.triggers = [
      { name: "luma-events", config_json: JSON.stringify({ linkedinProfileRead: false }) },
    ];
    expect(await (await post()).json()).toMatchObject({ skipped: "no-seed" });
    expect(state.researchCalls).toEqual([]);
  });

  it("does not read again within 30 days of the last read", async () => {
    const readAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    state.row = {
      ...state.row,
      payload_json: JSON.stringify({
        linkedinUrl: `${LI}dana`,
        personResearch: { status: "complete", liveProfile: { url: `${LI}dana`, readAt } },
      }),
    };
    expect(await (await post()).json()).toMatchObject({ read: false, skipped: "fresh" });
    expect(state.researchCalls).toEqual([]);
  });

  it("reads again once the last read is 30 days old", async () => {
    const readAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
    state.row = {
      ...state.row,
      payload_json: JSON.stringify({
        linkedinUrl: `${LI}dana`,
        personResearch: { status: "complete", liveProfile: { url: `${LI}dana`, readAt } },
      }),
    };
    expect(await (await post()).json()).toMatchObject({ read: true });
  });

  it("skips at the daily cap and keeps the research the row has", async () => {
    state.research = async () => ({
      dossier: {
        ...liveDossier(),
        liveProfile: undefined,
        warning: "live profile skipped: daily-limit",
      },
      costUsd: 0,
      cached: true,
      liveSkipped: "daily-limit",
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      read: false,
      skipped: "daily-limit",
      roleChanged: false,
      redrafted: false,
      outcome: "skipped",
    });
    expect(state.applyCalls).toEqual([]);
  });

  it("writes a skip about the person itself, as the sweep does", async () => {
    state.research = async () => ({
      dossier: {
        ...liveDossier(),
        liveProfile: undefined,
        warning: "live profile skipped: different-person",
      },
      costUsd: 0,
      cached: false,
      liveSkipped: "different-person",
    });
    expect(await (await post()).json()).toMatchObject({
      read: false,
      skipped: "different-person",
      outcome: "patched",
    });
    expect(state.applyCalls).toHaveLength(1);
  });

  it("does not read without an account or a verified session", async () => {
    state.account = null;
    expect(await (await post()).json()).toMatchObject({ read: false, skipped: "not-connected" });
    expect(state.researchCalls).toEqual([]);
  });

  it("runs one read for two concurrent clicks", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    state.research = async () => {
      await gate;
      return { dossier: liveDossier(), costUsd: 0.01, cached: false };
    };
    const first = post();
    const second = post();
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(await a.json()).toMatchObject({ read: true });
    expect(await b.json()).toMatchObject({ read: true });
    expect(state.researchCalls).toHaveLength(1);
    // Settled: the next click starts its own run, which finds the read fresh.
    expect(await (await post()).json()).toMatchObject({ read: false, skipped: "fresh" });
    expect(state.researchCalls).toHaveLength(1);
  });

  it("rewrites the offer and then the draft when the read moved the role", async () => {
    state.research = async () => ({
      dossier: liveDossier({ title: "COO", company: "Beta Labs" }),
      costUsd: 0.01,
      cached: false,
    });
    state.apply.patch = { title: "COO", company: "Beta Labs" };
    expect(await (await post()).json()).toEqual({
      read: true,
      skipped: null,
      roleChanged: true,
      redrafted: true,
      outcome: "patched",
    });
    expect(state.offerCalls).toEqual([5]);
    expect(state.draftCalls).toEqual([{ id: 5, opts: { discardReason: "redraft" } }]);
  });

  it("does not count a case or spacing change as a new role", async () => {
    state.research = async () => ({
      dossier: liveDossier({ title: "head  of OPS", company: "acme" }),
      costUsd: 0.01,
      cached: false,
    });
    expect(await (await post()).json()).toMatchObject({ roleChanged: false, redrafted: false });
    expect(state.offerCalls).toEqual([]);
  });

  it("rewrites only the offer when the row has no draft", async () => {
    state.row = { ...state.row, last_draft_json: null };
    state.research = async () => ({
      dossier: liveDossier({ title: "COO", company: "Acme" }),
      costUsd: 0.01,
      cached: false,
    });
    expect(await (await post()).json()).toMatchObject({ roleChanged: true, redrafted: true });
    expect(state.offerCalls).toEqual([5]);
    expect(state.draftCalls).toEqual([]);
  });

  it("does not report a redraft when the offer could not be rewritten", async () => {
    state.offerResult = "no-offer";
    state.research = async () => ({
      dossier: liveDossier({ title: "COO", company: "Beta Labs" }),
      costUsd: 0.01,
      cached: false,
    });
    state.apply.patch = { title: "COO", company: "Beta Labs" };
    expect(await (await post()).json()).toMatchObject({ roleChanged: true, redrafted: false });
    expect(state.offerCalls).toEqual([5]);
  });

  it("leaves a founder-written offer and its draft alone", async () => {
    const payload = JSON.parse(String(state.row!["payload_json"])) as Record<string, unknown>;
    state.row = {
      ...state.row,
      payload_json: JSON.stringify({
        ...payload,
        offer: { offer: "mine", editedBy: "founder" },
      }),
    };
    state.research = async () => ({
      dossier: liveDossier({ title: "COO", company: "Beta Labs" }),
      costUsd: 0.01,
      cached: false,
    });
    state.apply.patch = { company: "Beta Labs" };
    expect(await (await post()).json()).toMatchObject({ roleChanged: true, redrafted: false });
    expect(state.offerCalls).toEqual([]);
    expect(state.draftCalls).toEqual([]);
  });

  it("keeps the read when the redraft fails", async () => {
    state.research = async () => ({
      dossier: liveDossier({ title: "COO", company: "Beta Labs" }),
      costUsd: 0.01,
      cached: false,
    });
    state.draftResult = { status: 500, body: { error: "Draft generation failed." } };
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      read: true,
      roleChanged: true,
      redrafted: false,
      outcome: "patched",
    });
    expect(state.events).toContain("queue_read_profile.redraft_failed");
  });

  it("answers rejected with the reason when the re-judge rejects a pending row", async () => {
    state.research = async () => ({
      dossier: liveDossier({ title: "Student", company: "State University" }),
      costUsd: 0.01,
      cached: false,
    });
    state.apply = {
      patch: { icpVerdict: "reject", icpVerdictReason: "a student, not a buyer" },
      outcome: "rejected",
    };
    expect(await (await post()).json()).toEqual({
      read: true,
      skipped: null,
      roleChanged: true,
      redrafted: false,
      outcome: "rejected",
      reason: "a student, not a buyer",
    });
    expect(state.offerCalls).toEqual([]);
  });
});
