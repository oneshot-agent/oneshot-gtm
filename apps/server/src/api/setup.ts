import { loadConfig, saveConfig, saveSecrets, secretSource, secretsPath } from "@oneshot-gtm/core";
import type { LlmProvider, SetupRequest, WalletMode } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

export function getSetupStatus(req: Request): Response {
  const cfg = loadConfig();
  return jsonResponse(
    {
      cfg,
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

  saveConfig({
    walletMode,
    llmProvider,
    llmModel: body.llmModel ?? current.llmModel,
    telemetryEnabled: body.telemetryEnabled ?? current.telemetryEnabled,
    founderName: mergeString(body.founderName, current.founderName),
    founderEmail: mergeString(body.founderEmail, current.founderEmail),
    productOneLiner: mergeString(body.productOneLiner, current.productOneLiner),
    icpOneLiner: mergeString(body.icpOneLiner, current.icpOneLiner),
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
