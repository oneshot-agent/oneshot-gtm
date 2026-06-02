import {
  loadConfig,
  saveConfig,
  saveSecrets,
  secretSource,
  secretsPath,
  type OneShotConfig,
} from "@oneshot-gtm/core";
import type { LlmProvider, SetupRequest, WalletMode } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

/**
 * The anonymous clientId is local-only — never exposed to the web layer.
 * Strip it before any HTTP response so the browser never sees it (and can't
 * accidentally clobber it on a subsequent POST).
 */
/**
 * Strip the anonymous clientId before sending cfg to the web layer. Exported
 * so we can unit-test the privacy boundary directly.
 */
export function publicCfg(cfg: OneShotConfig): Omit<OneShotConfig, "clientId"> {
  const { clientId: _omit, ...rest } = cfg;
  void _omit;
  return rest;
}

export function getSetupStatus(req: Request): Response {
  const cfg = loadConfig();
  return jsonResponse(
    {
      cfg: publicCfg(cfg),
      secretsPath: secretsPath(),
      sources: {
        OPENROUTER_API_KEY: secretSource("OPENROUTER_API_KEY"),
        OPENAI_API_KEY: secretSource("OPENAI_API_KEY"),
        ANTHROPIC_API_KEY: secretSource("ANTHROPIC_API_KEY"),
        CDP_API_KEY_ID: secretSource("CDP_API_KEY_ID"),
        CDP_API_KEY_SECRET: secretSource("CDP_API_KEY_SECRET"),
        CDP_WALLET_SECRET: secretSource("CDP_WALLET_SECRET"),
        AGENT_PRIVATE_KEY: secretSource("AGENT_PRIVATE_KEY"),
      },
    },
    200,
    req,
  );
}

export async function setup(req: Request): Promise<Response> {
  const body = (await req.json()) as SetupRequest;
  const current = loadConfig();
  const llmProvider: LlmProvider = body.llmProvider ?? current.llmProvider;
  const walletMode: WalletMode = body.walletMode ?? current.walletMode;

  // clientId is preserved from current — body.clientId is intentionally
  // ignored so a malicious or accidental web POST can't rotate the anonymous
  // install id. saveConfig writes the entire cfg, so omitting clientId here
  // would silently drop it from disk.
  saveConfig({
    walletMode,
    llmProvider,
    llmModel: body.llmModel ?? current.llmModel,
    telemetryEnabled: body.telemetryEnabled ?? current.telemetryEnabled,
    founderName: mergeString(body.founderName, current.founderName),
    founderEmail: mergeString(body.founderEmail, current.founderEmail),
    productOneLiner: mergeString(body.productOneLiner, current.productOneLiner),
    productDomain: mergeString(body.productDomain, current.productDomain),
    sendingDomain: mergeString(body.sendingDomain, current.sendingDomain),
    icpOneLiner: mergeString(body.icpOneLiner, current.icpOneLiner),
    cadenceOverrides: current.cadenceOverrides,
    founderCredentials: mergeString(body.founderCredentials, current.founderCredentials),
    productPortfolio: mergeString(body.productPortfolio, current.productPortfolio),
    partners: mergeString(body.partners, current.partners),
    mobileSignature: body.mobileSignature ?? current.mobileSignature,
    clientId: current.clientId,
  });

  if (body.secrets && Object.keys(body.secrets).length > 0) {
    saveSecrets(body.secrets);
  }

  return jsonResponse({ ok: true }, 200, req);
}

/**
 * Merge a form-submitted string into the stored config:
 *   undefined → keep existing (caller didn't touch the field)
 *   ""        → clear (caller deliberately emptied the field)
 *   non-empty → trim + save
 */
function mergeString(incoming: string | undefined, current: string | null): string | null {
  if (incoming === undefined) return current;
  const trimmed = incoming.trim();
  return trimmed.length === 0 ? null : trimmed;
}
