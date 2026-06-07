import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let cfgOverride: {
  founderName: string | null;
  productDomain: string | null;
  mobileSignature: boolean;
} = { founderName: "Jane Doe", productDomain: "example.com", mobileSignature: false };

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      walletMode: "cdp",
      llmProvider: "anthropic",
      llmModel: "x",
      telemetryEnabled: false,
      founderName: cfgOverride.founderName,
      founderEmail: null,
      productOneLiner: "thing",
      productDomain: cfgOverride.productDomain,
      sendingDomain: null,
      icpOneLiner: null,
      cadenceOverrides: null,
      founderCredentials: null,
      productPortfolio: null,
      partners: null,
      mobileSignature: cfgOverride.mobileSignature,
      clientId: null,
    }),
  };
});

const { signatureDirective } = await import("../src/_lib.ts");

beforeEach(() => {
  cfgOverride = { founderName: "Jane Doe", productDomain: "example.com", mobileSignature: false };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("signatureDirective — mobile sig", () => {
  it("two-line signature when mobileSignature is false", () => {
    const out = signatureDirective();
    expect(out).toContain("Jane Doe");
    expect(out).toContain("example.com");
    expect(out).not.toContain("Sent from my iPhone");
  });

  it("three-line signature when mobileSignature is true", () => {
    cfgOverride.mobileSignature = true;
    const out = signatureDirective();
    expect(out).toContain("Jane Doe");
    expect(out).toContain("example.com");
    expect(out).toContain("Sent from my iPhone");
    // Mobile sig instruction line replaces the two-line instruction.
    expect(out).toContain("Three lines total");
    // The three sig lines land in order: name, domain, mobile.
    // (Used lastIndexOf because "Sent from my iPhone" also appears in the
    // instruction header above the sig block.)
    const nameIdx = out.lastIndexOf("Jane Doe");
    const domainIdx = out.lastIndexOf("example.com");
    const mobileIdx = out.lastIndexOf("Sent from my iPhone");
    expect(nameIdx).toBeLessThan(domainIdx);
    expect(domainIdx).toBeLessThan(mobileIdx);
  });

  it("empty string when productDomain is null (no signature at all)", () => {
    cfgOverride.productDomain = null;
    expect(signatureDirective()).toBe("");
  });

  it("mobileSignature only kicks in when productDomain is also set", () => {
    cfgOverride.productDomain = null;
    cfgOverride.mobileSignature = true;
    expect(signatureDirective()).toBe("");
  });
});
