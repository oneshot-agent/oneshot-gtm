import { describe, expect, it } from "vitest";
import { buildAuditOpts, receiptUrlForId } from "../src/oneshot.ts";

describe("receiptUrlForId", () => {
  it("formats a receipt id as a local:// URL", () => {
    expect(receiptUrlForId(1)).toBe("local://receipt/1");
    expect(receiptUrlForId(42)).toBe("local://receipt/42");
    expect(receiptUrlForId(0)).toBe("local://receipt/0");
  });
});

describe("buildAuditOpts", () => {
  it("applies default memo and decisionContext from playName + callType", () => {
    const out = buildAuditOpts({ playName: "show-hn" }, "email.send");
    expect(out.memo).toBe("show-hn email.send");
    expect(out.decisionContext).toEqual({ playName: "show-hn", callType: "email.send" });
  });

  it("caller-supplied memo wins over the default", () => {
    const out = buildAuditOpts(
      { playName: "show-hn", memo: "manual reply to inbound" },
      "email.send",
    );
    expect(out.memo).toBe("manual reply to inbound");
  });

  it("caller decisionContext merges over defaults (caller keys win)", () => {
    const out = buildAuditOpts(
      {
        playName: "show-hn",
        decisionContext: { source: "play.initial", prospectEmail: "p@x.dev", playName: "override" },
      },
      "email.send",
    );
    expect(out.decisionContext).toEqual({
      playName: "override",
      callType: "email.send",
      source: "play.initial",
      prospectEmail: "p@x.dev",
    });
  });

  it("empty decisionContext still yields the defaults", () => {
    const out = buildAuditOpts({ playName: "x", decisionContext: {} }, "research.deep");
    expect(out.decisionContext).toEqual({ playName: "x", callType: "research.deep" });
  });

  it("overriding memo keeps decisionContext at defaults (and vice versa)", () => {
    const out = buildAuditOpts({ playName: "x", memo: "custom only" }, "enrich.profile");
    expect(out.memo).toBe("custom only");
    expect(out.decisionContext).toEqual({ playName: "x", callType: "enrich.profile" });
  });
});
