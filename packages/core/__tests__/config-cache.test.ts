import { beforeEach, describe, expect, it } from "vitest";
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  _resetConfigCacheForTests,
  configDir,
  loadConfigCached,
  saveConfig,
} from "../src/config.ts";

// ONESHOT_GTM_HOME is a fresh temp dir per test file (vitest.setup.ts).
beforeEach(() => _resetConfigCacheForTests());

describe("loadConfigCached", () => {
  it("memoizes — repeated calls return the same instance (no re-read)", () => {
    const a = loadConfigCached();
    const b = loadConfigCached();
    expect(b).toBe(a);
  });

  it("saveConfig busts the cache so the next read reflects the write", () => {
    const before = loadConfigCached();
    saveConfig({ ...before, llmProvider: "anthropic" });
    const after = loadConfigCached();
    expect(after).not.toBe(before);
    expect(after.llmProvider).toBe("anthropic");
  });

  // issue #71 round-6 review finding: slackWebhookUrl is a bearer credential
  // (whoever holds it can post to the operator's Slack channel) persisted in
  // config.json, which — unlike SECRETS_PATH/GMAIL_TOKENS_PATH — had no chmod
  // call anywhere, leaving it at the directory's default (world-readable) mode.
  it("saveConfig chmods config.json to owner-only (0600), matching the .env/secrets convention", () => {
    const before = loadConfigCached();
    saveConfig({ ...before, slackWebhookUrl: "https://hooks.slack.com/services/T0/B0/x" });
    const mode = statSync(join(configDir(), "config.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
