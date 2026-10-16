import { describe, expect, it } from "vitest";
import { overlayOfferAngles } from "../src/trigger-overlay.ts";

// The active offer's angles become the draft's angle pool, in the row's own
// edge field, without touching anything else.

describe("overlayOfferAngles", () => {
  it("joins the offer's angles into the edge, as a multi-angle edge is", () => {
    const out = overlayOfferAngles({
      name: "Dana",
      yourEdge: "the trigger's argument",
      offer: { offer: "o", steps: "s", angles: ["first reason", " second reason "] },
    });
    expect(out["yourEdge"]).toBe("first reason // second reason");
    expect(out["name"]).toBe("Dana");
  });

  it("keeps a claim-shaped row's field name", () => {
    const out = overlayOfferAngles({ yourClaim: "x", offer: { angles: ["one", "two"] } });
    expect(out["yourClaim"]).toBe("one // two");
    expect(out["yourEdge"]).toBeUndefined();
  });

  it("leaves a row without offer angles as it is", () => {
    const row = { yourEdge: "edge", offer: { offer: "o", steps: "s" } };
    expect(overlayOfferAngles(row)).toBe(row);
    const bare = { yourEdge: "edge" };
    expect(overlayOfferAngles(bare)).toBe(bare);
  });

  it("drops an angle that would split into two", () => {
    const out = overlayOfferAngles({ offer: { angles: ["one // two", "three"] } });
    expect(out["yourEdge"]).toBe("three");
  });
});
