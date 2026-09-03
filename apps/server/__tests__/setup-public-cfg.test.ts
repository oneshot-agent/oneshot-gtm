import { describe, expect, it } from "vitest";
import type { OneShotConfig } from "@oneshot-gtm/core";
import { mergeSetupConfig, publicCfg } from "../src/api/setup.ts";

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
  queueReviewOrder: "ranked",
  founderCredentials: "shipped two dev tools",
  productPortfolio: "acme-cli",
  partners: "Acme Corp",
  founderAdmission: "two people, no enterprise logos yet",
  productBrief: "docs at https://acme.dev/docs",
  mobileSignature: false,
  timezone: "Europe/Vienna",
  clientId: "11111111-2222-3333-4444-555555555555",
  dailySpendCeilingUsd: null,
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
    const original = structuredClone(FULL_CFG);
    publicCfg(FULL_CFG);
    expect(FULL_CFG).toEqual(original);
  });

  it("returns the same shape when clientId is already null", () => {
    const view = publicCfg({ ...FULL_CFG, clientId: null });
    expect("clientId" in view).toBe(false);
    expect(view.founderName).toBe("Jane");
  });
});

describe("setup config writer", () => {
  it("overlays submitted fields without wiping fields outside the form", () => {
    const next = mergeSetupConfig(FULL_CFG, { founderName: "Janet" }, FULL_CFG.emailIdentities);

    expect(next.founderName).toBe("Janet");
    expect(next.queueReviewOrder).toBe("ranked");
    expect(next.timezone).toBe("Europe/Vienna");
    expect(next.cadenceOverrides).toEqual({ "show-hn": [2, 5] });
  });

  // Round-1 review finding: the CLI path (configSpendCeiling) validates the
  // ceiling must be a finite positive number, but this API path accepted
  // body.dailySpendCeilingUsd verbatim. A ceiling of 0 makes
  // effectiveUsd (0) >= ceilingUsd (0) true immediately, silently halting
  // every automated finder/drain install-wide.
  describe("dailySpendCeilingUsd validation", () => {
    it("undefined leaves the existing ceiling untouched", () => {
      const next = mergeSetupConfig(
        { ...FULL_CFG, dailySpendCeilingUsd: 25 },
        {},
        FULL_CFG.emailIdentities,
      );
      expect(next.dailySpendCeilingUsd).toBe(25);
    });

    it("null clears the ceiling back to unlimited", () => {
      const next = mergeSetupConfig(
        { ...FULL_CFG, dailySpendCeilingUsd: 25 },
        { dailySpendCeilingUsd: null },
        FULL_CFG.emailIdentities,
      );
      expect(next.dailySpendCeilingUsd).toBeNull();
    });

    it("accepts a positive finite number", () => {
      const next = mergeSetupConfig(
        FULL_CFG,
        { dailySpendCeilingUsd: 12.5 },
        FULL_CFG.emailIdentities,
      );
      expect(next.dailySpendCeilingUsd).toBe(12.5);
    });

    it("rejects 0 — would halt every automated path immediately", () => {
      expect(() =>
        mergeSetupConfig(FULL_CFG, { dailySpendCeilingUsd: 0 }, FULL_CFG.emailIdentities),
      ).toThrow(/invalid dailySpendCeilingUsd/);
    });

    it("rejects a negative number", () => {
      expect(() =>
        mergeSetupConfig(FULL_CFG, { dailySpendCeilingUsd: -5 }, FULL_CFG.emailIdentities),
      ).toThrow(/invalid dailySpendCeilingUsd/);
    });

    it("rejects NaN and Infinity (a raw JSON body can smuggle these via JSON.parse edge cases)", () => {
      expect(() =>
        mergeSetupConfig(FULL_CFG, { dailySpendCeilingUsd: Number.NaN }, FULL_CFG.emailIdentities),
      ).toThrow(/invalid dailySpendCeilingUsd/);
      expect(() =>
        mergeSetupConfig(
          FULL_CFG,
          { dailySpendCeilingUsd: Number.POSITIVE_INFINITY },
          FULL_CFG.emailIdentities,
        ),
      ).toThrow(/invalid dailySpendCeilingUsd/);
    });
  });
});
