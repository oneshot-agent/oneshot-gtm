import { describe, expect, it } from "vitest";
import {
  buildAuditOpts,
  cadenceGoalId,
  outcomeToValueTag,
  receiptUrlForId,
} from "../src/oneshot.ts";

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

describe("cadenceGoalId", () => {
  it("is deterministic and prefixed", () => {
    const id = cadenceGoalId("show-hn", "p@x.dev");
    expect(id).toBe(cadenceGoalId("show-hn", "p@x.dev"));
    expect(id).toMatch(/^goal_[0-9a-f]{24}$/);
  });

  it("canonicalizes the email (case + surrounding whitespace)", () => {
    const base = cadenceGoalId("show-hn", "p@x.dev");
    expect(cadenceGoalId("show-hn", "  P@X.DEV ")).toBe(base);
  });

  it("differs by play and by email", () => {
    expect(cadenceGoalId("show-hn", "p@x.dev")).not.toBe(cadenceGoalId("job-change", "p@x.dev"));
    expect(cadenceGoalId("show-hn", "p@x.dev")).not.toBe(cadenceGoalId("show-hn", "q@x.dev"));
  });
});

describe("outcomeToValueTag", () => {
  it("maps meeting_booked and sql_qualified to typed tags", () => {
    expect(outcomeToValueTag("meeting_booked")).toEqual({
      type: "meeting",
      label: "meeting booked",
    });
    expect(outcomeToValueTag("sql_qualified")).toEqual({
      type: "qualified",
      label: "SQL qualified",
    });
  });

  it("deal_won carries the revenue amount when finite", () => {
    expect(outcomeToValueTag("deal_won", 5000)).toEqual({
      type: "revenue",
      amount: 5000,
      label: "deal won",
    });
  });

  it("deal_won without a finite amount omits the amount", () => {
    expect(outcomeToValueTag("deal_won")).toEqual({ type: "revenue", label: "deal won" });
    expect(outcomeToValueTag("deal_won", Number.NaN)).toEqual({
      type: "revenue",
      label: "deal won",
    });
  });

  it("returns null for outcomes with no positive value", () => {
    expect(outcomeToValueTag("deal_lost", 100)).toBeNull();
    expect(outcomeToValueTag("ghosted")).toBeNull();
  });
});
