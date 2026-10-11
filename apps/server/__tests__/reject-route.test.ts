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
  parseDecisionReason,
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
  const ask = (id: string, body: unknown = {}) =>
    suggestRejectReasonRoute(
      new Request(`http://x/api/queue/${id}/reject-reason`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
      { id },
    );

  it("404s an unknown row", async () => {
    expect((await ask("99")).status).toBe(404);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("passes the row's play, payload and dossier to the generator and returns its sentence", async () => {
    generateMock.mockResolvedValue({
      reason: "Recruiter, not the person who buys.",
      decisionReason: "wrong_person",
    });
    const res = await ask("7");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reason: "Recruiter, not the person who buys.",
      decisionReason: "wrong_person",
      source: "llm",
      researched: false,
    });
    // No hint in the body → none handed to the generator.
    expect(generateMock.mock.calls[0]![0]).not.toHaveProperty("hint");
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
    generateMock.mockResolvedValue({
      reason: "Founded 2014, ~80 employees, Series B: past founder-led sales.",
      decisionReason: "wrong_audience",
    });
    const res = await ask("8");
    expect(await res.json()).toEqual({
      reason: "Founded 2014, ~80 employees, Series B: past founder-led sales.",
      decisionReason: "wrong_audience",
      source: "llm",
      researched: true,
    });
    expect(enrichMock).toHaveBeenCalledWith(
      { domain: "magna.so", timeoutMs: expect.any(Number) },
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
    generateMock.mockResolvedValue({ reason: null, decisionReason: null });
    expect(await (await ask("9")).json()).toEqual({
      reason: null,
      decisionReason: null,
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
      decisionReason: null,
      source: null,
      researched: false,
    });
    expect(generateMock).toHaveBeenLastCalledWith(expect.objectContaining({ company: null }));
  });

  it("rejectLookupDomain prefers the address domain and falls back to the payload's own", () => {
    expect(rejectLookupDomain({ email: "A@Magna.so" })).toBe("magna.so");
    expect(rejectLookupDomain({ companyDomain: "https://www.acme.dev/about" })).toBe("acme.dev");
    expect(rejectLookupDomain({ companyDomain: " HTTPS://WWW.Acme.dev?ref=x " })).toBe("acme.dev");
    expect(rejectLookupDomain({ domain: "acme.dev#team" })).toBe("acme.dev");
    expect(rejectLookupDomain({ name: "nobody" })).toBeNull();
  });

  it("a null from the generator is a null to the box, not an error", async () => {
    generateMock.mockResolvedValue({ reason: null, decisionReason: null });
    const res = await ask("7");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reason: null,
      decisionReason: null,
      source: null,
      researched: false,
    });
  });

  it("hands the founder's tapped category and typed words to the generator as a hint", async () => {
    generateMock.mockResolvedValue({
      reason: "Already in conversation from an earlier email.",
      decisionReason: "already_contacted",
    });
    const res = await ask("7", {
      decisionReason: "already_contacted",
      hint: "  already   contacted ",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      reason: "Already in conversation from an earlier email.",
      decisionReason: "already_contacted",
      source: "llm",
    });
    expect(generateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        hint: { text: "already contacted", decisionReason: "already_contacted" },
      }),
    );
  });

  it("a category with no sentence still comes back as a suggestion", async () => {
    generateMock.mockResolvedValue({ reason: null, decisionReason: "bad_timing" });
    expect(await (await ask("7", { hint: "too early" })).json()).toMatchObject({
      reason: null,
      decisionReason: "bad_timing",
      source: "llm",
    });
    expect(generateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ hint: { text: "too early", decisionReason: null } }),
    );
  });

  it("refuses an unknown category, 'fit', and a non-string hint without calling the generator", async () => {
    expect((await ask("7", { decisionReason: "meh" })).status).toBe(400);
    expect((await ask("7", { decisionReason: "fit" })).status).toBe(400);
    expect((await ask("7", { hint: ["x"] })).status).toBe(400);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("caps a long hint", async () => {
    generateMock.mockResolvedValue({ reason: null, decisionReason: null });
    await ask("7", { hint: "x".repeat(2000) });
    const hint = generateMock.mock.calls.at(-1)![0].hint as { text: string };
    expect(hint.text).toHaveLength(REJECT_REASON_MAX_CHARS);
  });
});

describe("structured decision reasons (#813)", () => {
  it("parses a known reason, treats absent/empty as none, and refuses an unknown one", () => {
    expect(parseDecisionReason({}, "decisionReason")).toEqual({});
    expect(parseDecisionReason({ decisionReason: "" }, "decisionReason")).toEqual({});
    expect(parseDecisionReason({ decisionReason: null }, "decisionReason")).toEqual({});
    expect(parseDecisionReason({ decisionReason: "bad_timing" }, "decisionReason")).toEqual({
      decisionReason: "bad_timing",
    });
    expect(parseDecisionReason({ reason: "fit" }, "reason")).toEqual({ decisionReason: "fit" });
    expect(parseDecisionReason({ decisionReason: "meh" }, "decisionReason")).toHaveProperty(
      "error",
    );
  });

  it("writes the structured reason next to the note, null when none was given", async () => {
    let res = await rejectQueueRoute(
      post("7", { reason: "not the buyer", decisionReason: "wrong_person" }),
      { id: "7" },
    );
    expect(res.status).toBe(200);
    expect(statusCalls.at(-1)).toMatchObject({
      status: "rejected",
      decidedBy: "human",
      decisionReason: "wrong_person",
      notes: "not the buyer",
    });
    res = await rejectQueueRoute(post("7", {}), { id: "7" });
    expect(res.status).toBe(200);
    expect(statusCalls.at(-1)).not.toHaveProperty("decisionReason");
    res = await rejectQueueRoute(post("7", { decisionReason: "nope" }), { id: "7" });
    expect(res.status).toBe(400);
  });

  it("accepts 'already_contacted' on a reject and stores it", async () => {
    const res = await rejectQueueRoute(
      post("7", { reason: "emailed before", decisionReason: "already_contacted" }),
      { id: "7" },
    );
    expect(res.status).toBe(200);
    expect(statusCalls.at(-1)).toMatchObject({
      status: "rejected",
      decisionReason: "already_contacted",
      notes: "emailed before",
    });
  });
});
