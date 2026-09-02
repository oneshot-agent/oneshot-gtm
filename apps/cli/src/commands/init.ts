import { join } from "node:path";
import {
  llmApiKey,
  loadConfig,
  oneshotEnvReady,
  saveConfig,
  saveSecrets,
  secretsPath,
  configDir,
  type OneShotConfig,
} from "@oneshot-gtm/core";
import prompts from "prompts";
import { box, c, header, note, ok, warn } from "../output.ts";

export async function runInit(): Promise<void> {
  header("Welcome to oneshot-gtm");
  note("Pay-per-result GTM. Signed receipts. Founder-led discipline encoded.\n");

  const cfg = loadConfig();

  const answers = await prompts(
    [
      {
        type: "text",
        name: "founderName",
        message: "Your name",
        initial: cfg.founderName ?? "",
        validate: (s) => (s.trim().length > 0 ? true : "required"),
      },
      {
        type: "text",
        name: "founderEmail",
        message: "Your email (lead capture on generated pages — not the reply address)",
        initial: cfg.founderEmail ?? "",
        validate: (s) => (/.+@.+\..+/.test(s) ? true : "valid email required"),
      },
      {
        type: "text",
        name: "productOneLiner",
        message: "Product one-liner (what you're building, in 1 sentence)",
        initial: cfg.productOneLiner ?? "",
        validate: (s) => (s.trim().length >= 10 ? true : "be specific"),
      },
      // All of the following are optional — press enter to skip. They sharpen
      // discovery + email personalization but aren't required to get started.
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
      {
        type: "text",
        name: "founderAdmission",
        message:
          "One true concession — what you'd rather not say but is true, e.g. 'two people, no enterprise logos yet' (optional)",
        initial: cfg.founderAdmission ?? "",
      },
      {
        type: "select",
        name: "llmProvider",
        message: "LLM provider for personalization, advise, synthesis",
        choices: [
          { title: "OpenRouter (recommended — one key, swap models)", value: "openrouter" },
          { title: "OpenAI", value: "openai" },
          { title: "Anthropic", value: "anthropic" },
        ],
        initial: cfg.llmProvider === "openai" ? 1 : cfg.llmProvider === "anthropic" ? 2 : 0,
      },
      {
        type: (prev) =>
          prev === "openrouter" || prev === "openai" || prev === "anthropic" ? "text" : null,
        name: "llmModel",
        message: (_, values) => `Model name for ${values["llmProvider"]}`,
        initial: (_, values) => defaultModel(values["llmProvider"]),
      },
      {
        type: "confirm",
        name: "telemetryEnabled",
        message:
          "Send anonymous opt-out telemetry? (commands run, no data, no PII — see TELEMETRY.md)",
        initial: cfg.telemetryEnabled,
      },
    ],
    { onCancel: () => process.exit(0) },
  );

  const provider = answers["llmProvider"] ?? cfg.llmProvider;
  saveConfig(mergeInitConfig(cfg, answers));
  ok(`Saved profile to ${c.dim(join(configDir(), "config.json"))}`);

  // Phase 2: collect secrets interactively (saved chmod 600 to ~/.oneshot-gtm/.env)
  process.stdout.write(
    `\n${c.dim("Now let's wire up your API keys. They'll be saved to")} ${c.cyan(secretsPath())}${c.dim(" (chmod 600).")}\n`,
  );
  process.stdout.write(
    `${c.dim("Skip any prompt with empty input — set them later with:")} ${c.cyan("oneshot-gtm config keys")}\n\n`,
  );

  const llmEnvName = envForProvider(provider);
  const llmAlreadySet = Boolean(llmApiKey(provider));
  const oneShotAlreadySet = oneshotEnvReady();

  const secretAnswers = await prompts(
    [
      {
        type: llmAlreadySet ? null : "password",
        name: "llmKey",
        message: `Paste your ${llmEnvName} (input hidden)`,
      },
      {
        type: "select",
        name: "walletMode",
        message: "Wallet mode",
        choices: [
          { title: "Coinbase CDP server wallet (recommended)", value: "cdp" },
          { title: "Raw private key", value: "private-key" },
          { title: "Skip — I'll set these later", value: "skip" },
        ],
        initial: oneShotAlreadySet ? 2 : 0,
      },
      {
        type: (prev) => (prev === "cdp" ? "password" : null),
        name: "cdpId",
        message: "CDP_API_KEY_ID",
      },
      {
        type: (_, values) => (values["walletMode"] === "cdp" ? "password" : null),
        name: "cdpSecret",
        message: "CDP_API_KEY_SECRET",
      },
      {
        type: (_, values) => (values["walletMode"] === "cdp" ? "password" : null),
        name: "cdpWallet",
        message: "CDP_WALLET_SECRET",
      },
      {
        type: (_, values) => (values["walletMode"] === "private-key" ? "password" : null),
        name: "agentKey",
        message: "AGENT_PRIVATE_KEY",
      },
    ],
    { onCancel: () => process.exit(0) },
  );

  const updates: Record<string, string> = {};
  if (secretAnswers["llmKey"]) updates[llmEnvName] = secretAnswers["llmKey"] as string;
  if (secretAnswers["cdpId"]) updates["CDP_API_KEY_ID"] = secretAnswers["cdpId"] as string;
  if (secretAnswers["cdpSecret"])
    updates["CDP_API_KEY_SECRET"] = secretAnswers["cdpSecret"] as string;
  if (secretAnswers["cdpWallet"])
    updates["CDP_WALLET_SECRET"] = secretAnswers["cdpWallet"] as string;
  if (secretAnswers["agentKey"]) updates["AGENT_PRIVATE_KEY"] = secretAnswers["agentKey"] as string;

  if (Object.keys(updates).length > 0) {
    saveSecrets(updates);
    ok(`Saved keys to ${c.dim(secretsPath())} (chmod 600). They'll auto-load on every CLI run.`);
  } else if (!llmAlreadySet || !oneShotAlreadySet) {
    warn(`No keys set. Run ${c.cyan("oneshot-gtm config keys")} when you're ready.`);
  }

  const cmd = whichCommand();
  box(
    "Next steps",
    [
      `1. Sanity check: ${c.cyan(`${cmd} doctor`)}`,
      `2. Build the dashboard: ${c.cyan("bun run --cwd apps/web build")}`,
      `3. Open the dashboard: ${c.cyan(`${cmd} ui`)}`,
    ].join("\n"),
  );
}

