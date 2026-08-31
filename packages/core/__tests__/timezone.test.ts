import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "../src/config.ts";
import {
  cityTimeZone,
  formatLocalDay,
  formatLocalEventTime,
  installTimeZone,
  isValidTimeZone,
  localDayOffset,
  localShortDate,
  localWeekday,
  resolveEventZone,
} from "../src/timezone.ts";

// The bug these pin: a 7:30pm Wednesday event in San Francisco is the instant
// `2026-08-27T02:30:00Z`. Handed that, an LLM reads "27" and writes "Thursday"
// into a cold email about the reader's own event.
//
// Nothing here touches the network, and nothing depends on the machine's own
// TZ: every case either names its zone explicitly or pins the install zone via
// the config file (vitest.setup.ts already points ONESHOT_GTM_HOME at a temp
// dir, so these writes never reach the developer's real ~/.oneshot-gtm).
const SF_EVENING = "2026-08-27T02:30:00Z";

function setInstallZone(zone: string | null): void {
  saveConfig({ ...loadConfig(), timezone: zone });
}

afterEach(() => setInstallZone(null));

describe("formatLocalEventTime", () => {
  it("renders a late SF evening as the Wednesday it actually is", () => {
    expect(formatLocalEventTime(SF_EVENING, "America/Los_Angeles")).toBe(
      "Wednesday, August 26, 7:30 PM PDT",
    );
  });

  it("renders the SAME instant as Thursday in London", () => {
    // Same moment, genuinely a different calendar day there — proof the helper
    // reports the zone it was asked for rather than a single baked-in answer.
    expect(formatLocalEventTime(SF_EVENING, "Europe/London")).toContain("Thursday, August 27");
  });

  it("carries the zone abbreviation that matches the side of the DST boundary", () => {
    // 2026-11-01 01:30 local happens TWICE in Los Angeles — an hour apart in
    // UTC, once on daylight time and once on standard.
    expect(formatLocalEventTime("2026-11-01T08:30:00Z", "America/Los_Angeles")).toBe(
      "Sunday, November 1, 1:30 AM PDT",
    );
    expect(formatLocalEventTime("2026-11-01T09:30:00Z", "America/Los_Angeles")).toBe(
      "Sunday, November 1, 1:30 AM PST",
    );
  });

  it("falls back to the install timezone when the zone is missing or invalid", () => {
    setInstallZone("America/New_York");
    const expected = formatLocalEventTime(SF_EVENING, "America/New_York");
    expect(expected).toBe("Wednesday, August 26, 10:30 PM EDT");
    for (const bad of [null, undefined, "", "   ", "Not/AZone", "PDT"]) {
      expect(() => formatLocalEventTime(SF_EVENING, bad)).not.toThrow();
      expect(formatLocalEventTime(SF_EVENING, bad)).toBe(expected);
    }
  });

  it("renders a date-only source without inventing a time or a zone", () => {
    // The LLM extract emits bare dates when the page shows no clock time.
    // Printing "12:00 AM PDT" there would be a fact we were never given.
    expect(formatLocalEventTime("2026-08-26", "America/Los_Angeles")).toBe("Wednesday, August 26");
  });

  it("keeps a zoneless wall clock verbatim rather than guessing its zone", () => {
    expect(formatLocalEventTime("2026-08-26T19:30", "America/Los_Angeles")).toBe(
      "Wednesday, August 26, 7:30 PM",
    );
  });

  it("returns null (not 'Invalid Date') for a non-timestamp", () => {
    for (const junk of ["", "   ", "sometime next week", "TBD"]) {
      expect(formatLocalEventTime(junk, "America/Los_Angeles")).toBeNull();
    }
  });
});

