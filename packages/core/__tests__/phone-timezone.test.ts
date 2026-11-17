import { describe, expect, it } from "vitest";
import {
  PHONE_TIMEZONE_DATA,
  countryOfTimeZone,
  defaultPhoneCountry,
  normalizePhone,
  phoneLocalTime,
  phoneTimeZones,
} from "../src/phone-timezone.ts";

const WINDOW = { start: "09:00", end: "17:00", weekdays: true };

describe("normalizePhone", () => {
  it.each([
    ["(512) 653-1187", "+15126531187"],
    ["512.653.1187", "+15126531187"],
    ["1 512 653 1187", "+15126531187"],
    ["+1 (512) 653-1187 ext. 22", "+15126531187"],
    ["tel:+15126531187", "+15126531187"],
    ["+44 20 7946 0958", "+442079460958"],
    ["0044 20 7946 0958", "+442079460958"],
    ["+15126531187", "+15126531187"],
  ])("reads %s as %s", (raw, e164) => {
    expect(normalizePhone(raw)).toBe(e164);
  });

  it.each([
    ["junk", "n/a"],
    ["letters", "call me"],
    ["too short", "12345"],
    ["a bad NANP exchange", "(512) 153-1187"],
    ["too long", "+1234567890123456"],
    ["blank", "   "],
    ["two numbers", "512-653-1187 / 512-653-1188"],
  ])("refuses %s", (_label, raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });

  it("reads national numbers in the workspace's country", () => {
    expect(normalizePhone("020 7946 0958", "GB")).toBe("+442079460958");
    expect(normalizePhone("(512) 653-1187", "CA")).toBe("+15126531187");
    expect(normalizePhone(null)).toBeNull();
  });

  it("takes the country from the workspace time zone, else the United States", () => {
    expect(countryOfTimeZone("Europe/London")).toBe("GB");
    expect(defaultPhoneCountry({ timezone: "Europe/London" })).toBe("GB");
    expect(defaultPhoneCountry({ timezone: null })).toBe("US");
    expect(defaultPhoneCountry({ timezone: "Mars/Base" })).toBe("US");
  });

  it("reads an old zone name the runtime still accepts", () => {
    expect(countryOfTimeZone("Asia/Calcutta")).toBe("IN");
    expect(defaultPhoneCountry({ timezone: "US/Pacific" })).toBe("US");
    expect(countryOfTimeZone("Europe/Kiev")).toBe("UA");
  });
});

describe("phoneTimeZones", () => {
  it("places US area codes, a non-US number, and nothing for an unknown one", () => {
    expect(phoneTimeZones("+15126531187")).toEqual(["America/Chicago"]);
    expect(phoneTimeZones("+12125550100")).toEqual(["America/New_York"]);
    expect(phoneTimeZones("+442079460958")).toContain("Europe/London");
    expect(phoneTimeZones("+999123456789")).toEqual([]);
    expect(phoneTimeZones("nonsense")).toEqual([]);
  });

  it("keeps its provenance", () => {
    expect(PHONE_TIMEZONE_DATA.libphonenumber.license).toBe("Apache-2.0");
    expect(PHONE_TIMEZONE_DATA.prefixes).toBeGreaterThan(3000);
  });
});

describe("phoneLocalTime", () => {
  // Tuesday 2026-11-17 15:00 UTC = 09:00 in Chicago, 10:00 in New York.
  const tuesday = new Date("2026-11-17T15:00:00Z");

  it("is in the window inside the prospect's hours", () => {
    expect(phoneLocalTime("+15126531187", WINDOW, tuesday)).toEqual({
      zones: ["America/Chicago"],
      localTime: "09:00",
      inWindow: true,
      opensAt: null,
    });
  });

  it("outside the window says when it next opens", () => {
    const early = new Date("2026-11-17T12:00:00Z"); // 06:00 in Chicago
    const out = phoneLocalTime("+15126531187", WINDOW, early);
    expect(out.inWindow).toBe(false);
    expect(out.localTime).toBe("06:00");
    expect(out.opensAt).toBe("2026-11-17T15:00:00.000Z");
  });

  it("skips the weekend when the window is weekdays, not when it is every day", () => {
    const saturday = new Date("2026-11-21T18:00:00Z"); // 12:00 in Chicago
    const out = phoneLocalTime("+15126531187", WINDOW, saturday);
    expect(out.inWindow).toBe(false);
    expect(out.opensAt).toBe("2026-11-23T15:00:00.000Z");
    expect(phoneLocalTime("+15126531187", { ...WINDOW, weekdays: false }, saturday).inWindow).toBe(
      true,
    );
  });

  it("must hold in every zone a number may be in", () => {
    // 1208 (Idaho) spans Boise and Los Angeles. 16:30 Boise = 15:30 Los Angeles.
    const zones = phoneTimeZones("+12085550100");
    expect(zones.length).toBeGreaterThan(1);
    const late = new Date("2026-11-17T23:30:00Z"); // 16:30 Boise, 15:30 Los Angeles
    expect(phoneLocalTime("+12085550100", WINDOW, late).inWindow).toBe(true);
    const later = new Date("2026-11-18T00:30:00Z"); // 17:30 Boise, 16:30 Los Angeles
    expect(phoneLocalTime("+12085550100", WINDOW, later).inWindow).toBe(false);
  });

  it("an unknown number reads as in the window with no zone", () => {
    expect(phoneLocalTime("+999123456789", WINDOW)).toEqual({
      zones: [],
      localTime: null,
      inWindow: true,
      opensAt: null,
    });
    expect(phoneLocalTime(null, WINDOW).inWindow).toBe(true);
  });
});

describe("review fixes", () => {
  it("reads a number written with its country code and no plus, without misreading national ones", () => {
    expect(normalizePhone("4712345678", "NO")).toBe("+4712345678");
    expect(normalizePhone("12345678", "NO")).toBe("+4712345678");
    expect(normalizePhone("525512345678", "MX")).toBe("+525512345678");
    // A ten-digit Mexican national number that starts with the code stays national.
    expect(normalizePhone("5212345678", "MX")).toBe("+525212345678");
    // North American numbers never take this path.
    expect(normalizePhone("4412345678", "US")).toBe("+14412345678");
  });

  it("+213 (Algeria) maps to Europe/Paris, as libphonenumber's own data does", () => {
    // libphonenumber map_data.txt at the pinned commit has `213|Europe/Paris`;
    // the data is vendored as published. Both read UTC+1 in winter.
    expect(phoneTimeZones("+213551234567")).toEqual(["Europe/Paris"]);
  });
});
