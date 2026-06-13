import { beforeEach, describe, expect, it, vi } from "vitest";

// Locks in /api/cadences ?sinceRun=N filter semantics: only cadences whose
// prospect email is in the run.prospectEmails set come back. The route
// canonicalizes via trim+lowercase so casing differences in the stored emails
// don't cause silent drops.

const getRunMock = vi.fn();
const listActiveCadencesMock = vi.fn();
const listAllCadencesMock = vi.fn();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ({
      getRun: getRunMock,
      listActiveCadences: listActiveCadencesMock,
      listAllCadences: listAllCadencesMock,
      // Stubs for unrelated viewsForRows internals.
      listSequenceEventsForCadences: () => new Map(),
    }),
  };
});

vi.mock("@oneshot-gtm/plays", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/plays")>("@oneshot-gtm/plays");
  return {
    ...actual,
    nextStepInfo: () => ({ label: "step 1", isBreakup: false }),
    playFollowupCount: () => 1,
    getPriorStepsBulk: () => new Map(),
  };
});

const { listCadences } = await import("../src/api/cadences.ts");

function makeRow(
  email: string,
  name = "X",
  company = "Acme",
): {
  prospect_id: number;
  play_name: string;
  current_step: number;
  status: string;
  enrolled_at: string;
  next_due_at: string | null;
  last_polled_at: string | null;
  next_step_draft_json: string | null;
  next_step_drafted_at: string | null;
  sending_started_at: string | null;
  prospect_email: string | null;
  prospect_name: string | null;
  prospect_company: string | null;
} {
  return {
    prospect_id: Math.floor(Math.random() * 100000),
    play_name: "show-hn",
    current_step: 0,
    status: "active",
    enrolled_at: "2026-06-06T20:00:00Z",
    next_due_at: null,
    last_polled_at: null,
    next_step_draft_json: null,
    next_step_drafted_at: null,
    sending_started_at: null,
    prospect_email: email,
    prospect_name: name,
    prospect_company: company,
  };
}

function req(path: string): Request {
  return new Request(`http://localhost${path}`, { headers: { host: "127.0.0.1:3030" } });
}

describe("listCadences — ?sinceRun filter", () => {
  beforeEach(() => {
    getRunMock.mockReset();
    listActiveCadencesMock.mockReset();
    listAllCadencesMock.mockReset();
  });

  it("no sinceRun → returns the unfiltered active set", async () => {
    listAllCadencesMock.mockReturnValue([makeRow("a@x.dev"), makeRow("b@x.dev")]);
    const res = listCadences(req("/api/cadences"));
    const body = (await res.json()) as { cadences: Array<{ prospectEmail: string }> };
    expect(body.cadences.map((c) => c.prospectEmail).toSorted()).toEqual(["a@x.dev", "b@x.dev"]);
    expect(getRunMock).not.toHaveBeenCalled();
  });

  it("sinceRun=N → filters to prospect_emails on the run row", async () => {
    listAllCadencesMock.mockReturnValue([
      makeRow("a@x.dev"),
      makeRow("b@x.dev"),
      makeRow("c@x.dev"),
    ]);
    getRunMock.mockReturnValue({ prospectEmails: ["a@x.dev", "c@x.dev"] });
    const res = listCadences(req("/api/cadences?sinceRun=7"));
    const body = (await res.json()) as { cadences: Array<{ prospectEmail: string }> };
    expect(body.cadences.map((c) => c.prospectEmail).toSorted()).toEqual(["a@x.dev", "c@x.dev"]);
    expect(getRunMock).toHaveBeenCalledWith(7);
  });

  it("sinceRun=N with case-mismatched emails on either side still matches", async () => {
    listAllCadencesMock.mockReturnValue([makeRow("Sarah@AcmeAI.com"), makeRow("b@x.dev")]);
    // Run stores the email in whatever casing the SDK send returned; filter
    // canonicalizes (trim + lowercase) on both sides before set-lookup.
    getRunMock.mockReturnValue({ prospectEmails: ["sarah@acmeai.com"] });
    const res = listCadences(req("/api/cadences?sinceRun=42"));
    const body = (await res.json()) as { cadences: Array<{ prospectEmail: string }> };
    expect(body.cadences.map((c) => c.prospectEmail)).toEqual(["Sarah@AcmeAI.com"]);
  });

  it("sinceRun=N with an unknown runId returns ZERO rows (clearer signal than fall-through)", async () => {
    listAllCadencesMock.mockReturnValue([makeRow("a@x.dev"), makeRow("b@x.dev")]);
    getRunMock.mockReturnValue(null);
    const res = listCadences(req("/api/cadences?sinceRun=999999"));
    const body = (await res.json()) as { cadences: unknown[] };
    expect(body.cadences).toEqual([]);
  });

  it("sinceRun=N + all=1 → applies the filter to the full set (not just active)", async () => {
    listAllCadencesMock.mockReturnValue([
      makeRow("a@x.dev"),
      makeRow("b@x.dev"),
      makeRow("c@x.dev"),
    ]);
    getRunMock.mockReturnValue({ prospectEmails: ["b@x.dev"] });
    const res = listCadences(req("/api/cadences?all=1&sinceRun=7"));
    const body = (await res.json()) as { cadences: Array<{ prospectEmail: string }> };
    expect(body.cadences.map((c) => c.prospectEmail)).toEqual(["b@x.dev"]);
    expect(listAllCadencesMock).toHaveBeenCalled();
  });

  it("tiles count ALL statuses even while the table is filtered to active", async () => {
    // The bug this fixes: REPLIED/BREAKUP/COMPLETED read 0 in the default active
    // view. Counts come from the full set; the table is filtered to active.
    const replied = makeRow("r@x.dev");
    replied.status = "replied";
    const breakup = makeRow("k@x.dev");
    breakup.status = "breakup";
    listAllCadencesMock.mockReturnValue([makeRow("a@x.dev"), replied, breakup]);

    const res = listCadences(req("/api/cadences")); // active view (no all=1)
    const body = (await res.json()) as {
      cadences: Array<{ prospectEmail: string; status: string }>;
      counts: { active: number; replied: number; breakup: number; completed: number };
    };
    // Table shows only the active row…
    expect(body.cadences.map((c) => c.status)).toEqual(["active"]);
    // …but the tiles still reflect every status.
    expect(body.counts).toMatchObject({ active: 1, replied: 1, breakup: 1, completed: 0 });
  });

  it("malformed sinceRun (non-numeric) is ignored — falls through to unfiltered", async () => {
    listAllCadencesMock.mockReturnValue([makeRow("a@x.dev")]);
    const res = listCadences(req("/api/cadences?sinceRun=abc"));
    const body = (await res.json()) as { cadences: Array<{ prospectEmail: string }> };
    expect(body.cadences).toHaveLength(1);
    expect(getRunMock).not.toHaveBeenCalled();
  });
});
