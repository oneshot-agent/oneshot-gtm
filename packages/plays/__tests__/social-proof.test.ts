import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let cfgOverride: {
  founderCredentials: string | null;
  productPortfolio: string | null;
  partners: string | null;
} = { founderCredentials: null, productPortfolio: null, partners: null };

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({
      walletMode: "cdp",
      llmProvider: "anthropic",
      llmModel: "x",
      telemetryEnabled: false,
      founderName: "J",
      founderEmail: null,
      productOneLiner: "thing",
      productDomain: null,
      sendingDomain: null,
      icpOneLiner: null,
      cadenceOverrides: null,
      founderCredentials: cfgOverride.founderCredentials,
      productPortfolio: cfgOverride.productPortfolio,
      partners: cfgOverride.partners,
      mobileSignature: false,
      clientId: null,
    }),
  };
});

const { socialProofBlock } = await import("../src/_lib.ts");

beforeEach(() => {
  cfgOverride = { founderCredentials: null, productPortfolio: null, partners: null };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("socialProofBlock", () => {
  it("returns null when all three fields are blank", () => {
    expect(socialProofBlock()).toBeNull();
  });

  it("returns null when fields contain only whitespace", () => {
    cfgOverride.founderCredentials = "   ";
    cfgOverride.productPortfolio = "\n  \n";
    expect(socialProofBlock()).toBeNull();
  });

  it("emits only the lines whose fields are set; leading directive mentions all three beats", () => {
    cfgOverride.founderCredentials = "ex-Stripe payments";
    const out = socialProofBlock();
    expect(out).not.toBeNull();
    expect(out).toContain("SOCIAL PROOF");
    expect(out).toContain("CREDENTIALS");
    expect(out).toContain("PORTFOLIO");
    expect(out).toContain("PARTNERS");
    expect(out).toContain("CREDENTIALS: ex-Stripe payments");
    expect(out).not.toContain("PORTFOLIO:");
    expect(out).not.toMatch(/PARTNERS:\s+\w/);
  });

  it("emits all three beats when all three are set, in CREDENTIALS / PORTFOLIO / PARTNERS order", () => {
    cfgOverride.founderCredentials = "founder cred";
    cfgOverride.productPortfolio = "product list";
    cfgOverride.partners = "partner list";
    const out = socialProofBlock();
    expect(out).not.toBeNull();
    const credIdx = out!.indexOf("CREDENTIALS:");
    const portIdx = out!.indexOf("PORTFOLIO:");
    const partIdx = out!.indexOf("PARTNERS:");
    expect(credIdx).toBeGreaterThan(-1);
    expect(portIdx).toBeGreaterThan(credIdx);
    expect(partIdx).toBeGreaterThan(portIdx);
  });

  it("doesn't leak OneShot-specific copy in the directive (platform-generic)", () => {
    cfgOverride.productPortfolio = "p";
    const out = socialProofBlock();
    expect(out).not.toMatch(/oneshot/i);
  });
});
