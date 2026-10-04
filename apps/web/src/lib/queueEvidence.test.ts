import { describe, expect, it } from "vitest";
import { queueEvidence } from "./queueEvidence.ts";

describe("queueEvidence for design-partner-loi", () => {
  it("names the buyer, led by the list a list-page row came from", () => {
    expect(
      queueEvidence("design-partner-loi", {
        buyerType: "enterprise",
        company: "Acme",
        signal: "runs Backstage",
      }),
    ).toBe("runs Backstage · enterprise buyer at Acme");
    expect(queueEvidence("design-partner-loi", { buyerType: "enterprise", company: "Acme" })).toBe(
      "enterprise buyer at Acme",
    );
  });

  it("marks a checked signal confirmed or unconfirmed", () => {
    const row = { buyerType: "enterprise", company: "Acme", signal: "uses Browserbase" };
    expect(queueEvidence("design-partner-loi", { ...row, signalVerified: "confirmed" })).toBe(
      "uses Browserbase ✓ · enterprise buyer at Acme",
    );
    expect(queueEvidence("design-partner-loi", { ...row, signalVerified: "unconfirmed" })).toBe(
      "uses Browserbase (unconfirmed) · enterprise buyer at Acme",
    );
  });
});
