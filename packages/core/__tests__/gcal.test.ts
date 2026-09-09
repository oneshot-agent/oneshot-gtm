import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetGmailCache } from "../src/gmail.ts";
import { CalendarApiError, listCalendarEvents, listWritableCalendars } from "../src/gcal.ts";

const GMAIL_KEYS = ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET"] as const;
let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  envSnapshot = {};
  for (const k of GMAIL_KEYS) {
    envSnapshot[k] = process.env[k];
    process.env[k] = `test-${k.toLowerCase()}`;
  }
  _resetGmailCache();
});

afterEach(() => {
  for (const k of GMAIL_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  _resetGmailCache();
  vi.unstubAllGlobals();
});

function tokenResponse(token = "at-1", expiresIn = 3600): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
    status: 200,
  });
}

const ACCOUNT = { id: "gmail:jn@x.dev", refreshToken: "rt-1" };

describe("listCalendarEvents", () => {
  it("requests the exact request shape the card specifies", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://oauth2.googleapis.com/")) return tokenResponse();
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await listCalendarEvents(ACCOUNT, {
      calendarId: "primary",
      updatedMin: "2026-01-01T00:00:00.000Z",
      timeMin: "2025-06-01T00:00:00.000Z",
      timeMax: "2027-02-01T00:00:00.000Z",
    });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/calendars/"));
    const url = decodeURIComponent(String(call![0]));
    expect(url).toContain("/calendars/primary/events");
    expect(url).toContain("singleEvents=true");
    expect(url).toContain("showDeleted=true");
    expect(url).toContain("orderBy=updated");
    expect(url).toContain("updatedMin=2026-01-01T00:00:00.000Z");
    expect(url).toContain("timeMin=2025-06-01T00:00:00.000Z");
    expect(url).toContain("timeMax=2027-02-01T00:00:00.000Z");
    // Never sent — an event over the cap would drop the prospect otherwise.
    expect(url).not.toContain("maxAttendees");
    // Never sent — filtering happens in code so drops can be logged.
    expect(url).not.toContain("eventTypes");
    expect(url).toContain(
      "fields=nextPageToken,items(id,iCalUID,status,summary,start,end,updated,organizer,creator,attendees,attendeesOmitted,recurringEventId,originalStartTime,eventType,hangoutLink,visibility,transparency,description)",
    );
  });

  it("URL-encodes a calendar id that needs it", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://oauth2.googleapis.com/")) return tokenResponse();
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await listCalendarEvents(ACCOUNT, {
      calendarId: "team@acme.com",
      timeMin: "2025-01-01T00:00:00.000Z",
      timeMax: "2026-01-01T00:00:00.000Z",
    });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/calendars/"));
    expect(String(call![0])).toContain("/calendars/team%40acme.com/events");
  });

  it("paginates via nextPageToken and returns items + the token", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://oauth2.googleapis.com/")) return tokenResponse();
      return new Response(JSON.stringify({ items: [{ id: "e1" }], nextPageToken: "p2" }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await listCalendarEvents(ACCOUNT, {
      calendarId: "primary",
      timeMin: "2025-01-01T00:00:00.000Z",
      timeMax: "2026-01-01T00:00:00.000Z",
    });
    expect(res.items).toEqual([{ id: "e1" }]);
    expect(res.nextPageToken).toBe("p2");
  });

  it("surfaces a 410 as CalendarApiError with the raw status", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://oauth2.googleapis.com/")) return tokenResponse();
      return new Response(JSON.stringify({ error: { message: "gone", status: "SOME_GONE" } }), {
        status: 410,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await listCalendarEvents(ACCOUNT, {
        calendarId: "primary",
        timeMin: "2025-01-01T00:00:00.000Z",
        timeMax: "2026-01-01T00:00:00.000Z",
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CalendarApiError);
      expect((err as CalendarApiError).httpStatus).toBe(410);
    }
  });

  it("surfaces ACCESS_TOKEN_SCOPE_INSUFFICIENT via googleStatus", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://oauth2.googleapis.com/")) return tokenResponse();
      return new Response(
        JSON.stringify({
          error: { message: "insufficient scope", status: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" },
        }),
        { status: 403 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await listCalendarEvents(ACCOUNT, {
        calendarId: "primary",
        timeMin: "2025-01-01T00:00:00.000Z",
        timeMax: "2026-01-01T00:00:00.000Z",
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CalendarApiError);
      expect((err as CalendarApiError).googleStatus).toBe("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    }
  });

  it("evicts the cached access token on a 401 so the next call re-refreshes", async () => {
    let tokenCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://oauth2.googleapis.com/")) {
        tokenCalls++;
        return tokenResponse(`at-${tokenCalls}`);
      }
      return new Response(JSON.stringify({}), { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      listCalendarEvents(ACCOUNT, {
        calendarId: "primary",
        timeMin: "2025-01-01T00:00:00.000Z",
        timeMax: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(CalendarApiError);
    // A second call must re-mint a token (cache was invalidated), not reuse
    // the dead at-1.
    await expect(
      listCalendarEvents(ACCOUNT, {
        calendarId: "primary",
        timeMin: "2025-01-01T00:00:00.000Z",
        timeMax: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(CalendarApiError);
    expect(tokenCalls).toBe(2);
  });

  it("does not read the response body on a 401", async () => {
    const textSpy = vi.fn().mockResolvedValue("{}");
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).startsWith("https://oauth2.googleapis.com/")) return tokenResponse();
      return { ok: false, status: 401, text: textSpy, body: undefined } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      listCalendarEvents(ACCOUNT, {
        calendarId: "primary",
        timeMin: "2025-01-01T00:00:00.000Z",
        timeMax: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(/Calendar auth rejected \(401\)/);
    expect(textSpy).not.toHaveBeenCalled();
  });
});

describe("listWritableCalendars", () => {
  it("requests minAccessRole=writer and maps entries", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith("https://oauth2.googleapis.com/")) return tokenResponse();
      return new Response(
        JSON.stringify({
          items: [
            { id: "primary", summary: "Jane", accessRole: "owner" },
            { id: "team@acme.com", accessRole: "writer" },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const cals = await listWritableCalendars(ACCOUNT);
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/calendarList"));
    expect(String(call![0])).toContain("minAccessRole=writer");
    expect(cals).toEqual([
      { id: "primary", summary: "Jane", accessRole: "owner" },
      { id: "team@acme.com", summary: "team@acme.com", accessRole: "writer" },
    ]);
  });
});
