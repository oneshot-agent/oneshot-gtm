import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_LINKEDIN_TEMPLATES } from "@oneshot-gtm/shared-types";
import { loadPrompt } from "../src/prompts.ts";

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");
const promptFiles = readdirSync(promptsDir).filter((f) => f.endsWith(".md"));

// The prompts every workspace shares must not carry one founder's product
// or ICP as a rule. Founder context is injected at runtime (the ICP
// one-liner, the product brief, the dossier); the shared text describes
// the mechanism only. Worked examples may name a hypothetical ICP, so the
// guard is on rule phrasing, not on the words "agent" or "founder".

const SHARED = [
  "icp-filter",
  "icp-filter-person",
  "reply-email",
  "voice-derive",
  "profile-intro-email",
  "profile-extract",
];
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

// The project is open source: no prompt carries one founder's product,
// numbers or past incidents. These are strings that once did.
const FOUNDER_SPECIFIC = [
  /freebot/i,
  /\$10\.2m/i,
  /oneshot(?!-gtm)/i,
  /soulhunt/i,
  /send, call, book/i,
  /signed receipts/i,
  /on-chain receipts/i,
  /retry polic/i,
  /ten million calls/i,
  /experimentation platform/i,
  /your playwright/i,
  /your apollo bill/i,
];

describe("no prompt carries one founder's product", () => {
  for (const file of promptFiles) {
    it(`${file} names nothing founder-specific`, () => {
      const body = readFileSync(join(promptsDir, file), "utf8");
      for (const rx of FOUNDER_SPECIFIC) expect(body, `${file} matches ${rx}`).not.toMatch(rx);
    });
  }
});

describe("the shipped LinkedIn templates carry no founder's product", () => {
  for (const [step, text] of Object.entries(DEFAULT_LINKEDIN_TEMPLATES)) {
    it(`${step} names nothing founder-specific`, () => {
      for (const rx of FOUNDER_SPECIFIC) expect(text, `${step} matches ${rx}`).not.toMatch(rx);
    });
  }
});

describe("outreach prompts open with the offer when they have one", () => {
  const outreach = promptFiles
    .map((f) => f.replace(/\.md$/, ""))
    .filter((name) =>
      readFileSync(join(promptsDir, `${name}.md`), "utf8").includes("[See _offer-first.md"),
    );

  it("finds the outreach prompts", () => {
    expect(outreach.length).toBeGreaterThan(20);
  });

  for (const name of outreach) {
    it(`${name} inlines the offer-first rules`, () => {
      const body = loadPrompt(name);
      expect(body).toContain("# Offer first (binding whenever the input has an OFFER line)");
      expect(body).not.toContain("[See _offer-first.md");
    });
  }
});
