import { describe, expect, it } from "vitest";
import { offerFromPayload } from "../ProspectOffer.tsx";

describe("offerFromPayload", () => {
  it("reads the stored offer", () => {
    expect(
      offerFromPayload({
        offer: {
          offer: "do x",
          steps: "a, b",
          evidence: ["q"],
          stage: "s",
          level: "role",
          editedBy: "founder",
        },
      }),
    ).toEqual({
      offer: "do x",
      steps: "a, b",
      evidence: ["q"],
      stage: "s",
      level: "role",
      editedBy: "founder",
    });
  });
  it("is null without one", () => {
    expect(offerFromPayload({})).toBeNull();
    expect(offerFromPayload({ offer: { offer: " " } })).toBeNull();
    expect(offerFromPayload(null)).toBeNull();
  });
});
