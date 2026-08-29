import { describe, expect, it } from "vitest";
import type { OneShotConfig } from "@oneshot-gtm/core";
import { publicCfg } from "../src/api/setup.ts";

const FULL_CFG: OneShotConfig = {
  walletMode: "cdp",
  llmProvider: "openrouter",
  llmModel: "anthropic/claude-sonnet-4.6",
  telemetryEnabled: true,
  founderName: "Jane",
  founderEmail: "jane@acme.dev",
  productOneLiner: "x",
  productDomain: "acme.dev",
  sendingDomain: "mail.acme.dev",
  emailProvider: "oneshot",
  emailIdentities: [
    {
      id: "oneshot:jane@mail.acme.dev",
      provider: "oneshot",
      sendingDomain: "mail.acme.dev",
      mailbox: "jane",
      maxPerDay: 40,
      warmup: { startPerDay: 5, incrementPerWeek: 5 },
    },
  ],
  icpOneLiner: "y",
  cadenceOverrides: { "show-hn": [2, 5] },
  founderCredentials: "shipped two dev tools",
  productPortfolio: "acme-cli",
  partners: "Acme Corp",
  founderAdmission: "two people, no enterprise logos yet",
  productBrief: "docs at https://acme.dev/docs",
  mobileSignature: false,
  clientId: "11111111-2222-3333-4444-555555555555",
};

describe("publicCfg — privacy boundary", () => {
  it("drops the anonymous clientId from the response shape", () => {
    const view = publicCfg(FULL_CFG);
    expect("clientId" in view).toBe(false);
  });

  it("preserves every other field verbatim", () => {
    const view = publicCfg(FULL_CFG);
    expect(view.walletMode).toBe("cdp");
    expect(view.llmProvider).toBe("openrouter");
    expect(view.llmModel).toBe("anthropic/claude-sonnet-4.6");
    expect(view.telemetryEnabled).toBe(true);
    expect(view.founderName).toBe("Jane");
    expect(view.founderEmail).toBe("jane@acme.dev");
    expect(view.productOneLiner).toBe("x");
    expect(view.icpOneLiner).toBe("y");
    // Every remaining field, so a new OneShotConfig key can't silently vanish.
    const { clientId: _dropped, ...rest } = FULL_CFG;
    expect(view).toEqual(rest);
  });

  it("doesn't mutate the input", () => {
    const original = { ...FULL_CFG };
    publicCfg(FULL_CFG);
    expect(FULL_CFG).toEqual(original);
  });

  it("returns the same shape when clientId is already null", () => {
    const view = publicCfg({ ...FULL_CFG, clientId: null });
    expect("clientId" in view).toBe(false);
    expect(view.founderName).toBe("Jane");
  });
});
