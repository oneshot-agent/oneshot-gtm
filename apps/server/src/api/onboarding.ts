import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, demoMode, llmApiKey, loadConfig } from "@oneshot-gtm/core";
import { complete } from "@oneshot-gtm/intel";
import { normalizeWebsite, type OnboardingStatus } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

interface State {
  fingerprintSalt?: string;
  deferred?: boolean;
  revision?: string;
  verification?: { fingerprint: string; at: string };
}
function readState(): State {
  const path = join(configDir(), "onboarding.json");
  if (!existsSync(path)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as State) : {};
  } catch {
    return {};
  }
}
function writeState(state: State): void {
  mkdirSync(configDir(), { recursive: true });
  const path = join(configDir(), "onboarding.json");
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
// Cache only the current server-side derivation so status polling stays inexpensive.
let fingerprintCache: { input: string; salt: string; fingerprint: string } | undefined;
export function aiFingerprint(): string {
  const cfg = loadConfig();
  const state = readState();
  const salt = state.fingerprintSalt ?? randomBytes(16).toString("hex");
  if (!state.fingerprintSalt) writeState({ ...state, fingerprintSalt: salt });
  const input = JSON.stringify([cfg.llmProvider, cfg.llmModel, llmApiKey(cfg.llmProvider)]);
  if (fingerprintCache?.input === input && fingerprintCache.salt === salt)
    return fingerprintCache.fingerprint;
  const fingerprint = scryptSync(input, salt, 32).toString("hex");
  fingerprintCache = { input, salt, fingerprint };
  return fingerprint;
}
export function invalidateOnboardingAI(): void {
  writeState({ ...readState(), revision: randomUUID(), verification: undefined });
}
export function onboardingStatus(): OnboardingStatus {
  const cfg = loadConfig();
  const state = readState();
  const context = {
    founderName: cfg.founderName?.trim() ?? "",
    productDomain: cfg.productDomain?.trim() ?? "",
    productOneLiner: cfg.productOneLiner?.trim() ?? "",
    icpOneLiner: cfg.icpOneLiner?.trim() ?? "",
  };
  const credentials = {
    openrouter: !!llmApiKey("openrouter")?.trim(),
    openai: !!llmApiKey("openai")?.trim(),
    anthropic: !!llmApiKey("anthropic")?.trim(),
  };
  const aiVerified =
    credentials[cfg.llmProvider] &&
    !!cfg.llmModel.trim() &&
    state.verification?.fingerprint === aiFingerprint();
  const businessMissing = [
    !context.founderName && "Founder name",
    !normalizeWebsite(context.productDomain) && "Website",
    !context.productOneLiner && "Product description",
  ].filter(Boolean) as string[];
  const missing = [
    ...businessMissing,
    ...(!context.icpOneLiner ? ["Target customer"] : []),
    ...(!aiVerified ? ["Verified AI connection"] : []),
  ];
  // Defaults and a bootstrapped clientId alone do not make a configured workspace.
  const configured =
    Object.values(context).some(Boolean) ||
    Object.values(credentials).some(Boolean) ||
    !!(
      cfg.founderEmail ||
      cfg.sendingDomain ||
      cfg.emailIdentities?.length ||
      cfg.productBrief ||
      cfg.founderCredentials ||
      cfg.productPortfolio ||
      cfg.partners ||
      cfg.founderVoice ||
      cfg.founderAdmission ||
      cfg.timezone ||
      cfg.slackWebhookUrl ||
      cfg.llmProvider !== "openrouter" ||
      cfg.llmModel !== "anthropic/claude-sonnet-4.6" ||
      cfg.walletMode !== "cdp" ||
      process.env.AGENT_PRIVATE_KEY ||
      process.env.CDP_API_KEY_ID ||
      process.env.SMARTLEAD_API_KEY ||
      process.env.GMAIL_REFRESH_TOKEN
    );
  return {
    ready: missing.length === 0,
    missing,
    nextStep: businessMissing.length ? 1 : !context.icpOneLiner ? 2 : 3,
    aiVerified,
    verifiedAt: aiVerified ? state.verification!.at : null,
    deferred: !!state.deferred,
    autoOpen: !demoMode() && !configured && !state.deferred,
    demo: demoMode(),
    context,
    provider: cfg.llmProvider,
    model: cfg.llmModel,
    credentials,
  };
}
export async function getOnboarding(req: Request): Promise<Response> {
  return jsonResponse(onboardingStatus(), 200, req);
}
export async function deferOnboarding(req: Request): Promise<Response> {
  if (demoMode()) return jsonResponse({ error: "The demo is read-only." }, 403, req);
  writeState({ ...readState(), deferred: true });
  return jsonResponse(onboardingStatus(), 200, req);
}
export async function verifyOnboardingAI(req: Request): Promise<Response> {
  if (demoMode()) return jsonResponse({ error: "The demo is read-only." }, 403, req);
  invalidateOnboardingAI();
  const fingerprint = aiFingerprint();
  const revision = readState().revision;
  const cfg = loadConfig();
  if (!llmApiKey(cfg.llmProvider)?.trim())
    return jsonResponse(
      { error: "Add an API key for the selected provider, then save and test again." },
      400,
      req,
    );
  try {
    await complete({
      messages: [
        { role: "system", content: "Test the connection." },
        { role: "user", content: "Reply with OK." },
      ],
      maxTokens: 32,
      maxAttempts: 1,
      timeoutMs: 20_000,
      allowTruncation: true,
    });
    if (fingerprint !== aiFingerprint() || revision !== readState().revision)
      return jsonResponse(
        { error: "AI settings changed during the test. Test the saved connection again." },
        409,
        req,
      );
    writeState({ ...readState(), verification: { fingerprint, at: new Date().toISOString() } });
    return jsonResponse(onboardingStatus(), 200, req);
  } catch (error) {
    // Never return provider response bodies: they can echo credentials.
    const e = error as { status?: number; name?: string };
    const message =
      e.status === 401 || e.status === 403
        ? "The provider rejected the API key. Check the key and its permissions."
        : e.status === 400 || e.status === 404
          ? "The provider could not use this model. Check the model ID and your access, or restore the default."
          : e.status === 402 || e.status === 429
            ? "Check your provider balance and rate limits, then try again."
            : e.name === "LlmTimeoutError"
              ? "The connection timed out after 20 seconds. Try again or choose another model."
              : "Could not verify the connection. Check your provider, model, key, and network, then try again.";
    return jsonResponse({ error: message }, 502, req);
  }
}
