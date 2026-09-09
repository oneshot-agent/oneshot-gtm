import { beforeEach, describe, expect, it, vi } from "vitest";

// /api/meetings + outcome/confirm/dismiss routes (issue #577 queue UI).

const getMeetingMock = vi.fn();
const listPendingOutcomeMeetingsMock = vi.fn(() => [] as unknown[]);
const listMeetingsForReviewMock = vi.fn(() => [] as unknown[]);
const getProspectByIdMock = vi.fn((): unknown => null);
const setMeetingOutcomeMock = vi.fn();
const confirmMeetingMatchMock = vi.fn();
const dismissMeetingMatchMock = vi.fn();

const ledger = {
  getMeeting: getMeetingMock,
  listPendingOutcomeMeetings: listPendingOutcomeMeetingsMock,
  listMeetingsForReview: listMeetingsForReviewMock,
  getProspectById: getProspectByIdMock,
  setMeetingOutcome: setMeetingOutcomeMock,
  confirmMeetingMatch: confirmMeetingMatchMock,
  dismissMeetingMatch: dismissMeetingMatchMock,
};

let cfgOverride: Record<string, unknown> = { calendarIdentityId: "gmail:jn@x.dev" };
let demoModeOverride = false;

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    getLedger: () => ledger,
    loadConfig: () => ({ ...actual.loadConfig(), ...cfgOverride }),
    demoMode: () => demoModeOverride,
  };
});

const {
  listMeetingsRoute,
  logMeetingOutcomeRoute,
  confirmMeetingMatchRoute,
  dismissMeetingMatchRoute,
} = await import("../src/api/meetings.ts");

function getReq(url: string): Request {
  return new Request(url, { headers: { host: "127.0.0.1:3030" } });
}

function postReq(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1:3030" },
    body: JSON.stringify(body),
  });
}

const BASE_ROW = {
  calendar_id: "primary",
  event_id: "e1",
  ical_uid: "ical-1",
  recurring_event_id: null,
  status: "confirmed",
  summary: "Intro call",
  all_day: 0,
  starts_at: "2024-01-01T10:00:00Z",
  ends_at: "2024-01-01T10:30:00Z",
  event_timezone: null,
  organizer_email: "jn@x.dev",
  self_response: null,
  external_attendee_count: 1,
  external_attendees_json: JSON.stringify(["pat@acme.com"]),
  attendees_omitted: 0,
  prospect_id: 1,
  suggested_prospect_id: null,
  match_status: "exact",
  match_method: null,
  match_confidence: 1,
  outcome: null,
  outcome_note: null,
  outcome_recorded_at: null,
  outcome_prompted_at: null,
  event_updated_at: "2024-01-01T09:00:00Z",
  first_seen_at: "2024-01-01T09:00:00Z",
  last_seen_at: "2024-01-01T09:00:00Z",
  attendees_fingerprint: "pat@acme.com",
};

beforeEach(() => {
  cfgOverride = { calendarIdentityId: "gmail:jn@x.dev" };
  demoModeOverride = false;
  vi.clearAllMocks();
  listPendingOutcomeMeetingsMock.mockReturnValue([]);
  listMeetingsForReviewMock.mockReturnValue([]);
  getMeetingMock.mockReturnValue(null);
  getProspectByIdMock.mockReturnValue(null);
});

describe("GET /api/meetings", () => {
  it("returns empty lists (no ledger call) when calendarIdentityId is unset — feature off", async () => {
    cfgOverride = { calendarIdentityId: null };
    const res = await listMeetingsRoute(getReq("http://localhost/api/meetings"));
    expect(await res.json()).toEqual({ awaitingOutcome: [], needsReview: [] });
    expect(listPendingOutcomeMeetingsMock).not.toHaveBeenCalled();
  });

  it("projects a matched, awaiting-outcome row with the prospect's name/email joined in", async () => {
    listPendingOutcomeMeetingsMock.mockReturnValue([BASE_ROW]);
    getProspectByIdMock.mockReturnValue({ id: 1, name: "Pat Doe", email: "pat@acme.com" });
    const res = await listMeetingsRoute(getReq("http://localhost/api/meetings"));
    const body = (await res.json()) as {
      awaitingOutcome: Array<Record<string, unknown>>;
      needsReview: unknown[];
    };
    expect(body.awaitingOutcome).toHaveLength(1);
    const row = body.awaitingOutcome[0]!;
    expect(row["prospectName"]).toBe("Pat Doe");
    expect(row["prospectEmail"]).toBe("pat@acme.com");
    expect(row["externalAttendees"]).toEqual(["pat@acme.com"]);
    expect(row["matchReason"]).toBe("matched by email address");
  });

  it("renders the fuzzy match method as a human sentence, never the bare method string", async () => {
    listMeetingsForReviewMock.mockReturnValue([
      {
        ...BASE_ROW,
        match_status: "suggested",
        match_method: "name_domain",
        prospect_id: null,
        suggested_prospect_id: 2,
      },
    ]);
    getProspectByIdMock.mockReturnValue({ id: 2, name: "Sam Roe", email: "sam@acme.com" });
    const res = await listMeetingsRoute(getReq("http://localhost/api/meetings"));
    const body = (await res.json()) as { needsReview: Array<Record<string, unknown>> };
    expect(body.needsReview[0]?.["matchReason"]).toBe("same company domain and name");
    expect(body.needsReview[0]?.["matchReason"]).not.toMatch(/name_domain/);
  });
});

