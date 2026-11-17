import { beforeEach, describe, expect, it, vi } from "vitest";

// Phone lookups start in the background and answer at once: the route marks
// the row running and returns 202; the job writes the result when it ends.
// A row with no LinkedIn URL, a number, a send in progress or a lookup
// already running gets none, and at most four run at a time.

const h = vi.hoisted(() => ({
  rows: new Map<number, Record<string, unknown>>(),
  writes: [] as Array<{ id: number; input: Record<string, unknown> }>,
  writeResult: "written" as "written" | "busy" | "gone",
  findPhone: vi.fn(),
  config: {} as Record<string, unknown>,
  ceilingReached: false,
}));

vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  getLedger: () => ({
    getQueueRow: (id: number) => h.rows.get(id) ?? null,
    listQueue: (opts: { status?: string; offset?: number }) =>
      (opts.offset ?? 0) > 0 ? [] : [...h.rows.values()].filter((r) => r["status"] === opts.status),
    setQueuePhoneLookup: (id: number, input: Record<string, unknown>) => {
      h.writes.push({ id, input });
      return h.writeResult;
    },
  }),
  findPhone: h.findPhone,
  loadConfig: () => h.config,
  dailySpendStatus: () => ({ ceilingReached: h.ceilingReached }),
}));

const {
  _resetPhoneLookups,
  findQueuePhoneRoute,
  findQueuePhonesPreviewRoute,
  findQueuePhonesRoute,
  schedulePhoneOnApproval,
} = await import("../src/api/queue-phone.ts");

const linkedin = (id: number) => `https://www.linkedin.com/in/person-${id}`;
function row(id: number, status = "approved", payload: Record<string, unknown> = {}) {
  const r = {
    id,
    play_name: "show-hn",
    status,
    send_started_at: null,
    payload_json: JSON.stringify({ name: `P ${id}`, linkedinUrl: linkedin(id), ...payload }),
  };
  h.rows.set(id, r);
  return r;
}

const one = (id: number, body?: unknown) =>
  findQueuePhoneRoute(
    new Request(`http://localhost/api/queue/${id}/find-phone`, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { id: String(id) },
  );
const bulk = (body: unknown = {}) =>
  findQueuePhonesRoute(
    new Request("http://localhost/api/queue/find-phones", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );

/** Let the background jobs take their turn. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** findPhone calls that wait until released, in call order. */
function holdLookups() {
  const release: Array<() => void> = [];
  h.findPhone.mockImplementation(
    () =>
      new Promise((resolve) => {
        release.push(() =>
          resolve({ phone: "+15550100", lookup: "found", receiptId: 1, cost: 0.1 }),
        );
      }),
  );
  return release;
}

beforeEach(() => {
  _resetPhoneLookups();
  h.rows.clear();
  h.writes.length = 0;
  h.writeResult = "written";
  h.config = {};
  h.ceilingReached = false;
  h.findPhone.mockReset();
  h.findPhone.mockResolvedValue({ phone: "+15550100", lookup: "found", receiptId: 1, cost: 0.1 });
});

describe("POST /api/queue/:id/find-phone", () => {
  it("marks the row running, answers 202, and writes the number when the job ends", async () => {
    row(9);
    const res = await one(9);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, status: "running" });
    expect(h.writes[0]).toMatchObject({ id: 9, input: { lookup: { status: "running" } } });
    await settle();
    expect(h.findPhone).toHaveBeenCalledWith(
      { linkedinUrl: linkedin(9), name: "P 9" },
      expect.objectContaining({
        playName: "show-hn",
        decisionContext: expect.objectContaining({ subject: { queueId: 9 } }),
      }),
      undefined,
    );
    expect(h.writes[1]).toMatchObject({
      id: 9,
      input: { phone: "+15550100", lookup: { status: "done", costUsd: 0.1 } },
    });
  });

  it.each([
    ["no number", { phone: null, lookup: "none" }, "none"],
    ["the provider unanswered", { phone: null, lookup: "unavailable" }, "unavailable"],
    ["a reveal still pending", { phone: null, lookup: "pending" }, "unavailable"],
  ])("records %s", async (_label, out, status) => {
    row(9);
    h.findPhone.mockResolvedValue({ ...out, receiptId: 1, cost: 0.1 });
    await one(9);
    await settle();
    expect(h.writes[1]?.input).toMatchObject({ phone: null, lookup: { status } });
  });

  it("records the tool being down as unavailable, and another failure as an error", async () => {
    row(9);
    h.findPhone.mockRejectedValueOnce(
      new Error("Job failed: This tool is temporarily unavailable"),
    );
    await one(9);
    await settle();
    expect(h.writes[1]?.input).toMatchObject({ lookup: { status: "unavailable" } });
    h.findPhone.mockRejectedValueOnce(new Error("Bad input"));
    await one(9);
    await settle();
    expect(h.writes[3]?.input).toMatchObject({ lookup: { status: "error", message: "Bad input" } });
  });

  it("409s while the row's lookup runs, and buys one lookup", async () => {
    row(9);
    const release = holdLookups();
    expect((await one(9)).status).toBe(202);
    const again = await one(9);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ skip: "running" });
    await settle();
    release[0]!();
    await settle();
    expect(h.findPhone).toHaveBeenCalledTimes(1);
  });

  it("409s when a number is stored, unless forced, and a forced lookup skips the cache", async () => {
    row(9, "approved", { phone: "+15550111" });
    const res = await one(9);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ skip: "has_phone" });
    expect((await one(9, { force: true })).status).toBe(202);
    await settle();
    expect(h.findPhone.mock.calls[0]![2]).toEqual({ fresh: true });
  });

  it("409s a row with no LinkedIn URL, with a message saying so", async () => {
    row(9, "approved", { linkedinUrl: undefined, email: "p@acme.example" });
    const res = await one(9);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "This row needs a LinkedIn URL before a phone lookup",
      skip: "no_linkedin",
    });
    expect(h.findPhone).not.toHaveBeenCalled();
  });

  it.each(["pending", "rejected", "expired"])("409s a %s row", async (status) => {
    row(9, status);
    expect((await one(9)).status).toBe(409);
    expect(h.writes).toEqual([]);
    expect(h.findPhone).not.toHaveBeenCalled();
  });

  it("accepts a sent row, and 409s one being sent", async () => {
    row(9, "sent");
    expect((await one(9)).status).toBe(202);
    h.rows.set(10, { ...row(10), send_started_at: "2026-11-17T10:00:00.000Z" });
    expect((await one(10)).status).toBe(409);
  });

  it("409s when the row cannot be marked (a drain took it)", async () => {
    row(9);
    h.writeResult = "busy";
    expect((await one(9)).status).toBe(409);
    await settle();
    expect(h.findPhone).not.toHaveBeenCalled();
  });

  it("404s an unknown row", async () => {
    expect((await one(77)).status).toBe(404);
  });
});

