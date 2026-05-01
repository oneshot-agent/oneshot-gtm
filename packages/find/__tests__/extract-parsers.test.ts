import { describe, expect, it } from "vitest";
import { parseJobChangeExtract } from "../src/job-change.ts";
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

