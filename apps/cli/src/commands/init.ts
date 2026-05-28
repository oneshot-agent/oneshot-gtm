import {
  llmApiKey,
  loadConfig,
  oneshotEnvReady,
  saveConfig,
  saveSecrets,
  secretsPath,
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
        message: "Your reply-to email",
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
  saveConfig({
    walletMode: cfg.walletMode,
    llmProvider: provider,
    llmModel: answers["llmModel"] ?? cfg.llmModel,
    telemetryEnabled: answers["telemetryEnabled"] ?? cfg.telemetryEnabled,
    founderName: (answers["founderName"] ?? cfg.founderName) || null,
    founderEmail: (answers["founderEmail"] ?? cfg.founderEmail) || null,
    productOneLiner: (answers["productOneLiner"] ?? cfg.productOneLiner) || null,
    productDomain: cfg.productDomain,
    sendingDomain: cfg.sendingDomain,
    icpOneLiner: cfg.icpOneLiner,
    cadenceOverrides: cfg.cadenceOverrides,
    // Preserve the anonymous install id (loadConfig already bootstrapped it
    // by the time we got here). Omitting it would silently drop it from disk
    // and the next loadConfig() would mint a fresh one.
    clientId: cfg.clientId,
  });
  ok(`Saved profile to ${c.dim("~/.oneshot-gtm/config.json")}`);

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
        message: "OneShot wallet mode",
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
      `2. Try the coach (no OneShot calls — just your LLM key): ${c.cyan(`${cmd} intel advise`)}`,
      `3. Run a play in dry-run: ${c.cyan(`${cmd} motion show-hn --dry-run --target ./examples/show-hn.json`)}`,
      `4. Drop --dry-run when you're ready to send.`,
      "",
      `${c.dim("Tip: to use the bare")} ${c.cyan("oneshot-gtm")} ${c.dim("command from anywhere, run:")}`,
      `  ${c.cyan("cd packages/cli && bun link && bun link oneshot-gtm && cd -")}`,
    ].join("\n"),
  );
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
