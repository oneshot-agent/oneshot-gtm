import { beforeEach, describe, expect, it, vi } from "vitest";

// GET /api/setup/calendars — the /setup calendar picker's source list
// (issue #577). Refusal of sub-writer access is enforced by
// listWritableCalendars itself (core, tested there); this route's own job is
// identity resolution, the 7-day count fan-out, and error mapping.

let cfgOverride: Record<string, unknown> = {};
const listWritableCalendarsMock = vi.fn();
const recentEventCountMock = vi.fn(async () => 3);
const gmailAccountForMock = vi.fn(
  () =>
    ({ refreshToken: "rt", clientId: "id", clientSecret: "secret" }) as unknown as ReturnType<
      typeof import("@oneshot-gtm/core").gmailAccountFor
    >,
);

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), ...cfgOverride }),
    listWritableCalendars: listWritableCalendarsMock,
    recentEventCount: recentEventCountMock,
    gmailAccountFor: gmailAccountForMock,
  };
});

const { listCalendarsRoute } = await import("../src/api/calendar-setup.ts");

function req(url: string): Request {
  return new Request(url, { headers: { host: "127.0.0.1:3030" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  gmailAccountForMock.mockReturnValue({
    refreshToken: "rt",
    clientId: "id",
    clientSecret: "secret",
  } as unknown as ReturnType<typeof import("@oneshot-gtm/core").gmailAccountFor>);
  cfgOverride = {
    emailIdentities: [
      {
        id: "gmail:jn@x.dev",
        provider: "gmail",
        address: "jn@x.dev",
        maxPerDay: null,
        warmup: null,
      },
      {
        id: "oneshot:jn@mail.x.dev",
        provider: "oneshot",
        sendingDomain: "mail.x.dev",
        mailbox: "jn",
        maxPerDay: 40,
        warmup: null,
      },
    ],
  };
});

describe("GET /api/setup/calendars", () => {
  it("400s without an identityId", async () => {
    const res = await listCalendarsRoute(req("http://localhost/api/setup/calendars"));
    expect(res.status).toBe(400);
  });

  it("404s for an identityId not in the pool or not gmail", async () => {
    const res = await listCalendarsRoute(
      req("http://localhost/api/setup/calendars?identityId=oneshot:jn@mail.x.dev"),
    );
    expect(res.status).toBe(404);
    expect(listWritableCalendarsMock).not.toHaveBeenCalled();
  });

  it("404s for an unknown identityId", async () => {
    const res = await listCalendarsRoute(
      req("http://localhost/api/setup/calendars?identityId=gmail:never@x.dev"),
    );
    expect(res.status).toBe(404);
  });

  it("404s when the identity has no refresh token stored", async () => {
    gmailAccountForMock.mockReturnValue(
      null as unknown as ReturnType<typeof import("@oneshot-gtm/core").gmailAccountFor>,
    );
    const res = await listCalendarsRoute(
      req("http://localhost/api/setup/calendars?identityId=gmail:jn@x.dev"),
    );
    expect(res.status).toBe(404);
  });

  it("returns calendars with a 7-day event count fanned out per entry", async () => {
    listWritableCalendarsMock.mockResolvedValue([
      { id: "primary", summary: "Jane", accessRole: "owner" },
      { id: "work@group.calendar.google.com", summary: "Team", accessRole: "writer" },
    ]);
    recentEventCountMock.mockResolvedValueOnce(5).mockResolvedValueOnce(2);
    const res = await listCalendarsRoute(
      req("http://localhost/api/setup/calendars?identityId=gmail:jn@x.dev"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      calendars: Array<{ id: string; recentEventCount: number }>;
    };
    expect(body.calendars).toEqual([
      { id: "primary", summary: "Jane", accessRole: "owner", recentEventCount: 5 },
      {
        id: "work@group.calendar.google.com",
        summary: "Team",
        accessRole: "writer",
        recentEventCount: 2,
      },
    ]);
  });

  it("maps a listWritableCalendars failure to a 502, not a 500", async () => {
    listWritableCalendarsMock.mockRejectedValue(
      new Error("Gmail API failed (401): re-auth required"),
    );
    const res = await listCalendarsRoute(
      req("http://localhost/api/setup/calendars?identityId=gmail:jn@x.dev"),
    );
    expect(res.status).toBe(502);
    expect((await res.json()) as { error: string }).toEqual({
      error: "Gmail API failed (401): re-auth required",
    });
  });
});
