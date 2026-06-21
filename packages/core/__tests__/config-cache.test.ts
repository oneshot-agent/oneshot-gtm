import { beforeEach, describe, expect, it } from "vitest";
import { _resetConfigCacheForTests, loadConfigCached, saveConfig } from "../src/config.ts";

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
});
