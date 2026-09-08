import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The card's acceptance requires a test that asserts the discovery-interview
 * prompt's link and price prohibitions rather than trusting the prompt text —
 * i.e. this must fail if a future edit to the .md file quietly drops one of
 * the hard bans, not just eyeball the prose once at review time.
 */
const here = dirname(fileURLToPath(import.meta.url));
const promptPath = join(here, "..", "..", "prompts", "discovery-interview-email.md");
const prompt = readFileSync(promptPath, "utf8").toLowerCase();

describe("discovery-interview-email.md — hard bans (drift guard)", () => {
  it("explicitly forbids a product link or website URL", () => {
    expect(prompt).toContain("product link or website url");
  });

  it("explicitly forbids a calendar link or scheduling tool", () => {
    expect(prompt).toContain("calendar link or scheduling tool");
  });

  it("explicitly forbids a price, dollar figure, or cost of any kind", () => {
    expect(prompt).toContain("price, dollar figure, or cost");
  });

  it("explicitly forbids discounts, credits, and free trials", () => {
    expect(prompt).toContain("discount, credit, free trial");
  });

  it("explicitly forbids pitching the product", () => {
    expect(prompt).toContain("any pitch");
  });

  it("explicitly forbids a meeting/call ask beyond the stated ten minutes", () => {
    expect(prompt).toContain("any meeting or call ask beyond the stated ten minutes");
  });

  it("names the hard-ban section as binding, no exceptions", () => {
    expect(prompt).toContain("hard bans (binding, no exceptions)");
  });
});
