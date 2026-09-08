import { describe, expect, it } from "vitest";
import { automaticMailEligible, mailFollowupDueAt, motionMailPolicy } from "../src/mail-policy.ts";
const prospect = {
  name: "Jane",
  company: "Acme",
  businessAddress: {
    name: "Jane",
    address_line1: "1 Main St",
    address_city: "Boston",
    address_state: "MA",
    address_zip: "02110",
    address_country: "US",
  },
};
describe("motion mail defaults", () => {
  it("inherits selective defaults and preserves explicit off and legacy opt-ins", () => {
    expect(motionMailPolicy({}, "new-business").settings?.mode).toBe("automatic");
    expect(motionMailPolicy({}, "demo-no-show").settings).toBeNull();
    expect(
      motionMailPolicy({ directMailMotions: { "new-business": null } }, "new-business").settings,
    ).toBeNull();
    expect(
      motionMailPolicy(
        { directMailMotions: { "new-business": { position: 3, delayDays: 6 } } },
        "new-business",
      ).settings,
    ).toEqual({ position: 3, delayDays: 6 });
  });
  it("requires business address and buyer fit", () => {
    expect(automaticMailEligible("new-business", prospect)).toBe(true);
    expect(automaticMailEligible("free-pilot", { ...prospect, businessAddress: null })).toBe(false);
    expect(
      automaticMailEligible("new-business", {
        ...prospect,
        businessAddressSource: "registered agent",
      }),
    ).toBe(false);
    expect(
      automaticMailEligible("design-partner-loi", { ...prospect, buyerType: "government" }),
    ).toBe(false);
    expect(
      automaticMailEligible("design-partner-loi", { ...prospect, buyerType: "hardware" }),
    ).toBe(true);
    expect(automaticMailEligible("post-funding", prospect)).toBe(false);
    expect(
      automaticMailEligible("post-funding", { ...prospect, icp_verdict: "pass", title: "CEO" }),
    ).toBe(true);
    expect(
      automaticMailEligible("post-funding", { ...prospect, icp_verdict: "unclear", title: "CEO" }),
    ).toBe(false);
  });
  it("allows printing and transit across weekends and preserves longer delays", () => {
    const friday = new Date("2026-09-04T12:00:00Z");
    expect(mailFollowupDueAt(3, friday)).toBe("2026-09-18T12:00:00.000Z");
    expect(mailFollowupDueAt(30, friday)).toBe("2026-10-04T12:00:00.000Z");
  });
});
