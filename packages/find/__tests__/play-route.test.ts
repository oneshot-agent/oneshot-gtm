import { describe, expect, it } from "vitest";
import {
  buildDesignPartnerLoiPayload,
  checkPlayRouteReadiness,
  dedupePlayNames,
  resolvePlayRoute,
} from "../src/_play-route.ts";

describe("resolvePlayRoute", () => {
  it("returns null when `play` is absent — today's behaviour, unchanged", () => {
    expect(resolvePlayRoute({})).toBeNull();
    expect(resolvePlayRoute({ buyerType: "enterprise" })).toBeNull();
  });

  it("returns null when `play` is set to something other than design-partner-loi", () => {
    expect(resolvePlayRoute({ play: "sources-sought", buyerType: "enterprise" })).toBeNull();
  });

  it("resolves to design-partner-loi with a normalized buyerType when both keys are valid", () => {
    expect(resolvePlayRoute({ play: "design-partner-loi", buyerType: "enterprise" })).toEqual({
      playName: "design-partner-loi",
      buyerType: "enterprise",
    });
    // Normalized the same way the play's own allowlist normalizes it.
    expect(resolvePlayRoute({ play: "design-partner-loi", buyerType: " Government " })).toEqual({
      playName: "design-partner-loi",
      buyerType: "government",
    });
  });

  it("returns null when play is set but buyerType is missing or invalid", () => {
    expect(resolvePlayRoute({ play: "design-partner-loi" })).toBeNull();
    expect(resolvePlayRoute({ play: "design-partner-loi", buyerType: 5 })).toBeNull();
    expect(
      resolvePlayRoute({ play: "design-partner-loi", buyerType: "owner-operator" }),
    ).toBeNull();
  });
});

describe("checkPlayRouteReadiness", () => {
  it("returns null (no additional restriction) when play isn't design-partner-loi", () => {
    expect(checkPlayRouteReadiness({}, "yourEdge")).toBeNull();
    expect(checkPlayRouteReadiness({ play: "other" }, "yourEdge")).toBeNull();
  });

  it("requires the named edge field when play is design-partner-loi", () => {
    const out = checkPlayRouteReadiness({ play: "design-partner-loi" }, "yourEdge");
    expect(out).not.toBeNull();
    expect(out?.ready).toBe(false);
    if (out && !out.ready) expect(out.reason).toMatch(/yourEdge/);
  });

  it("requires a valid buyerType once the edge field is set", () => {
    const out = checkPlayRouteReadiness(
      { play: "design-partner-loi", yourEdge: "we cut integration time" },
      "yourEdge",
    );
    expect(out?.ready).toBe(false);
    if (out && !out.ready) expect(out.reason).toMatch(/buyerType/);
  });

  it("rejects an invalid buyerType value even with the edge field set", () => {
    const out = checkPlayRouteReadiness(
      {
        play: "design-partner-loi",
        yourEdge: "we cut integration time",
        buyerType: "owner-operator",
      },
      "yourEdge",
    );
    expect(out?.ready).toBe(false);
  });

  it("becomes ready with a valid edge + buyerType", () => {
    const out = checkPlayRouteReadiness(
      { play: "design-partner-loi", yourEdge: "we cut integration time", buyerType: "enterprise" },
      "yourEdge",
    );
    expect(out).toEqual({ ready: true });
  });

  it("reads the caller-named edge key, e.g. yourClaim for hiring-signal", () => {
    const out = checkPlayRouteReadiness(
      { play: "design-partner-loi", yourClaim: "we cut ramp time", buyerType: "government" },
      "yourClaim",
    );
    expect(out).toEqual({ ready: true });
  });
});

describe("dedupePlayNames", () => {
  it("includes the finder's own play and design-partner-loi, deduped", () => {
    expect(dedupePlayNames("hiring-signal")).toEqual(["hiring-signal", "design-partner-loi"]);
  });

  it("does not duplicate design-partner-loi when the finder's own play IS design-partner-loi", () => {
    expect(dedupePlayNames("design-partner-loi")).toEqual(["design-partner-loi"]);
  });
});

describe("buildDesignPartnerLoiPayload", () => {
  it("builds the required fields and omits optionals when absent", () => {
    const payload = buildDesignPartnerLoiPayload({
      name: "Jamie Buyer",
      email: "jamie@enterprise-corp.com",
      company: "Enterprise Corp",
      buyerType: "enterprise",
      yourEdge: "our harness matches their checklist",
    });
    expect(payload).toEqual({
      name: "Jamie Buyer",
      email: "jamie@enterprise-corp.com",
      company: "Enterprise Corp",
      buyerType: "enterprise",
      yourEdge: "our harness matches their checklist",
    });
  });

  it("includes title/linkedinUrl/phone only when truthy", () => {
    const payload = buildDesignPartnerLoiPayload({
      name: "Jamie Buyer",
      email: "jamie@enterprise-corp.com",
      company: "Enterprise Corp",
      buyerType: "government",
      yourEdge: "edge",
      title: "Head of AI Platform",
      linkedinUrl: "https://linkedin.com/in/jamie",
      phone: null,
    });
    expect(payload["title"]).toBe("Head of AI Platform");
    expect(payload["linkedinUrl"]).toBe("https://linkedin.com/in/jamie");
    expect(payload).not.toHaveProperty("phone");
  });

  it("spreads the icp verdict fields onto the payload when provided (finding PRRT_kwDOSKzrBs6mB74J)", () => {
    const payload = buildDesignPartnerLoiPayload({
      name: "Jamie Buyer",
      email: "jamie@enterprise-corp.com",
      company: "Enterprise Corp",
      buyerType: "enterprise",
      yourEdge: "edge",
      icp: { icpVerdict: "pass", icpVerdictReason: "matches ICP: enterprise buyer" },
    });
    expect(payload["icpVerdict"]).toBe("pass");
    expect(payload["icpVerdictReason"]).toBe("matches ICP: enterprise buyer");
  });

  it("omits icp verdict fields when icp is absent — matches every payload shape before this option existed", () => {
    const payload = buildDesignPartnerLoiPayload({
      name: "Jamie Buyer",
      email: "jamie@enterprise-corp.com",
      company: "Enterprise Corp",
      buyerType: "enterprise",
      yourEdge: "edge",
    });
    expect(payload).not.toHaveProperty("icpVerdict");
    expect(payload).not.toHaveProperty("icpVerdictReason");
  });
});
