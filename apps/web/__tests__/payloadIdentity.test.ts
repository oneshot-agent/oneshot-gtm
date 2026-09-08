import { describe, expect, it } from "vitest";
import {
  companyFor,
  emailFor,
  linkedinUrlFor,
  nameFor,
  phoneFor,
  sourceDetail,
  titleFor,
} from "../src/lib/payloadIdentity.ts";

describe("payload identity readers", () => {
  it("prefers the plain keys and falls back to the show-hn founder keys", () => {
    expect(nameFor({ name: "Ada", founderName: "ada_l" })).toBe("Ada");
    expect(nameFor({ founderName: "ada_l" })).toBe("ada_l");
    expect(emailFor({ email: "a@b.example" })).toBe("a@b.example");
    expect(emailFor({ founderEmail: "f@b.example" })).toBe("f@b.example");
  });

  it("derives a handle for URL-only rejects", () => {
    expect(nameFor({ repoUrl: "https://github.com/octo/engine?tab=readme" })).toBe("octo/engine");
    expect(nameFor({ postUrl: "https://www.example.org/post/1" })).toBe("example.org");
    expect(nameFor({ postUrl: "not a url" })).toBeNull();
  });

  it("returns null on anything that is not an object payload", () => {
    for (const bad of [null, undefined, "str", 42, ["a"]]) {
      expect(nameFor(bad)).toBeNull();
      expect(emailFor(bad)).toBeNull();
      expect(companyFor(bad)).toBeNull();
      expect(titleFor(bad)).toBeNull();
      expect(linkedinUrlFor(bad)).toBeNull();
      expect(phoneFor(bad)).toBeNull();
    }
  });

  it("only renders a real LinkedIn profile link", () => {
    expect(linkedinUrlFor({ linkedinUrl: "https://www.linkedin.com/in/ada" })).toBe(
      "https://www.linkedin.com/in/ada",
    );
    expect(linkedinUrlFor({ linkedinUrl: "javascript:alert(1)" })).toBeNull();
    // A scheme smuggled in front of a real-looking host, as a stored column value might carry.
    expect(linkedinUrlFor({ linkedinUrl: "javascript:x//linkedin.com/in/a" })).toBeNull();
    expect(linkedinUrlFor({ linkedinUrl: null })).toBeNull();
    expect(linkedinUrlFor({ linkedinUrl: "https://x.com/ada" })).toBeNull();
  });

  it("trims titles, keeps phones verbatim, and strips the finder prefix from source", () => {
    expect(titleFor({ title: "  CTO " })).toBe("CTO");
    expect(titleFor({ title: "   " })).toBeNull();
    expect(phoneFor({ phone: "+1 555" })).toBe("+1 555");
    expect(sourceDetail("find:github-stars:vercel/eve")).toBe("vercel/eve");
    expect(sourceDetail("find:show-hn")).toBe("");
    expect(sourceDetail(null)).toBe("");
  });
});