describe("resolveEventZone", () => {
  it("prefers an explicit zone over the city and the install default", () => {
    setInstallZone("Asia/Tokyo");
    expect(resolveEventZone({ zone: "Europe/Berlin", city: "San Francisco" })).toBe(
      "Europe/Berlin",
    );
  });

  it("falls back to the event's city when no explicit zone is stated", () => {
    setInstallZone("Asia/Tokyo");
    expect(resolveEventZone({ zone: null, city: "San Francisco" })).toBe("America/Los_Angeles");
    expect(resolveEventZone({ zone: "PDT", city: "New York" })).toBe("America/New_York");
  });

  it("falls back to the install timezone when the city is unknown or remote", () => {
    setInstallZone("Asia/Tokyo");
    for (const city of [null, "", "Online", "Virtual", "Nowheresville"]) {
      expect(resolveEventZone({ city })).toBe("Asia/Tokyo");
    }
  });

  it("takes the install zone from an explicitly passed config value", () => {
    setInstallZone("Asia/Tokyo");
    // A caller that already holds a loaded config passes it rather than
    // re-reading the file; the passed value wins.
    expect(resolveEventZone({ city: "Online", installZone: "Europe/Paris" })).toBe("Europe/Paris");
  });

  it("always returns a usable zone, even with every input garbage", () => {
    setInstallZone("Not/AZone");
    const zone = resolveEventZone({ zone: "???", city: "???" });
    expect(isValidTimeZone(zone)).toBe(true);
    expect(() => formatLocalEventTime(SF_EVENING, zone)).not.toThrow();
  });
});

describe("cityTimeZone", () => {
  it("maps the finder's configured cities, case- and suffix-insensitively", () => {
    expect(cityTimeZone("San Francisco")).toBe("America/Los_Angeles");
    expect(cityTimeZone("  san francisco  ")).toBe("America/Los_Angeles");
    expect(cityTimeZone("San Francisco, CA")).toBe("America/Los_Angeles");
    expect(cityTimeZone("London, United Kingdom")).toBe("Europe/London");
    expect(cityTimeZone("NYC")).toBe("America/New_York");
  });

  it("returns null for online/unknown cities instead of guessing", () => {
    for (const city of [null, undefined, "", "Online", "Virtual", "Atlantis"]) {
      expect(cityTimeZone(city)).toBeNull();
    }
  });
});

describe("installTimeZone", () => {
  it("uses the configured zone when the founder set one", () => {
    setInstallZone("Europe/Vienna");
    expect(installTimeZone()).toBe("Europe/Vienna");
  });

  it("falls back to a real runtime zone when the config zone is unusable", () => {
    setInstallZone("Mars/Olympus_Mons");
    expect(isValidTimeZone(installTimeZone())).toBe(true);
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA names and rejects abbreviations and junk", () => {
    expect(isValidTimeZone("America/Los_Angeles")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    for (const bad of [null, undefined, "", "  ", "PDT", "Not/AZone"]) {
      expect(isValidTimeZone(bad)).toBe(false);
    }
  });
});

describe("calendar-day helpers", () => {
  it("reports the weekday and short date of the local day, not the UTC one", () => {
    expect(localWeekday(SF_EVENING, "America/Los_Angeles")).toBe("Wednesday");
    expect(localWeekday(SF_EVENING, "Europe/London")).toBe("Thursday");
    expect(localShortDate(SF_EVENING, "America/Los_Angeles")).toBe("Wed, Aug 26");
  });

  it("anchors 'today' with a full stated date", () => {
    expect(formatLocalDay(SF_EVENING, "America/Los_Angeles")).toBe("Wednesday, August 26, 2026");
  });

  it("counts whole calendar days, so a late-evening event is still today", () => {
    // Noon on the 26th in LA -> the 7:30pm event that night is day 0, even
    // though a millisecond delta over 24h would round it to tomorrow.
    const noonLa = Date.parse("2026-08-26T19:00:00Z");
    expect(localDayOffset(SF_EVENING, "America/Los_Angeles", noonLa)).toBe(0);
    // In London that same instant is already the next calendar day.
    expect(localDayOffset(SF_EVENING, "Europe/London", noonLa)).toBe(1);
    expect(localDayOffset("2026-08-25T20:00:00Z", "America/Los_Angeles", noonLa)).toBe(-1);
    expect(localDayOffset("2026-09-05T20:00:00Z", "America/Los_Angeles", noonLa)).toBe(10);
  });

  it("returns null for an unparseable instant instead of NaN days", () => {
    expect(localDayOffset("whenever", "America/Los_Angeles")).toBeNull();
    expect(localWeekday("whenever", "America/Los_Angeles")).toBeNull();
    expect(localShortDate("whenever", "America/Los_Angeles")).toBeNull();
    expect(formatLocalDay("whenever", "America/Los_Angeles")).toBeNull();
  });
});
