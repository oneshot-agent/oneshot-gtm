import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Who is already connected, from the profile reads GTM keeps in the paid
// cache: a first-degree distance on a read from the last 14 days. Never a call
// to LinkedIn.

const { _resetPaidCache, getSharedDb, isFirstDegree, paidCacheKey } =
  await import("@oneshot-gtm/core");
const { knownConnection, knownConnectionDraft } = await import("../src/_linkedin-connection.ts");

const URL = "https://www.linkedin.com/in/dana-lee";
const NOW = new Date("2026-10-27T12:00:00.000Z");
const DAY = 86_400_000;

function storeRead(
  callType: "linkedin.profile_read" | "linkedin.profile",
  result: Record<string, unknown>,
  ageDays: number,
  url = URL,
) {
  getSharedDb().setPaidCache({
    key: paidCacheKey(callType, { url }),
    callType,
    status: "ok",
    resultJson: JSON.stringify(result),
    costUsd: 0.01,
    fetchedAt: new Date(NOW.getTime() - ageDays * DAY).toISOString(),
  });
}

/** A person-research read (`LiveProfile`) as `readLinkedInProfile` stores it. */
const fullRead = (networkDistance: string | null, ageDays: number) => ({
  url: URL,
  readAt: new Date(NOW.getTime() - ageDays * DAY).toISOString(),
  experience: [],
  networkDistance,
});

beforeEach(() => {
  process.env["ONESHOT_GTM_SHARED"] = mkdtempSync(join(tmpdir(), "linkedin-connection-"));
  _resetPaidCache();
});

describe("isFirstDegree", () => {
  it("accepts the view's spelling and the provider's alias, nothing else", () => {
    expect(isFirstDegree("FIRST_DEGREE")).toBe(true);
    expect(isFirstDegree("DISTANCE_1")).toBe(true);
    for (const other of ["SECOND_DEGREE", "THIRD_DEGREE", "DISTANCE_2", "first_degree", "", null]) {
      expect(isFirstDegree(other)).toBe(false);
    }
    expect(isFirstDegree(undefined)).toBe(false);
  });
});

describe("knownConnection", () => {
  it("a fresh first-degree read is a hit, with when it was read", () => {
    storeRead("linkedin.profile_read", fullRead("FIRST_DEGREE", 3), 3);
    expect(knownConnection(URL, NOW)).toEqual({
      readAt: new Date(NOW.getTime() - 3 * DAY).toISOString(),
    });
    // The same person under another spelling of the URL.
    expect(knownConnection("https://linkedin.com/in/dana-lee/", NOW)).not.toBeNull();
  });

  it("a silent view (`linkedin.profile`) that reports the distance counts too", () => {
    storeRead("linkedin.profile", { experience: [], networkDistance: "DISTANCE_1" }, 1);
    expect(knownConnection(URL, NOW)).toEqual({
      readAt: new Date(NOW.getTime() - DAY).toISOString(),
    });
  });

  it("misses on a read older than 14 days", () => {
    storeRead("linkedin.profile_read", fullRead("FIRST_DEGREE", 15), 15);
    expect(knownConnection(URL, NOW)).toBeNull();
  });

  it("misses on a distance carried over from a view older than 14 days, in a fresh entry", () => {
    storeRead(
      "linkedin.profile",
      {
        headline: "Founder",
        networkDistance: "FIRST_DEGREE",
        networkDistanceReadAt: new Date(NOW.getTime() - 20 * DAY).toISOString(),
        experience: [],
      },
      1,
    );
    expect(knownConnection(URL, NOW)).toBeNull();
  });

  it("misses on a pending invitee (SECOND_DEGREE) and on a read that does not say", () => {
    storeRead("linkedin.profile_read", fullRead("SECOND_DEGREE", 1), 1);
    expect(knownConnection(URL, NOW)).toBeNull();
    storeRead("linkedin.profile_read", fullRead(null, 1), 1);
    expect(knownConnection(URL, NOW)).toBeNull();
    // A read cached before the distance was kept.
    storeRead("linkedin.profile_read", { url: URL, readAt: "x", experience: [] }, 1);
    expect(knownConnection(URL, NOW)).toBeNull();
  });

  it("the newest read that reports a distance decides", () => {
    storeRead("linkedin.profile_read", fullRead("SECOND_DEGREE", 1), 1);
    storeRead("linkedin.profile", { experience: [], networkDistance: "FIRST_DEGREE" }, 5);
    expect(knownConnection(URL, NOW)).toBeNull();
    storeRead("linkedin.profile_read", fullRead("FIRST_DEGREE", 6), 6);
    expect(knownConnection(URL, NOW)).not.toBeNull();
  });

  it("misses with no read, and on anything that is not a personal profile", () => {
    expect(knownConnection(URL, NOW)).toBeNull();
    expect(knownConnection(null, NOW)).toBeNull();
    expect(knownConnection("https://www.linkedin.com/company/acme", NOW)).toBeNull();
  });

  it("makes no network call", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    storeRead("linkedin.profile_read", fullRead("FIRST_DEGREE", 2), 2);
    knownConnection(URL, NOW);
    knownConnection("https://www.linkedin.com/in/someone-else", NOW);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("knownConnectionDraft", () => {
  it("names the state and the read's date, and carries no flag", () => {
    expect(knownConnectionDraft({ readAt: "2026-10-20T09:00:00.000Z" })).toEqual({
      subject: "LinkedIn: already connected",
      body: "Already connected (profile read 2026-10-20): no connection request. The first message comes up on /cadences.",
      flags: [],
      knownConnection: { readAt: "2026-10-20T09:00:00.000Z" },
    });
  });
});
