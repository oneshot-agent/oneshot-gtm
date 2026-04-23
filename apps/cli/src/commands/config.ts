import { loadConfig, saveConfig, saveSecrets, secretsPath } from "@oneshot-gtm/core";
import prompts from "prompts";
import { c, header, note, ok } from "../output.ts";

export async function configLlm(): Promise<void> {
  header("Configure LLM provider");
  const cfg = loadConfig();
  const answers = await prompts(
    [
      {
        type: "select",
        name: "llmProvider",
        message: "Provider",
        choices: [
          { title: "OpenRouter", value: "openrouter" },
          { title: "OpenAI", value: "openai" },
          { title: "Anthropic", value: "anthropic" },
        ],
        initial: cfg.llmProvider === "openai" ? 1 : cfg.llmProvider === "anthropic" ? 2 : 0,
      },
      {
        type: "text",
        name: "llmModel",
        message: (_, values) => `Model name for ${values["llmProvider"]}`,
        initial: cfg.llmModel,
      },
    ],
    { onCancel: () => process.exit(0) },
  );
  saveConfig({
    ...cfg,
    llmProvider: answers["llmProvider"] ?? cfg.llmProvider,
    llmModel: answers["llmModel"] ?? cfg.llmModel,
  });
  ok(
    `provider=${c.cyan(answers["llmProvider"] ?? cfg.llmProvider)} model=${c.cyan(answers["llmModel"] ?? cfg.llmModel)}`,
  );
}

export async function configFounder(): Promise<void> {
  header("Configure founder profile");
  const cfg = loadConfig();
  const answers = await prompts(
    [
      { type: "text", name: "founderName", message: "Your name", initial: cfg.founderName ?? "" },
      {
        type: "text",
        name: "founderEmail",
        message: "Reply-to email",
        initial: cfg.founderEmail ?? "",
      },
      {
        type: "text",
        name: "productOneLiner",
        message: "Product one-liner",
        initial: cfg.productOneLiner ?? "",
      },
    ],
    { onCancel: () => process.exit(0) },
  );
  saveConfig({
    ...cfg,
    founderName: (answers["founderName"] ?? cfg.founderName) || null,
    founderEmail: (answers["founderEmail"] ?? cfg.founderEmail) || null,
    productOneLiner: (answers["productOneLiner"] ?? cfg.productOneLiner) || null,
  });
  ok("Saved.");
}

export async function configTelemetry(state: "on" | "off"): Promise<void> {
  const cfg = loadConfig();
  saveConfig({ ...cfg, telemetryEnabled: state === "on" });
  ok(`telemetry ${state === "on" ? c.green("enabled") : c.dim("disabled")}`);
}

export async function configIcpSet(oneLiner: string): Promise<void> {
  const cfg = loadConfig();
  const trimmed = oneLiner.trim();
  if (trimmed.length < 10) {
    note("ICP one-liner too short — give a fuller statement.");
    process.exit(1);
  }
  saveConfig({ ...cfg, icpOneLiner: trimmed });
  ok(`ICP set: ${c.dim(trimmed)}`);
}

export function configIcpShow(): void {
  const cfg = loadConfig();
  if (!cfg.icpOneLiner) {
    note('No ICP set. Set with: oneshot-gtm config icp set "<your one-liner>"');
    return;
  }
  process.stdout.write(`${c.bold("ICP:")}  ${cfg.icpOneLiner}\n`);
}

export async function configKeys(): Promise<void> {
  header("Configure API keys");
  note(`Keys are saved to ${c.cyan(secretsPath())} (chmod 600). Empty input = leave unchanged.\n`);
  const cfg = loadConfig();
  const llmEnvName = {
    openrouter: "OPENROUTER_API_KEY",
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
  }[cfg.llmProvider];

  const answers = await prompts(
    [
      {
        type: "password",
        name: "llmKey",
        message: `${llmEnvName} (current provider: ${cfg.llmProvider})`,
      },
      {
        type: "select",
        name: "walletMode",
        message: "Update OneShot wallet keys?",
        choices: [
          { title: "CDP (Coinbase server wallet)", value: "cdp" },
          { title: "Raw private key", value: "private-key" },
          { title: "Skip", value: "skip" },
        ],
        initial: 2,
      },
      {
        type: (prev) => (prev === "cdp" ? "password" : null),
        name: "cdpId",
        message: "CDP_API_KEY_ID",
      },
      {
        type: (_, v) => (v["walletMode"] === "cdp" ? "password" : null),
        name: "cdpSecret",
        message: "CDP_API_KEY_SECRET",
      },
      {
        type: (_, v) => (v["walletMode"] === "cdp" ? "password" : null),
        name: "cdpWallet",
        message: "CDP_WALLET_SECRET",
      },
      {
        type: (_, v) => (v["walletMode"] === "private-key" ? "password" : null),
        name: "agentKey",
        message: "AGENT_PRIVATE_KEY",
      },
    ],
    { onCancel: () => process.exit(0) },
  );

  const updates: Record<string, string> = {};
  if (answers["llmKey"]) updates[llmEnvName] = answers["llmKey"] as string;
  if (answers["cdpId"]) updates["CDP_API_KEY_ID"] = answers["cdpId"] as string;
  if (answers["cdpSecret"]) updates["CDP_API_KEY_SECRET"] = answers["cdpSecret"] as string;
  if (answers["cdpWallet"]) updates["CDP_WALLET_SECRET"] = answers["cdpWallet"] as string;
  if (answers["agentKey"]) updates["AGENT_PRIVATE_KEY"] = answers["agentKey"] as string;

  if (Object.keys(updates).length === 0) {
    note("No changes.");
    return;
  }
  saveSecrets(updates);
  ok(`Saved ${Object.keys(updates).length} key(s) to ${c.dim(secretsPath())}`);
}
