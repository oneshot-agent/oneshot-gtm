import { describe, expect, it } from "vitest";
import { classifyPlacement, parseAuthResults, rfc822MsgIdQuery } from "../src/gmail.ts";

describe("classifyPlacement", () => {
  it("reads a clean inbox delivery", () => {
    expect(classifyPlacement(["UNREAD", "INBOX", "CATEGORY_PERSONAL"])).toBe("inbox");
  });

  it("reports Promotions even though the message also carries INBOX", () => {
    // The whole point of the test: a tab-binned message looks delivered by
    // every other measure. Checking INBOX first would call this a clean hit.
    expect(classifyPlacement(["INBOX", "CATEGORY_PROMOTIONS", "UNREAD"])).toBe("promotions");
  });

  it.each([["CATEGORY_SOCIAL"], ["CATEGORY_UPDATES"], ["CATEGORY_FORUMS"]])(
    "reports %s as a tab, not an inbox hit",
    (tab) => {
      expect(classifyPlacement(["INBOX", tab])).toBe("tab");
    },
  );

  it("reports spam", () => {
    expect(classifyPlacement(["SPAM", "UNREAD"])).toBe("spam");
  });

  it("prefers SPAM over any other label", () => {
    expect(classifyPlacement(["SPAM", "INBOX", "CATEGORY_PROMOTIONS"])).toBe("spam");
  });

  it("treats CATEGORY_PERSONAL as the primary tab, not a demotion", () => {
    expect(classifyPlacement(["INBOX", "CATEGORY_PERSONAL"])).toBe("inbox");
  });

  it("reports a message with no inbox label as archived", () => {
    expect(classifyPlacement(["UNREAD"])).toBe("archived");
    expect(classifyPlacement([])).toBe("archived");
    expect(classifyPlacement(["TRASH"])).toBe("archived");
  });
});

describe("parseAuthResults", () => {
  it("reads spf/dkim/dmarc off a real Gmail header", () => {
    const header =
      "mx.google.com; dkim=pass header.i=@corp.example header.s=google header.b=Ab1; " +
      "spf=pass (google.com: domain of me@corp.example designates 209.85.0.1 as permitted sender) " +
      "smtp.mailfrom=me@corp.example; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=corp.example";
    expect(parseAuthResults([header])).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass" });
  });

  it("reads failures and softfails", () => {
    expect(
      parseAuthResults(["mx.google.com; spf=softfail; dkim=fail; dmarc=fail (p=NONE)"]),
    ).toEqual({ spf: "softfail", dkim: "fail", dmarc: "fail" });
  });

  it("reports unknown for mechanisms the header doesn't mention", () => {
    // Absence is not a pass — an internal relay may evaluate nothing at all.
    expect(parseAuthResults(["mx.google.com; spf=pass"])).toEqual({
      spf: "pass",
      dkim: "unknown",
      dmarc: "unknown",
    });
  });

  it("returns all-unknown when there is no header", () => {
    expect(parseAuthResults([])).toEqual({ spf: "unknown", dkim: "unknown", dmarc: "unknown" });
  });

  it("takes the first header that states a verdict, ignoring later ARC copies", () => {
    expect(
      parseAuthResults(["mx.google.com; dmarc=pass", "i=1; mx.relay.example; dmarc=fail"]),
    ).toMatchObject({ dmarc: "pass" });
  });

  it("does not mistake an arc- prefixed mechanism for the real one", () => {
    expect(parseAuthResults(["mx.google.com; arc=pass; spf=fail"])).toMatchObject({
      spf: "fail",
    });
  });

  it("ignores values that aren't real verdicts", () => {
    expect(parseAuthResults(["mx.google.com; spf=weird"])).toMatchObject({ spf: "unknown" });
  });
});

describe("rfc822MsgIdQuery", () => {
  it("strips the angle brackets Gmail's operator won't match", () => {
    expect(rfc822MsgIdQuery("<CAB123@mail.gmail.com>")).toBe("rfc822msgid:CAB123@mail.gmail.com");
  });

  it("passes a bare id through", () => {
    expect(rfc822MsgIdQuery(" CAB123@mail.gmail.com ")).toBe("rfc822msgid:CAB123@mail.gmail.com");
  });
});

describe("parseAuthResults — token boundaries", () => {
  it("does not read a hyphen-prefixed mechanism as the real one", () => {
    // `\b` matches after a hyphen, so a naive boundary would report
    // "arc-dkim=pass" as a dkim pass.
    expect(parseAuthResults(["mx.google.com; arc-dkim=pass; dkim=fail"])).toMatchObject({
      dkim: "fail",
    });
  });

  it("reads a mechanism at the very start of the header", () => {
    expect(parseAuthResults(["spf=pass; dkim=pass"])).toMatchObject({ spf: "pass" });
  });

  it("does not match a mechanism embedded in a longer word", () => {
    expect(parseAuthResults(["mx.google.com; xspf=pass"])).toMatchObject({ spf: "unknown" });
  });
});
