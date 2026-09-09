import { describe, expect, it } from "vitest";
import { FREEMAIL_DOMAINS, isFreemailDomain } from "../src/freemail.ts";

describe("isFreemailDomain", () => {
  it("recognizes the common personal providers", () => {
    for (const d of ["gmail.com", "yahoo.com", "outlook.com", "icloud.com", "protonmail.com"]) {
      expect(isFreemailDomain(d)).toBe(true);
    }
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isFreemailDomain("  GMAIL.COM  ")).toBe(true);
  });

  it("is false for a company domain", () => {
    expect(isFreemailDomain("acme.com")).toBe(false);
  });

  it("is false for null/undefined/empty", () => {
    expect(isFreemailDomain(null)).toBe(false);
    expect(isFreemailDomain(undefined)).toBe(false);
    expect(isFreemailDomain("")).toBe(false);
  });

  it("the exported set is non-empty and lowercase", () => {
    expect(FREEMAIL_DOMAINS.size).toBeGreaterThan(5);
    for (const d of FREEMAIL_DOMAINS) expect(d).toBe(d.toLowerCase());
  });
});
