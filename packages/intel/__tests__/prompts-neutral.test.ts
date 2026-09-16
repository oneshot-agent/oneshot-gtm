import { describe, expect, it } from "vitest";
import { loadPrompt } from "../src/prompts.ts";

// The prompts every workspace shares must not carry one founder's product
// or ICP as a rule. Founder context is injected at runtime (the ICP
// one-liner, the product brief, the dossier); the shared text describes
// the mechanism only. Worked examples may name a hypothetical ICP, so the
// guard is on rule phrasing, not on the words "agent" or "founder".

const SHARED = ["icp-filter", "icp-filter-person", "reply-email", "voice-derive"];
const PRODUCT_RULES = [
  /taleb/i,
  /nclsjrry/i,
  /self-serve/i,
  /pay-per-use/i,
  /wire this up/i,
  /procurement step/i,
  /buy agent systems/i,
  /the product behind the icp/i,
  /the icp's product/i,
];

describe("shared prompts stay product-neutral", () => {
  for (const name of SHARED) {
    it(`${name} states no product- or workflow-specific rule`, () => {
      const body = loadPrompt(name);
      for (const rx of PRODUCT_RULES) expect(body).not.toMatch(rx);
    });
  }

  it("the person gate shows the same title flipping with the ICP", () => {
    const body = loadPrompt("icp-filter-person");
    expect(body).toMatch(/Head of Growth.*reject/s);
    expect(body).toMatch(/Head of Growth.*pass/s);
    expect(body).toMatch(/The ICP decides, not the title/);
  });
});
