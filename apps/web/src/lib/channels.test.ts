import { describe, expect, it } from "vitest";
import { reachableChannels, xHandleFrom } from "./channels.ts";

describe("reachableChannels", () => {
  it("lists every channel the payload has an address for", () => {
    expect(
      reachableChannels({
        email: "a@x.com",
        linkedinUrl: "https://www.linkedin.com/in/ada",
        handle: "ada",
      }),
    ).toEqual(["email", "linkedin", "x"]);
  });

  it("ignores blank fields and non-profile LinkedIn URLs", () => {
    expect(
      reachableChannels({ email: " ", linkedinUrl: "https://www.linkedin.com/company/acme" }),
    ).toEqual([]);
  });
});

describe("xHandleFrom", () => {
  it("reads a handle from a handle or an X profile URL", () => {
    expect(xHandleFrom("https://x.com/dana_lee")).toBe("dana_lee");
    expect(xHandleFrom("@dana_lee")).toBe("dana_lee");
    expect(xHandleFrom("not a handle!")).toBeNull();
  });
});
