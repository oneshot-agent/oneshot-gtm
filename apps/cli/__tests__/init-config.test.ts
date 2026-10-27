import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OneShotConfig } from "@oneshot-gtm/core";
import { DEV_CLI_ENTRY, mergeInitConfig, whichCommand } from "../src/commands/init.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

describe("whichCommand", () => {
  const argv1 = process.argv[1] as string;
  afterEach(() => {
    process.argv[1] = argv1;
  });

  it("suggests a checkout command whose entry file exists from the repo root", () => {
    // The hint is meant to be copy-pasted. A hardcoded path rots silently
    // (#931 shipped `packages/cli/src/index.ts`, which never existed).
    process.argv[1] = resolve(REPO_ROOT, DEV_CLI_ENTRY);
    const cmd = whichCommand(REPO_ROOT);
    expect(cmd).toBe(`bun run ${DEV_CLI_ENTRY}`);
    const entry = cmd.split(" ").at(-1) as string;
    expect(existsSync(resolve(REPO_ROOT, entry))).toBe(true);
  });

  it("names the entry file relative to the directory init was run from", () => {
    // `bun run src/main.ts init` from apps/cli must not be told to run
    // apps/cli/src/main.ts, which does not resolve from there.
    const cwd = resolve(REPO_ROOT, "apps/cli");
    process.argv[1] = resolve(REPO_ROOT, DEV_CLI_ENTRY);
    const cmd = whichCommand(cwd);
    expect(cmd).toBe("bun run src/main.ts");
    expect(existsSync(resolve(cwd, cmd.split(" ").at(-1) as string))).toBe(true);
  });

  it("shell-quotes an entry path that contains a space", () => {
    // Unquoted, `bun run one shot/apps/cli/src/main.ts doctor` hands the shell `one`
    // as the script and the rest as its arguments.
    process.argv[1] = "/tmp/one shot/apps/cli/src/main.ts";
    expect(whichCommand("/tmp")).toBe("bun run 'one shot/apps/cli/src/main.ts'");
  });

  it("falls back to the repo-root entry when argv carries no script path", () => {
    process.argv[1] = "";
    expect(whichCommand(REPO_ROOT)).toBe(`bun run ${DEV_CLI_ENTRY}`);
  });

  it("suggests the linked bin name when invoked through it", () => {
    process.argv[1] = "/usr/local/bin/oneshot-gtm";
    expect(whichCommand()).toBe("oneshot-gtm");
  });
});

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
  slackWebhookUrl: null,
  dailySpendCeilingUsd: null,
  calendarIdentityId: null,
  calendarId: "primary",
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

  it("normalizes an explicitly cleared optional field to null, not an empty string", () => {
    const withIcp = { ...current, icpOneLiner: "Series A infra founders" } satisfies OneShotConfig;

    const next = mergeInitConfig(withIcp, { icpOneLiner: "" });

    expect(next.icpOneLiner).toBeNull();
    expect(next.icpOneLiner).not.toBe("");
  });

  it("leaves an optional field untouched when the wizard answer key is omitted entirely", () => {
    const withIcp = { ...current, icpOneLiner: "Series A infra founders" } satisfies OneShotConfig;

    const next = mergeInitConfig(withIcp, { founderName: "New Name" });

    expect(next.icpOneLiner).toBe("Series A infra founders");
  });
});