export function mergeInitConfig(
  cfg: OneShotConfig,
  answers: Record<string, unknown>,
): OneShotConfig {
  const provider =
    (answers["llmProvider"] as OneShotConfig["llmProvider"] | undefined) ?? cfg.llmProvider;
  return {
    ...cfg,
    llmProvider: provider,
    llmModel: (answers["llmModel"] as string | undefined) ?? cfg.llmModel,
    telemetryEnabled: (answers["telemetryEnabled"] as boolean | undefined) ?? cfg.telemetryEnabled,
    founderName: (answers["founderName"] as string | undefined) ?? cfg.founderName ?? null,
    founderEmail: (answers["founderEmail"] as string | undefined) ?? cfg.founderEmail ?? null,
    productOneLiner:
      (answers["productOneLiner"] as string | undefined) ?? cfg.productOneLiner ?? null,
    productDomain: (answers["productDomain"] as string | undefined) ?? cfg.productDomain ?? null,
    sendingDomain: (answers["sendingDomain"] as string | undefined) ?? cfg.sendingDomain ?? null,
    icpOneLiner: (answers["icpOneLiner"] as string | undefined) ?? cfg.icpOneLiner ?? null,
    founderCredentials:
      (answers["founderCredentials"] as string | undefined) ?? cfg.founderCredentials ?? null,
    productPortfolio:
      (answers["productPortfolio"] as string | undefined) ?? cfg.productPortfolio ?? null,
    partners: (answers["partners"] as string | undefined) ?? cfg.partners ?? null,
    founderAdmission:
      (answers["founderAdmission"] as string | undefined) ?? cfg.founderAdmission ?? null,
  };
}

function whichCommand(): string {
  // If someone resolved us via the linked bin or a bunx install, the basename is "oneshot-gtm".
  // Otherwise we're being invoked through `bun run packages/cli/src/index.ts ...` and we should
  // suggest that form so the next steps copy-paste works.
  const exec = process.argv[1] ?? "";
  if (exec.endsWith("oneshot-gtm") || exec.endsWith("oneshot-gtm/index.ts")) return "oneshot-gtm";
  return "bun run packages/cli/src/index.ts";
}

function defaultModel(provider: string): string {
  switch (provider) {
    case "openrouter":
      return "anthropic/claude-sonnet-4.6";
    case "openai":
      return "gpt-4o-mini";
    case "anthropic":
      return "claude-sonnet-4-6";
    default:
      return "";
  }
}

function envForProvider(provider: string): string {
  switch (provider) {
    case "openrouter":
      return "OPENROUTER_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    default:
      return "LLM_API_KEY";
  }
}
