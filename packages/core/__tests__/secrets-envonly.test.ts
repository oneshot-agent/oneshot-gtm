import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { saveSecrets, secretsPath } from "@oneshot-gtm/core";

describe("saveSecrets", () => {
  it("preserves env-only keys through an unrelated save", () => {
    writeFileSync(secretsPath(), "GITHUB_TOKEN=ghp_keepme\nLUMA_SESSION_COOKIE=luma_keepme\n");
    saveSecrets({ OPENROUTER_API_KEY: "sk-or-new" });
    const after = readFileSync(secretsPath(), "utf8");
    expect(after).toContain("GITHUB_TOKEN=ghp_keepme");
    expect(after).toContain("LUMA_SESSION_COOKIE=luma_keepme");
    expect(after).toContain("OPENROUTER_API_KEY=sk-or-new");
  });

  it("writes env-only X keys (the /setup card path) and they survive a later unrelated save", () => {
    writeFileSync(secretsPath(), "");
    saveSecrets({
      X_API_KEY: "ck",
      X_API_SECRET: "cs",
      X_ACCESS_TOKEN: "at",
      X_ACCESS_SECRET: "ats",
      TWITTERAPI_IO_KEY: "tio",
    });
    saveSecrets({ OPENROUTER_API_KEY: "sk-or-later" });
    const after = readFileSync(secretsPath(), "utf8");
    expect(after).toContain("X_API_KEY=ck");
    expect(after).toContain("X_ACCESS_SECRET=ats");
    expect(after).toContain("TWITTERAPI_IO_KEY=tio");
    expect(after).toContain("OPENROUTER_API_KEY=sk-or-later");
  });
});
