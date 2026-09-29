import { describe, expect, it } from "vitest";
import { canonicalLinkedInProfileKey } from "../src/ledger-prospects.ts";

// The key a prospect's LinkedIn URL and a resolved reply sender meet on.
// A URL it cannot key can never be matched to a reply.

describe("canonicalLinkedInProfileKey", () => {
  it("keys www, mobile and country hosts the same", () => {
    for (const u of [
      "https://www.linkedin.com/in/ada",
      "https://linkedin.com/in/ada/",
      "http://mobile.linkedin.com/in/Ada?trk=x",
      "https://br.linkedin.com/in/ada",
    ])
      expect(canonicalLinkedInProfileKey(u)).toBe("linkedin.com/in/ada");
  });

  it("drops the locale segment LinkedIn appends to shared links", () => {
    expect(
      canonicalLinkedInProfileKey("https://br.linkedin.com/in/thiago-menzinger-5029a42b9/en"),
    ).toBe("linkedin.com/in/thiago-menzinger-5029a42b9");
    expect(canonicalLinkedInProfileKey("https://www.linkedin.com/in/ada/pt-br/")).toBe(
      "linkedin.com/in/ada",
    );
  });

  it("still refuses pages that are not a profile", () => {
    expect(canonicalLinkedInProfileKey("https://www.linkedin.com/company/acme")).toBeNull();
    expect(
      canonicalLinkedInProfileKey("https://www.linkedin.com/in/ada/details/experience"),
    ).toBeNull();
    expect(canonicalLinkedInProfileKey("https://example.com/in/ada")).toBeNull();
  });
});