describe("POST /api/meetings/outcome", () => {
  it("404s when the meeting doesn't exist", async () => {
    const res = await logMeetingOutcomeRoute(
      postReq("http://localhost/api/meetings/outcome", {
        calendarId: "primary",
        eventId: "missing",
        outcome: "held",
      }),
    );
    expect(res.status).toBe(404);
    expect(setMeetingOutcomeMock).not.toHaveBeenCalled();
  });

  it("400s on an invalid outcome value", async () => {
    getMeetingMock.mockReturnValue(BASE_ROW);
    const res = await logMeetingOutcomeRoute(
      postReq("http://localhost/api/meetings/outcome", {
        calendarId: "primary",
        eventId: "e1",
        outcome: "maybe",
      }),
    );
    expect(res.status).toBe(400);
    expect(setMeetingOutcomeMock).not.toHaveBeenCalled();
  });

  it("records a valid outcome with a trimmed note", async () => {
    getMeetingMock.mockReturnValue(BASE_ROW);
    const res = await logMeetingOutcomeRoute(
      postReq("http://localhost/api/meetings/outcome", {
        calendarId: "primary",
        eventId: "e1",
        outcome: "no_show",
        note: "  didn't join  ",
      }),
    );
    expect(res.status).toBe(200);
    expect(setMeetingOutcomeMock).toHaveBeenCalledWith({
      calendarId: "primary",
      eventId: "e1",
      outcome: "no_show",
      note: "didn't join",
    });
  });
});

describe("POST /api/meetings/confirm", () => {
  it("404s when the prospect doesn't exist", async () => {
    getMeetingMock.mockReturnValue(BASE_ROW);
    getProspectByIdMock.mockReturnValue(null);
    const res = await confirmMeetingMatchRoute(
      postReq("http://localhost/api/meetings/confirm", {
        calendarId: "primary",
        eventId: "e1",
        prospectId: 99,
      }),
    );
    expect(res.status).toBe(404);
    expect(confirmMeetingMatchMock).not.toHaveBeenCalled();
  });

  it("confirms a match", async () => {
    getMeetingMock.mockReturnValue(BASE_ROW);
    getProspectByIdMock.mockReturnValue({ id: 2, name: "Sam", email: "sam@acme.com" });
    const res = await confirmMeetingMatchRoute(
      postReq("http://localhost/api/meetings/confirm", {
        calendarId: "primary",
        eventId: "e1",
        prospectId: 2,
      }),
    );
    expect(res.status).toBe(200);
    expect(confirmMeetingMatchMock).toHaveBeenCalledWith("primary", "e1", 2);
  });
});

describe("POST /api/meetings/dismiss", () => {
  it("404s when the meeting doesn't exist", async () => {
    const res = await dismissMeetingMatchRoute(
      postReq("http://localhost/api/meetings/dismiss", {
        calendarId: "primary",
        eventId: "missing",
      }),
    );
    expect(res.status).toBe(404);
    expect(dismissMeetingMatchMock).not.toHaveBeenCalled();
  });

  it("dismisses a suggested match", async () => {
    getMeetingMock.mockReturnValue(BASE_ROW);
    const res = await dismissMeetingMatchRoute(
      postReq("http://localhost/api/meetings/dismiss", { calendarId: "primary", eventId: "e1" }),
    );
    expect(res.status).toBe(200);
    expect(dismissMeetingMatchMock).toHaveBeenCalledWith("primary", "e1");
  });
});
