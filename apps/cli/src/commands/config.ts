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
      // Optional — press enter to skip. Mirrors the `init` wizard + /setup page.
      {
        type: "text",
        name: "icpOneLiner",
        message: "ICP one-liner — who you sell to (blank = no filtering)",
        initial: cfg.icpOneLiner ?? "",
      },
      {
        type: "text",
        name: "productDomain",
        message: "Signature domain — bare domain under your name in emails (blank = none)",
        initial: cfg.productDomain ?? "",
      },
      {
        type: "text",
        name: "sendingDomain",
        message: "Sending domain — the domain your wallet owns (blank = SDK default)",
        initial: cfg.sendingDomain ?? "",
      },
      {
        type: "text",
        name: "founderCredentials",
        message: "Founder background — prior roles/companies that build trust (optional)",
        initial: cfg.founderCredentials ?? "",
      },
      {
        type: "text",
        name: "productPortfolio",
        message: "Products you've shipped — comma-separated (optional)",
        initial: cfg.productPortfolio ?? "",
      },
      {
        type: "text",
        name: "partners",
        message: "Notable partners / customers — brand names that open doors (optional)",
        initial: cfg.partners ?? "",
      },
    ],
    { onCancel: () => process.exit(0) },
  );
  saveConfig({
    ...cfg,
    founderName: (answers["founderName"] ?? cfg.founderName) || null,
    founderEmail: (answers["founderEmail"] ?? cfg.founderEmail) || null,
    productOneLiner: (answers["productOneLiner"] ?? cfg.productOneLiner) || null,
    productDomain: (answers["productDomain"] ?? cfg.productDomain) || null,
    sendingDomain: (answers["sendingDomain"] ?? cfg.sendingDomain) || null,
    icpOneLiner: (answers["icpOneLiner"] ?? cfg.icpOneLiner) || null,
    founderCredentials: (answers["founderCredentials"] ?? cfg.founderCredentials) || null,
    productPortfolio: (answers["productPortfolio"] ?? cfg.productPortfolio) || null,
    partners: (answers["partners"] ?? cfg.partners) || null,
  });
  ok("Saved.");
}

export async function configTelemetry(state: "on" | "off"): Promise<void> {
  const cfg = loadConfig();
  saveConfig({ ...cfg, telemetryEnabled: state === "on" });
  ok(`telemetry ${state === "on" ? c.green("enabled") : c.dim("disabled")}`);
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
        message: "Update wallet keys?",
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
