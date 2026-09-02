import { describe, expect, it } from "vitest";
import type { OneShotConfig } from "@oneshot-gtm/core";
import { mergeInitConfig } from "../src/commands/init.ts";

const current = {
  walletMode: "cdp",
  llmProvider: "openrouter",
  llmModel: "old-model",
  telemetryEnabled: true,
  founderName: "Old Name",
  founderEmail: "old@example.com",
  productOneLiner: "Old product description",
  productDomain: null,
  sendingDomain: null,
  emailProvider: "oneshot",
  emailIdentities: null,
  icpOneLiner: null,
  cadenceOverrides: { "repo-interest": [4, 9] },
  queueReviewOrder: "ranked",
  founderCredentials: null,
  productPortfolio: null,
  partners: null,
  founderAdmission: null,
  productBrief: "Keep this brief",
  mobileSignature: true,
  timezone: "Europe/Vienna",
  clientId: "client-1",
} satisfies OneShotConfig;

describe("init config writer", () => {
  it("overlays wizard answers without wiping config fields outside the wizard", () => {
    const next = mergeInitConfig(current, { founderName: "New Name", llmModel: "new-model" });

    expect(next).toMatchObject({
      founderName: "New Name",
      llmModel: "new-model",
      cadenceOverrides: { "repo-interest": [4, 9] },
      queueReviewOrder: "ranked",
      productBrief: "Keep this brief",
      mobileSignature: true,
      timezone: "Europe/Vienna",
      clientId: "client-1",
    });
  });
});
