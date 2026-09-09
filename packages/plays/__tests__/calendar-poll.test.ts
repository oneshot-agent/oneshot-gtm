import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Calendar poll + matcher (issue #577). Uses a REAL Ledger (temp sqlite file)
// for realistic prospect-matching behavior, and mocks only the parts that
// would otherwise touch the network or process env: loadConfig,
// resolveIdentities, gmailAccountFor, listCalendarEvents, logEvent, demoMode.

let cfg: {
  calendarIdentityId: string | null;
  calendarId: string;
  founderEmail: string | null;
  timezone: string | null;
};
let identities: Array<{ id: string; provider: string; address?: string | null }>;
let calendarEventsQueue: Array<{
  items: Array<Record<string, unknown>>;
  nextPageToken?: string | null;
}>;
let listCalendarEventsCalls: Array<Record<string, unknown>> = [];
let listCalendarEventsImpl:
  | ((account: unknown, opts: Record<string, unknown>) => Promise<unknown>)
  | null = null;
let ledgerInstance: import("../../core/src/ledger.ts").Ledger;
let dbPath: string;
let loggedEvents: Array<{ name: string; payload: unknown; level?: string }> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    demoMode: () => false,
    loadConfig: () => cfg,
    resolveIdentities: () => identities,
    loadGmailTokens: () => ({}),
    gmailAccountFor: (identity: { id: string }) =>
      identities.some((i) => i.id === identity.id) ? { id: identity.id, refreshToken: "rt" } : null,
    clearGmailTokenScope: () => {},
    getLedger: () => ledgerInstance,
    logEvent: (name: string, payload?: unknown, level?: string) => {
      loggedEvents.push({ name, payload, level });
    },
    listCalendarEvents: async (account: unknown, opts: Record<string, unknown>) => {
      listCalendarEventsCalls.push(opts);
      if (listCalendarEventsImpl) return listCalendarEventsImpl(account, opts);
      const page = calendarEventsQueue.shift();
      return page
        ? { items: page.items, nextPageToken: page.nextPageToken ?? null }
        : { items: [], nextPageToken: null };
    },
  };
});

const { pollCalendarMeetings } = await import("../src/_calendar.ts");
const { Ledger } = await import("../../core/src/ledger.ts");