describe("the bulk lookup", () => {
  it("takes only approved rows with a LinkedIn URL and no number, and says why the rest are skipped", async () => {
    row(1);
    row(2, "approved", { phone: "+15550111" });
    row(3, "approved", { linkedinUrl: undefined });
    row(4, "pending");
    row(5, "approved", { phoneLookup: { status: "none", at: "2026-11-01T00:00:00.000Z" } });
    row(6);
    const preview = await findQueuePhonesPreviewRoute(
      new Request("http://localhost/api/queue/find-phones"),
    );
    expect(await preview.json()).toEqual({
      eligible: 2,
      skipped: { has_phone: 1, no_linkedin: 1, no_number: 1 },
    });
    const res = await bulk();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      started: 2,
      skipped: { has_phone: 1, no_linkedin: 1, no_number: 1 },
    });
    await settle();
    expect(
      h.findPhone.mock.calls.map((c) => (c[0] as { linkedinUrl: string }).linkedinUrl),
    ).toEqual([linkedin(1), linkedin(6)]);
  });

  it("takes the named rows when ids are sent", async () => {
    row(1);
    row(2);
    row(3, "pending");
    expect(await (await bulk({ ids: [2, 3, 99] })).json()).toEqual({
      started: 1,
      skipped: { status: 1 },
    });
  });

  it("refuses ids that are not row ids", async () => {
    expect((await bulk({ ids: ["1"] })).status).toBe(400);
  });

  it("runs at most four lookups at a time", async () => {
    for (let id = 1; id <= 6; id++) row(id);
    const release = holdLookups();
    await bulk();
    await settle();
    expect(h.findPhone).toHaveBeenCalledTimes(4);
    release[0]!();
    await settle();
    await settle();
    expect(h.findPhone).toHaveBeenCalledTimes(5);
    release[1]!();
    release[2]!();
    await settle();
    await settle();
    expect(h.findPhone).toHaveBeenCalledTimes(6);
  });
});

describe("a lookup on approval", () => {
  it("does nothing while phoneOnApprove is off", async () => {
    row(1);
    schedulePhoneOnApproval([1]);
    await settle();
    expect(h.writes).toEqual([]);
    expect(h.findPhone).not.toHaveBeenCalled();
  });

  it("looks up each approved row when it is on, skipping rows that need none", async () => {
    h.config = { phoneOnApprove: true };
    row(1);
    row(2, "approved", { phone: "+15550111" });
    row(3, "approved", { linkedinUrl: undefined });
    schedulePhoneOnApproval([1, 2, 3]);
    await settle();
    expect(h.findPhone).toHaveBeenCalledTimes(1);
    expect(h.findPhone.mock.calls[0]![1]).toMatchObject({
      decisionContext: { trigger: "approve" },
    });
  });

  it("stops at the daily spend ceiling", async () => {
    h.config = { phoneOnApprove: true };
    h.ceilingReached = true;
    row(1);
    schedulePhoneOnApproval([1]);
    await settle();
    expect(h.findPhone).not.toHaveBeenCalled();
  });
});
