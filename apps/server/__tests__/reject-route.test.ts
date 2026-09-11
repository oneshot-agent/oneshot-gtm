import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/queue/:id/reject writes the founder's reason into the row's one
// freeform slot. The contracts: an absent reason leaves the note alone, an
// empty one clears it (the prefilled box was emptied on purpose), a long one
// is capped, and the machine-decision prefix never gets minted by a human.
// POST /api/queue/:id/reject-reason is the box's LLM fallback: preview only.

const queueRows = new Map<number, Record<string, unknown>>();
const prospectsById = new Map<number, Record<string, unknown>>();
const statusCalls: Array<Record<string, unknown>> = [];
const generateMock = vi.fn();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({
      getQueueRow: (id: number) => queueRows.get(id) ?? null,
      getProspectById: (id: number) => prospectsById.get(id) ?? null,
      setQueueStatus: (input: Record<string, unknown>) => {
        statusCalls.push(input);
      },
    }),
  };
});
const enrichMock = vi.fn();
vi.mock("@oneshot-gtm/find", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/find")>("@oneshot-gtm/find");
  return {
    ...actual,
    safeEnrichCompany: enrichMock,
    isDudDomain: (d: string | null | undefined) => d === "gmail.com",
  };
});
vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return { ...actual, generateRejectReason: generateMock };
});

const {
  parseRejectReason,
  rejectLookupDomain,
  rejectQueueRoute,
  suggestRejectReasonRoute,
  REJECT_REASON_MAX_CHARS,
} = await import("../src/api/queue.ts");

function post(id: string, body?: unknown): Request {
  return new Request(`http://x/api/queue/${id}/reject`, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  queueRows.clear();
  prospectsById.clear();
  statusCalls.length = 0;
  generateMock.mockReset();
  enrichMock.mockReset();
  queueRows.set(7, {
    id: 7,
    play_name: "luma-events",
    status: "approved",
    payload_json: JSON.stringify({ email: "a@b.dev", company: "Acme" }),
    prospect_id: 44,
    notes: "auto: role — recruiter",
  });
  prospectsById.set(44, { id: 44, dossier_json: "dossier text" });
});

describe("parseRejectReason", () => {
  it("absent key → leave the note; empty string → clear it", () => {
    expect(parseRejectReason({})).toEqual({});
    expect(parseRejectReason(null)).toEqual({});
    expect(parseRejectReason({ reason: null })).toEqual({});
    expect(parseRejectReason({ reason: "" })).toEqual({ reason: "" });
    expect(parseRejectReason({ reason: "   " })).toEqual({ reason: "" });
  });

  it("collapses whitespace, trims, caps", () => {
    expect(parseRejectReason({ reason: "  wrong   stage\n\n" })).toEqual({ reason: "wrong stage" });
    const long = parseRejectReason({ reason: "x".repeat(2000) });
    expect("reason" in long && long.reason!.length).toBe(REJECT_REASON_MAX_CHARS);
  });

  it("refuses a non-string and the machine prefix", () => {
    expect(parseRejectReason({ reason: 12 })).toEqual({ error: "reason must be a string" });
    expect(parseRejectReason({ reason: "AUTO: role — x" })).toMatchObject({
      error: expect.stringContaining("auto:"),
    });
  });
});

describe("rejectQueueRoute", () => {
  it("404s an unknown row before touching the ledger", async () => {
    const res = await rejectQueueRoute(post("99", { reason: "x" }), { id: "99" });
    expect(res.status).toBe(404);
    expect(statusCalls).toHaveLength(0);
  });

  it("no body → human reject with the note untouched (the bulk path)", async () => {
    const res = await rejectQueueRoute(post("7"), { id: "7" });
    expect(res.status).toBe(200);
    expect(statusCalls).toEqual([{ id: 7, status: "rejected", decidedBy: "human" }]);
  });

  it("a reason is written as the human's note", async () => {
    await rejectQueueRoute(post("7", { reason: "  Recruiter, not the buyer. " }), { id: "7" });
    expect(statusCalls).toEqual([
      { id: 7, status: "rejected", decidedBy: "human", notes: "Recruiter, not the buyer." },
    ]);
  });

  it("an empty reason clears the stale machine note", async () => {
    await rejectQueueRoute(post("7", { reason: "" }), { id: "7" });
    expect(statusCalls).toEqual([{ id: 7, status: "rejected", decidedBy: "human", notes: "" }]);
  });

  it("refuses the machine prefix and a non-string with 400 and no write", async () => {
    expect((await rejectQueueRoute(post("7", { reason: "auto: x" }), { id: "7" })).status).toBe(
      400,
    );
    expect((await rejectQueueRoute(post("7", { reason: ["x"] }), { id: "7" })).status).toBe(400);
    expect(statusCalls).toHaveLength(0);
  });
});

