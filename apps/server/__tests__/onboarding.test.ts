import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OneShotConfig } from "@oneshot-gtm/core";
import { normalizeWebsite } from "@oneshot-gtm/shared-types";
let home: string;
let cfg: OneShotConfig;
let demo = false;
const complete = vi.fn();
vi.mock("@oneshot-gtm/core", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core")),
  configDir: () => home,
  loadConfig: () => cfg,
  demoMode: () => demo,
}));
vi.mock("@oneshot-gtm/intel", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel")),
  complete,
}));
const { onboardingStatus, verifyOnboardingAI, deferOnboarding, invalidateOnboardingAI } =
  await import("../src/api/onboarding.ts");
const req = () => new Request("http://localhost/api/onboarding");
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "onboarding-"));
  cfg = {
    founderName: null,
    productDomain: null,
    productOneLiner: null,
    icpOneLiner: null,
    llmProvider: "openrouter",
    llmModel: "anthropic/claude-sonnet-4.6",
    walletMode: "cdp",
  } as OneShotConfig;
  demo = false;
  for (const key of [
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "AGENT_PRIVATE_KEY",
    "CDP_API_KEY_ID",
    "SMARTLEAD_API_KEY",
    "GMAIL_REFRESH_TOKEN",
  ])
    vi.stubEnv(key, "");
  complete.mockReset().mockResolvedValue({ content: "OK" });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function business() {
  Object.assign(cfg, {
    founderName: "Founder",
    productDomain: "example.com",
    productOneLiner: "Bookkeeping for restaurants",
    icpOneLiner: "Restaurant owners",
  });
}
describe("workspace onboarding", () => {
  it("opens untouched workspaces and resumes the first missing requirement", () => {
    expect(onboardingStatus()).toMatchObject({ autoOpen: true, nextStep: 1, ready: false });
    cfg.founderName = "  ";
    expect(onboardingStatus().missing).toContain("Founder name");
    business();
    cfg.icpOneLiner = " ";
    expect(onboardingStatus()).toMatchObject({ autoOpen: false, nextStep: 2 });
    cfg.icpOneLiner = "Owners";
    expect(onboardingStatus().nextStep).toBe(3);
  });
  it("persists defer privately and isolates workspaces", async () => {
    await deferOnboarding(req());
    expect(onboardingStatus().autoOpen).toBe(false);
    expect(statSync(join(home, "onboarding.json")).mode & 0o777).toBe(0o600);
    const original = home;
    home = mkdtempSync(join(tmpdir(), "onboarding-other-"));
    expect(onboardingStatus().autoOpen).toBe(true);
    rmSync(home, { recursive: true });
    home = original;
    expect(onboardingStatus().deferred).toBe(true);
  });
  it("excludes demo and existing configured workspaces from automatic opening", () => {
    demo = true;
    expect(onboardingStatus().autoOpen).toBe(false);
    demo = false;
    cfg.founderEmail = "founder@example.com";
    expect(onboardingStatus().autoOpen).toBe(false);
  });
  it("verifies an environment key without a wallet or sender and never exposes its fingerprint", async () => {
    business();
    vi.stubEnv("OPENROUTER_API_KEY", "private-test-key");
    const result = await verifyOnboardingAI(req());
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ ready: true, aiVerified: true });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ maxAttempts: 1, timeoutMs: 20_000, maxTokens: 32 }),
    );
    expect(JSON.stringify(onboardingStatus())).not.toMatch(/private-test-key|fingerprint/);
    expect(readFileSync(join(home, "onboarding.json"), "utf8")).not.toContain("private-test-key");
    cfg.llmModel = "changed";
    expect(onboardingStatus().aiVerified).toBe(false);
  });
  it.each(["key", "provider", "model"])("invalidates when effective %s changes", async (field) => {
    vi.stubEnv("OPENROUTER_API_KEY", "key");
    await verifyOnboardingAI(req());
    if (field === "key") vi.stubEnv("OPENROUTER_API_KEY", "new");
    if (field === "provider") cfg.llmProvider = "openai";
    if (field === "model") cfg.llmModel = "other";
    expect(onboardingStatus().aiVerified).toBe(false);
  });
  it("rejects results after settings change, even if changed back", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "key");
    let resolve!: (value: unknown) => void;
    complete.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = verifyOnboardingAI(req());
    invalidateOnboardingAI();
    resolve({ content: "OK" });
    expect((await pending).status).toBe(409);
    expect(onboardingStatus().aiVerified).toBe(false);
  });
  it.each([{ status: 401 }, { status: 404 }, { status: 429 }, { name: "LlmTimeoutError" }])(
    "returns safe actionable failures: %j",
    async (error) => {
      vi.stubEnv("OPENROUTER_API_KEY", "secret");
      complete.mockRejectedValue({ ...error, message: "leaked secret" });
      const result = await verifyOnboardingAI(req());
      expect(result.status).toBe(502);
      expect(await result.text()).not.toContain("secret");
      expect(onboardingStatus().aiVerified).toBe(false);
    },
  );
  it("never writes or calls a provider in the read-only demo", async () => {
    demo = true;
    expect((await verifyOnboardingAI(req())).status).toBe(403);
    expect((await deferOnboarding(req())).status).toBe(403);
    expect(complete).not.toHaveBeenCalled();
  });
  it("rejects a late result for a different effective model", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "key");
    complete.mockImplementation(async () => {
      cfg.llmModel = "new-model";
      return { content: "OK" };
    });
    expect((await verifyOnboardingAI(req())).status).toBe(409);
    expect(onboardingStatus().aiVerified).toBe(false);
  });
  it("does not call the provider without credentials", async () => {
    expect((await verifyOnboardingAI(req())).status).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });
});
describe("website normalization", () => {
  it.each(["example.com", " https://EXAMPLE.com/a?q=x ", "http://example.com:8080/"])(
    "normalizes %s",
    (value) => expect(normalizeWebsite(value)).toBe("example.com"),
  );
  it.each([
    "",
    "  ",
    "ftp://example.com",
    "https://user:pass@example.com",
    "bad domain",
    "https://",
    "-bad.com",
  ])("rejects %s", (value) => expect(normalizeWebsite(value)).toBeNull());
});
