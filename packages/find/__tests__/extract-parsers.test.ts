import { describe, expect, it } from "vitest";
import { parseJobChangeExtract } from "../src/job-change.ts";
import { looksLikeLumaEventUrl, lumaEventSlug, parseLumaEventExtract } from "../src/luma.ts";
import { parsePodcastGuestExtract } from "../src/podcast-guest.ts";

describe("parseJobChangeExtract", () => {
  it("parses a fenced complete extract", () => {
    const raw = [
      "```json",
      JSON.stringify({
        fullName: "Sam Jones",
        newRole: "VP Engineering",
        newCompany: "Acme",
        newCompanyDomain: "acme.com",
        previousRole: "Director of Eng",
        previousCompany: "Corp",
        linkedinUrl: "https://linkedin.com/in/sam",
        summary: "moved from Corp to Acme",
      }),
      "```",
    ].join("\n");
    const out = parseJobChangeExtract(raw);
    expect(out.fullName).toBe("Sam Jones");
    expect(out.newCompanyDomain).toBe("acme.com");
  });

  it("returns all-null on garbage", () => {
    const out = parseJobChangeExtract("nope");
    expect(out.fullName).toBeNull();
    expect(out.newRole).toBeNull();
  });
});

describe("parsePodcastGuestExtract", () => {
  it("parses a complete extract", () => {
    const raw = JSON.stringify({
      podcastName: "Latent Space",
      episodeTitle: "The compressed-spring thesis",
      episodeUrl: "https://ex.com/ep",
      guestName: "Sam Jones",
      guestRole: "CEO",
      guestCompany: "Acme",
      guestCompanyDomain: "acme.com",
      publishedAt: "2026-04-01",
      summary: "talked about durable workflows",
    });
    const out = parsePodcastGuestExtract(raw);
    expect(out.podcastName).toBe("Latent Space");
    expect(out.guestName).toBe("Sam Jones");
    expect(out.guestCompanyDomain).toBe("acme.com");
  });

  it("returns all-null on garbage", () => {
    const out = parsePodcastGuestExtract("nope");
    expect(out.podcastName).toBeNull();
    expect(out.guestName).toBeNull();
  });
});

describe("parseLumaEventExtract", () => {
  it("parses a complete extract with attendees", () => {
    const raw = JSON.stringify({
      eventTitle: "SF AI Builders Meetup",
      eventDateIso: "2026-06-10",
      eventCity: "San Francisco",
      eventHasPassed: false,
      publicAttendees: [
        {
          name: "Sarah Chen",
          profileUrl: "https://luma.com/user/sarah-chen",
          websiteUrl: null,
          linkedinUrl: "https://linkedin.com/in/sarahchen",
          twitterUrl: null,
          bio: "Founder @ AcmeAI",
          role: "Speaker",
        },
      ],
    });
    const out = parseLumaEventExtract(raw);
    expect(out.eventTitle).toBe("SF AI Builders Meetup");
    expect(out.eventHasPassed).toBe(false);
    expect(out.publicAttendees).toHaveLength(1);
    expect(out.publicAttendees[0]?.name).toBe("Sarah Chen");
  });

  it("returns fallback (empty attendees) on garbage", () => {
    const out = parseLumaEventExtract("nope");
    expect(out.eventTitle).toBeNull();
    expect(out.publicAttendees).toEqual([]);
  });

  it("coerces null publicAttendees to an empty array", () => {
    const raw = JSON.stringify({
      eventTitle: "X",
      eventDateIso: null,
      eventCity: null,
      eventHasPassed: false,
      publicAttendees: null,
    });
    const out = parseLumaEventExtract(raw);
    expect(out.publicAttendees).toEqual([]);
  });
});

describe("lumaEventSlug", () => {
  const cases: Array<[string, string | null]> = [
    ["https://luma.com/abc123", "abc123"],
    ["https://lu.ma/xyz", "xyz"],
    ["https://www.luma.com/abc/", "abc"],
    ["https://luma.com/abc?utm=x", "abc"],
    ["https://luma.com/", null],
    ["https://luma.com/abc/def", null],
    ["https://example.com/abc", null],
    ["not a url", null],
  ];
  for (const [url, expected] of cases) {
    it(`${JSON.stringify(url)} → ${JSON.stringify(expected)}`, () => {
      expect(lumaEventSlug(url)).toBe(expected);
    });
  }
});

describe("looksLikeLumaEventUrl", () => {
  const cases: Array<[string, boolean]> = [
    ["https://luma.com/abc123", true],
    ["https://lu.ma/abc123", true],
    ["https://www.luma.com/xyz", true],
    ["https://luma.com/discover", false],
    ["https://luma.com/ai?k=t", false],
    ["https://luma.com/airstreet?k=c", false],
    ["https://luma.com/", false],
    ["https://luma.com/abc/def", false],
    ["https://example.com/abc", false],
    ["not a url", false],
  ];
  for (const [url, expected] of cases) {
    it(`${JSON.stringify(url)} → ${expected}`, () => {
      expect(looksLikeLumaEventUrl(url)).toBe(expected);
    });
  }
});