describe("suggestRejectReasonRoute", () => {
  const ask = (id: string) =>
    suggestRejectReasonRoute(
      new Request(`http://x/api/queue/${id}/reject-reason`, { method: "POST", body: "{}" }),
      { id },
    );

  it("404s an unknown row", async () => {
    expect((await ask("99")).status).toBe(404);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("passes the row's play, payload and dossier to the generator and returns its sentence", async () => {
    generateMock.mockResolvedValue("Recruiter, not the person who buys.");
    const res = await ask("7");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reason: "Recruiter, not the person who buys.",
      source: "llm",
      researched: false,
    });
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        playName: "luma-events",
        payload: expect.objectContaining({ company: "Acme" }),
        dossier: "dossier text",
        company: null,
      }),
    );
    // A stored dossier means no paid lookup.
    expect(enrichMock).not.toHaveBeenCalled();
    expect(statusCalls).toHaveLength(0);
  });

  it("with no dossier, looks the company up by the address domain and hands the record to the generator", async () => {
    queueRows.set(8, {
      id: 8,
      play_name: "luma-events",
      status: "approved",
      payload_json: JSON.stringify({ email: "bruno@magna.so", company: "Magna" }),
      prospect_id: null,
      notes: "Bruno going to a founders breakfast",
    });
    enrichMock.mockResolvedValue({
      result: {
        status: "ok",
        company: {
          name: "Magna",
          employee_count: 80,
          funding_stage: "series_b",
          founded_year: 2014,
        },
        cost: 0.005,
      },
      receiptId: 1,
    });
    generateMock.mockResolvedValue(
      "Founded 2014, ~80 employees, Series B: past founder-led sales.",
    );
    const res = await ask("8");
    expect(await res.json()).toEqual({
      reason: "Founded 2014, ~80 employees, Series B: past founder-led sales.",
      source: "llm",
      researched: true,
    });
    expect(enrichMock).toHaveBeenCalledWith(
      { domain: "magna.so" },
      expect.objectContaining({ playName: "luma-events" }),
    );
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dossier: null,
        company: expect.objectContaining({ founded_year: 2014, employee_count: 80 }),
      }),
    );
  });

  it("skips the lookup for a personal-provider address and on a failed record", async () => {
    queueRows.set(9, {
      id: 9,
      play_name: "luma-events",
      status: "approved",
      payload_json: JSON.stringify({ email: "someone@gmail.com" }),
      prospect_id: null,
      notes: null,
    });
    generateMock.mockResolvedValue(null);
    expect(await (await ask("9")).json()).toEqual({
      reason: null,
      source: null,
      researched: false,
    });
    expect(enrichMock).not.toHaveBeenCalled();

    queueRows.set(10, {
      id: 10,
      play_name: "show-hn",
      status: "pending",
      payload_json: JSON.stringify({ email: "x@acme.dev" }),
      prospect_id: null,
      notes: null,
    });
    enrichMock.mockResolvedValue({
      result: { status: "error", company: {}, cost: 0 },
      receiptId: 0,
    });
    expect(await (await ask("10")).json()).toEqual({
      reason: null,
      source: null,
      researched: false,
    });
    expect(generateMock).toHaveBeenLastCalledWith(expect.objectContaining({ company: null }));
  });

  it("rejectLookupDomain prefers the address domain and falls back to the payload's own", () => {
    expect(rejectLookupDomain({ email: "A@Magna.so" })).toBe("magna.so");
    expect(rejectLookupDomain({ companyDomain: "https://www.acme.dev/about" })).toBe("acme.dev");
    expect(rejectLookupDomain({ name: "nobody" })).toBeNull();
  });

  it("a null from the generator is a null to the box, not an error", async () => {
    generateMock.mockResolvedValue(null);
    const res = await ask("7");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reason: null, source: null, researched: false });
  });
});