beforeEach(() => {
  dbPath = join(
    tmpdir(),
    `oneshot-gtm-calpoll-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  ledgerInstance = new Ledger(dbPath);
  cfg = {
    calendarIdentityId: "gmail:jn@x.dev",
    calendarId: "primary",
    founderEmail: "founder@x.dev",
    timezone: "UTC",
  };
  identities = [{ id: "gmail:jn@x.dev", provider: "gmail", address: "jn@x.dev" }];
  calendarEventsQueue = [];
  listCalendarEventsCalls = [];
  listCalendarEventsImpl = null;
  loggedEvents = [];
});

afterEach(() => {
  ledgerInstance.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // ignore
    }
  }
});

function event(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "e1",
    status: "confirmed",
    summary: "Intro call",
    start: { dateTime: "2020-01-01T14:00:00Z" },
    end: { dateTime: "2020-01-01T14:30:00Z" },
    updated: "2020-01-01T10:00:00Z",
    organizer: { email: "founder@x.dev", self: true },
    attendees: [
      { email: "founder@x.dev", self: true, responseStatus: "accepted" },
      { email: "pat@acme.com", displayName: "Pat Prospect" },
    ],
    ...over,
  };
}

describe("pollCalendarMeetings — idle states", () => {
  it("is idle when calendarIdentityId is null", async () => {
    cfg.calendarIdentityId = null;
    const res = await pollCalendarMeetings();
    expect(res.idle).toBe(true);
    expect(listCalendarEventsCalls).toHaveLength(0);
  });

  it("is idle and logs once when the configured identity is dangling", async () => {
    cfg.calendarIdentityId = "gmail:gone@x.dev";
    const res = await pollCalendarMeetings();
    expect(res.idle).toBe(true);
    expect(loggedEvents.some((e) => e.name === "scheduler.calendar_poll.dangling_identity")).toBe(
      true,
    );
  });
});

describe("pollCalendarMeetings — ingest + matching", () => {
  it("ingests a confirmed event and exact-matches the prospect by email", async () => {
    const pid = ledgerInstance.upsertProspect({ email: "pat@acme.com", source: "t" });
    calendarEventsQueue = [{ items: [event()] }];
    const res = await pollCalendarMeetings();
    expect(res.idle).toBe(false);
    expect(res.meetingsIngested).toBe(1);
    expect(res.matched).toBe(1);
    const row = ledgerInstance.getMeeting("primary", "e1")!;
    expect(row.prospect_id).toBe(pid);
    expect(row.match_status).toBe("exact");
  });

  it("skips a self-block (no external candidate survives exclusion)", async () => {
    calendarEventsQueue = [
      {
        items: [
          event({
            attendees: [{ email: "founder@x.dev", self: true, responseStatus: "accepted" }],
          }),
        ],
      },
    ];
    const res = await pollCalendarMeetings();
    expect(res.selfBlocksSkipped).toBe(1);
    expect(ledgerInstance.getMeeting("primary", "e1")).toBeNull();
  });

  it("excludes an eventType in the exclusion list (e.g. outOfOffice) even with an external-looking attendee", async () => {
    calendarEventsQueue = [{ items: [event({ eventType: "outOfOffice" })] }];
    await pollCalendarMeetings();
    expect(ledgerInstance.getMeeting("primary", "e1")).toBeNull();
  });

  it("stores an all-day event with all_day=1 and excludes it from the pending-outcome query", async () => {
    ledgerInstance.upsertProspect({ email: "pat@acme.com", source: "t" });
    calendarEventsQueue = [
      {
        items: [
          event({
            start: { date: "2020-01-01" },
            end: { date: "2020-01-02" },
          }),
        ],
      },
    ];
    await pollCalendarMeetings();
    const row = ledgerInstance.getMeeting("primary", "e1")!;
    expect(row.all_day).toBe(1);
    expect(ledgerInstance.listPendingOutcomeMeetings()).toEqual([]);
  });

  it("stores the founder's own responseStatus (self_response) and excludes a declined event from the nudge", async () => {
    ledgerInstance.upsertProspect({ email: "pat@acme.com", source: "t" });
    calendarEventsQueue = [
      {
        items: [
          event({
            attendees: [
              { email: "founder@x.dev", self: true, responseStatus: "declined" },
              { email: "pat@acme.com", displayName: "Pat Prospect" },
            ],
          }),
        ],
      },
    ];
    await pollCalendarMeetings();
    const row = ledgerInstance.getMeeting("primary", "e1")!;
    expect(row.self_response).toBe("declined");
    expect(ledgerInstance.listPendingOutcomeMeetings()).toEqual([]);
  });

  it("keeps recurring_event_id so a rescheduled instance is never forked", async () => {
    calendarEventsQueue = [{ items: [event({ recurringEventId: "series-1" })] }];
    await pollCalendarMeetings();
    expect(ledgerInstance.getMeeting("primary", "e1")!.recurring_event_id).toBe("series-1");
  });

  it("stores ical_uid", async () => {
    calendarEventsQueue = [{ items: [event({ iCalUID: "uid-1@google.com" })] }];
    await pollCalendarMeetings();
    expect(ledgerInstance.getMeeting("primary", "e1")!.ical_uid).toBe("uid-1@google.com");
  });

  it("downgrades even a single exact hit to suggested when attendeesOmitted is set", async () => {
    const pid = ledgerInstance.upsertProspect({ email: "pat@acme.com", source: "t" });
    calendarEventsQueue = [{ items: [event({ attendeesOmitted: true })] }];
    await pollCalendarMeetings();
    const row = ledgerInstance.getMeeting("primary", "e1")!;
    expect(row.match_status).toBe("suggested");
    expect(row.prospect_id).toBeNull();
    expect(row.suggested_prospect_id).toBe(pid);
  });

  it("downgrades a single exact hit to suggested when externals exceed the large-invite threshold", async () => {
    ledgerInstance.upsertProspect({ email: "pat@acme.com", source: "t" });
    const manyExternals = Array.from({ length: 9 }, (_, i) => ({ email: `p${i}@other.com` }));
    calendarEventsQueue = [
      {
        items: [
          event({
            attendees: [
              { email: "founder@x.dev", self: true, responseStatus: "accepted" },
              { email: "pat@acme.com", displayName: "Pat Prospect" },
              ...manyExternals,
            ],
          }),
        ],
      },
    ];
    await pollCalendarMeetings();
    const row = ledgerInstance.getMeeting("primary", "e1")!;
    expect(row.match_status).toBe("suggested");
  });

  it("marks ambiguous when two prospects independently exact-match and neither has outreach history", async () => {
    ledgerInstance.upsertProspect({ email: "pat@acme.com", source: "t" });
    ledgerInstance.upsertProspect({ email: "sam@acme.com", source: "t" });
    calendarEventsQueue = [
      {
        items: [
          event({
            attendees: [
              { email: "founder@x.dev", self: true, responseStatus: "accepted" },
              { email: "pat@acme.com" },
              { email: "sam@acme.com" },
            ],
          }),
        ],
      },
    ];
    await pollCalendarMeetings();
    const row = ledgerInstance.getMeeting("primary", "e1")!;
    expect(row.match_status).toBe("ambiguous");
    expect(row.prospect_id).toBeNull();
  });

  it("tie-breaks two exact hits to the one with outreach history", async () => {
    const withHistory = ledgerInstance.upsertProspect({ email: "pat@acme.com", source: "t" });
    ledgerInstance.upsertProspect({ email: "sam@acme.com", source: "t" });
    ledgerInstance.recordSequenceEvent({
      prospectId: withHistory,
      playName: "x",
      stepIndex: 0,
      channel: "email",
      status: "sent",
    });
    calendarEventsQueue = [
      {
        items: [
          event({
            attendees: [
              { email: "founder@x.dev", self: true, responseStatus: "accepted" },
              { email: "pat@acme.com" },
              { email: "sam@acme.com" },
            ],
          }),
        ],
      },
    ];
    await pollCalendarMeetings();
    const row = ledgerInstance.getMeeting("primary", "e1")!;
    expect(row.match_status).toBe("exact");
    expect(row.prospect_id).toBe(withHistory);
  });

  it("fuzzy-matches by domain + full-name (0.90, name_domain) — never auto-linked", async () => {
    const pid = ledgerInstance.upsertProspect({
      email: "pat.other@acme.com",
      name: "Pat Prospect",
      company: "Acme",
      source: "t",
    });
    calendarEventsQueue = [{ items: [event()] }]; // attendee pat@acme.com, displayName "Pat Prospect"
    await pollCalendarMeetings();
    const row = ledgerInstance.getMeeting("primary", "e1")!;
    expect(row.match_status).toBe("suggested");
    expect(row.match_method).toBe("name_domain");
    expect(row.suggested_prospect_id).toBe(pid);
    expect(row.prospect_id).toBeNull(); // fuzzy is NEVER auto-linked
  });

  it("does not use a freemail domain for the plain domain fuzzy signal", async () => {
    ledgerInstance.upsertProspect({
      email: "someoneelse@gmail.com",
      name: "Totally Different Name",
      source: "t",
    });
    calendarEventsQueue = [
      {
        items: [
          event({
            attendees: [
              { email: "founder@x.dev", self: true, responseStatus: "accepted" },
              { email: "pat@gmail.com", displayName: "Pat Prospect" },
            ],
          }),
        ],
      },
    ];
    await pollCalendarMeetings();
    const row = ledgerInstance.getMeeting("primary", "e1")!;
    expect(row.match_status).toBeNull();
  });

  it("a founder's dismiss survives a re-poll with an UNCHANGED attendee fingerprint", async () => {
    // Use a non-exact (fuzzy) match so a dismiss is meaningful — an EXACT
    // match auto-links prospect_id, and dismissMeetingMatch only clears
    // suggested_prospect_id, not prospect_id (exact hits aren't the case
    // this mechanism exists to suppress). Deliberately NOT registering
    // pat@acme.com itself, or the exact-match path would win over fuzzy.
    ledgerInstance.upsertProspect({
      email: "pat.other@acme.com",
      name: "Pat Prospect",
      company: "Acme",
      source: "t",
    });
    calendarEventsQueue = [{ items: [event()] }]; // fuzzy name_domain match
    await pollCalendarMeetings();
    expect(ledgerInstance.getMeeting("primary", "e1")!.match_status).toBe("suggested");
    ledgerInstance.dismissMeetingMatch("primary", "e1");
    // Re-poll: SAME event, updated timestamp bumped so it isn't the
    // touch-only fast path, but the attendee set is unchanged.
    calendarEventsQueue = [{ items: [event({ updated: "2020-01-01T11:00:00Z" })] }];
    await pollCalendarMeetings();
    const row = ledgerInstance.getMeeting("primary", "e1")!;
    expect(row.match_status).toBe("dismissed");
    expect(row.suggested_prospect_id).toBeNull();
  });

  it("re-matches once the attendee set (fingerprint) actually changes after a dismiss", async () => {
    ledgerInstance.upsertProspect({ email: "pat@acme.com", source: "t" });
    const pid2 = ledgerInstance.upsertProspect({ email: "sam@acme.com", source: "t" });
    calendarEventsQueue = [{ items: [event()] }];
    await pollCalendarMeetings();
    ledgerInstance.dismissMeetingMatch("primary", "e1");
    calendarEventsQueue = [
      {
        items: [
          event({
            updated: "2020-01-01T11:00:00Z",
            attendees: [
              { email: "founder@x.dev", self: true, responseStatus: "accepted" },
              { email: "sam@acme.com" },
            ],
          }),
        ],
      },
    ];
    await pollCalendarMeetings();
    const row = ledgerInstance.getMeeting("primary", "e1")!;
    expect(row.match_status).toBe("exact");
    expect(row.prospect_id).toBe(pid2);
  });

  it("the fast path (unchanged event_updated_at) touches only last_seen_at, no re-matching", async () => {
    ledgerInstance.upsertProspect({ email: "pat@acme.com", source: "t" });
    calendarEventsQueue = [{ items: [event()] }];
    await pollCalendarMeetings();
    ledgerInstance.dismissMeetingMatch("primary", "e1");
    // Same `updated` timestamp — the poller must not re-derive anything,
    // including re-running the matcher that would otherwise flip a stale
    // dismiss back to exact.
    calendarEventsQueue = [{ items: [event()] }];
    await pollCalendarMeetings();
    expect(ledgerInstance.getMeeting("primary", "e1")!.match_status).toBe("dismissed");
  });

  it("a cancellation for an event never seen is a no-op — nothing inserted", async () => {
    calendarEventsQueue = [{ items: [{ id: "never-seen", status: "cancelled" }] }];
    const res = await pollCalendarMeetings();
    expect(res.meetingsIngested).toBe(0);
    expect(ledgerInstance.getMeeting("primary", "never-seen")).toBeNull();
  });

  it("a cancellation for an event already seen updates it in place without wiping prospect_id", async () => {
    const pid = ledgerInstance.upsertProspect({ email: "pat@acme.com", source: "t" });
    calendarEventsQueue = [{ items: [event()] }];
    await pollCalendarMeetings();
    calendarEventsQueue = [{ items: [{ id: "e1", status: "cancelled" }] }];
    await pollCalendarMeetings();
    const row = ledgerInstance.getMeeting("primary", "e1")!;
    expect(row.status).toBe("cancelled");
    expect(row.prospect_id).toBe(pid);
  });
});

describe("pollCalendarMeetings — watermark + resync", () => {
  it("advances the watermark to max(item.updated) on a clean poll", async () => {
    calendarEventsQueue = [
      {
        items: [
          event({ id: "e1", updated: "2020-01-01T10:00:00Z" }),
          event({ id: "e2", updated: "2020-01-01T12:00:00Z" }),
        ],
      },
    ];
    await pollCalendarMeetings();
    const mark = JSON.parse(ledgerInstance.getPollWatermark("calendar_events")!);
    expect(mark.updatedMin).toBe("2020-01-01T12:00:00Z");
    expect(mark.calendarId).toBe("primary");
    expect(mark.identityId).toBe("gmail:jn@x.dev");
  });

  it("does not advance the watermark on a failed page", async () => {
    listCalendarEventsImpl = async () => {
      const { CalendarApiError } = await import("../../core/src/gcal.ts");
      throw new CalendarApiError("boom", 500, null);
    };
    const res = await pollCalendarMeetings();
    expect(res.clean).toBe(false);
    expect(ledgerInstance.getPollWatermark("calendar_events")).toBeNull();
  });

  it("repointing the calendar forces a full resync (no updatedMin sent)", async () => {
    ledgerInstance.setPollWatermark(
      "calendar_events",
      JSON.stringify({
        calendarId: "OTHER-cal",
        identityId: "gmail:jn@x.dev",
        updatedMin: "2020-01-01T00:00:00Z",
      }),
    );
    calendarEventsQueue = [{ items: [] }];
    await pollCalendarMeetings();
    expect(listCalendarEventsCalls[0]!["updatedMin"]).toBeUndefined();
  });

  it("a 410 clears the watermark path and re-runs once with no updatedMin, capped at one resync", async () => {
    ledgerInstance.setPollWatermark(
      "calendar_events",
      JSON.stringify({
        calendarId: "primary",
        identityId: "gmail:jn@x.dev",
        updatedMin: "2020-01-01T00:00:00Z",
      }),
    );
    let call = 0;
    listCalendarEventsImpl = async () => {
      call++;
      if (call === 1) {
        const { CalendarApiError } = await import("../../core/src/gcal.ts");
        throw new CalendarApiError("gone", 410, null);
      }
      return { items: [event()], nextPageToken: null };
    };
    const res = await pollCalendarMeetings();
    expect(res.resynced).toBe(true);
    expect(loggedEvents.some((e) => e.name === "scheduler.calendar_poll.resync")).toBe(true);
    expect(res.meetingsIngested).toBe(1);
  });
});
