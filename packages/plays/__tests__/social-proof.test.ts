import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let cfgOverride: {
  founderCredentials: string | null;
  productPortfolio: string | null;
  partners: string | null;
  founderAdmission: string | null;
} = { founderCredentials: null, productPortfolio: null, partners: null, founderAdmission: null };

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
      founderAdmission: cfgOverride.founderAdmission,
      mobileSignature: false,
      clientId: null,
    }),
  };
});

const { socialProofBlock } = await import("../src/_lib.ts");

beforeEach(() => {
  cfgOverride = { founderCredentials: null, productPortfolio: null, partners: null, founderAdmission: null };
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

// An address that draws the admission slot, found by probing admissionSlot —
// pinned so the assertions below don't depend on the hash's distribution.
async function slotted(): Promise<string> {
  const { admissionSlot } = await import("../src/_lib.ts");
  for (let i = 0; i < 50; i++) {
    const email = `p${i}@example.com`;
    if (admissionSlot(email)) return email;
  }
  throw new Error("no slotted address in 50 tries");
}

describe("admissionBlock — the damaging-admission beat's only source of material", () => {
  it("is null when no concession is configured, so the prompt skips the beat", async () => {
    const { admissionBlock } = await import("../src/_lib.ts");
    const email = await slotted();
    cfgOverride.founderAdmission = null;
    expect(admissionBlock(email)).toBeNull();
    cfgOverride.founderAdmission = "   ";
    expect(admissionBlock(email)).toBeNull();
  });

  it("carries the configured concession under an ADMISSION label, scoped to the Identity beat", async () => {
    const { admissionBlock } = await import("../src/_lib.ts");
    cfgOverride.founderAdmission = "two people, no enterprise logos yet";
    const out = admissionBlock(await slotted());
    expect(out).toMatch(/^ADMISSION \(/);
    expect(out).toContain("THIS email");
    expect(out).toContain("Identity beat");
    expect(out).toContain("never extended");
    expect(out).toMatch(/: two people, no enterprise logos yet$/);
  });

  it("gates the material per prospect: roughly a third draw it, deterministically", async () => {
    // The frequency cap lives in code because the model can't hold one — given
    // "at most 1 in 3" it used the admission on 3 of 4 drafts.
    const { admissionBlock, admissionSlot } = await import("../src/_lib.ts");
    cfgOverride.founderAdmission = "two people, no enterprise logos yet";
    const emails = Array.from({ length: 300 }, (_, i) => `person${i}@corp${i % 17}.io`);
    const drawn = emails.filter((e) => admissionBlock(e) != null).length;
    expect(drawn).toBeGreaterThan(300 * 0.25);
    expect(drawn).toBeLessThan(300 * 0.42);
    // Stable: a regenerate for the same prospect makes the same decision, and
    // the decision ignores case/whitespace in the address.
    for (const e of emails.slice(0, 20)) {
      expect(admissionSlot(e)).toBe(admissionSlot(`  ${e.toUpperCase()} `));
    }
  });
});
