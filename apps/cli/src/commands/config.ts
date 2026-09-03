import {
  getLedger,
  dailySpendStatus,
  loadConfig,
  saveConfig,
  saveSecrets,
  secretsPath,
} from "@oneshot-gtm/core";
import { TRIGGERS, checkReadiness } from "@oneshot-gtm/find";
import { withXEngine, type XEngine } from "@oneshot-gtm/shared-types";
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
        message: "Your email (lead capture on generated pages — not the reply address)",
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
      {
        type: "text",
        name: "founderAdmission",
        message:
          "One true concession — what you'd rather not say but is true, e.g. 'two people, no enterprise logos yet' (optional)",
        initial: cfg.founderAdmission ?? "",
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
    founderAdmission: (answers["founderAdmission"] ?? cfg.founderAdmission) || null,
  });
  ok("Saved.");
}

export async function configTelemetry(state: "on" | "off"): Promise<void> {
  const cfg = loadConfig();
  saveConfig({ ...cfg, telemetryEnabled: state === "on" });
  ok(`telemetry ${state === "on" ? c.green("enabled") : c.dim("disabled")}`);
}

/**
 * Show or set the install-wide daily USD spend ceiling (issue #481). No
 * argument prints the current ceiling + today's spend; `off` clears it back
 * to unlimited (the historical default); any other value must parse as a
 * positive number.
 */
export async function configSpendCeiling(amountArg?: string): Promise<void> {
  header("Daily spend ceiling");
  const cfg = loadConfig();

  if (amountArg === undefined) {
    const status = dailySpendStatus();
    if (cfg.dailySpendCeilingUsd == null) {
      note("unlimited (no ceiling set)");
    } else {
      note(
        `$${status.effectiveUsd.toFixed(2)} / $${cfg.dailySpendCeilingUsd.toFixed(2)} spent today${status.ceilingReached ? c.dim(" — ceiling reached, automated paths halted") : ""}`,
      );
    }
    note(c.dim(`set with: oneshot-gtm config spend-ceiling <amount|off>`));
    return;
  }

  if (amountArg === "off") {
    saveConfig({ ...cfg, dailySpendCeilingUsd: null });
    ok("daily spend ceiling cleared — unlimited");
    return;
  }

  const amount = Number.parseFloat(amountArg);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`invalid amount '${amountArg}' — pass a positive number of USD, or 'off'`);
  }
  saveConfig({ ...cfg, dailySpendCeilingUsd: amount });
  ok(`daily spend ceiling set to $${amount.toFixed(2)}`);
}

const X_TRIGGER = "x-reposters";
const set = (k: string) => (process.env[k] ? c.green("set") : c.red("missing"));

/**
 * Show or switch the x-reposters data provider. Mirrors the /setup card:
 * switching drops the maxSpendPerRun/knobs overrides (via withXEngine) so the
 * new engine's defaults re-apply, and never flips the trigger's enablement.
 */
export async function configXEngine(engineArg?: string): Promise<void> {
  header("X data provider (x-reposters)");
  const ledger = getLedger();
  const spec = TRIGGERS.find((t) => t.name === X_TRIGGER);
  if (!spec) throw new Error(`trigger '${X_TRIGGER}' is not registered`);
  const stored = ledger.getTrigger(X_TRIGGER);
  let config: Record<string, unknown> = { ...spec.defaultConfig };
  if (stored?.config_json) {
    try {
      config = JSON.parse(stored.config_json) as Record<string, unknown>;
    } catch {
      note(c.dim("stored config is unparseable — treating as defaults"));
    }
  }
  const current: XEngine = config["engine"] === "twitterapiio" ? "twitterapiio" : "xapi";

  if (!engineArg) {
    note(`engine: ${c.cyan(current)} · trigger ${stored?.enabled ? "enabled" : "disabled"}`);
    note(
      `  X API (first-party):  X_API_KEY ${set("X_API_KEY")} · X_API_SECRET ${set("X_API_SECRET")} · X_ACCESS_TOKEN ${set("X_ACCESS_TOKEN")} · X_ACCESS_SECRET ${set("X_ACCESS_SECRET")}`,
    );
    note(`  twitterapi.io:        TWITTERAPI_IO_KEY ${set("TWITTERAPI_IO_KEY")}`);
    const ready = checkReadiness(spec, config);
    note(ready.ready ? c.green("ready") : `not ready — ${ready.reason}`);
    note(c.dim(`switch with: oneshot-gtm config x-engine <xapi|twitterapiio>`));
    return;
  }

  if (engineArg !== "xapi" && engineArg !== "twitterapiio") {
    throw new Error(`unknown engine '${engineArg}' — use xapi or twitterapiio`);
  }
  const next = engineArg as XEngine;
  if (next === current) {
    ok(`already on ${c.cyan(next)} — nothing to change`);
    return;
  }
  const merged = withXEngine(config, next);
  if (stored) {
    ledger.setTriggerConfig(X_TRIGGER, JSON.stringify(merged));
  } else {
    // Never silently enable an opt-in paid finder from a config write.
    ledger.upsertTrigger({ name: X_TRIGGER, configJson: JSON.stringify(merged), enabled: false });
  }
  ok(`engine: ${c.dim(current)} → ${c.cyan(next)}`);
  note(c.dim("maxSpendPerRun/knobs overrides reset — the new engine's defaults apply"));
  const ready = checkReadiness(spec, merged);
  note(ready.ready ? c.green("ready") : `not ready — ${ready.reason}`);
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
      {
        type: "select",
        name: "xMode",
        message: "Update X (Twitter) keys? (x-reposters finder)",
        choices: [
          { title: "X API (first-party) — 4 OAuth1 user-context keys", value: "xapi" },
          { title: "twitterapi.io — 1 key (~55x cheaper, third-party)", value: "twitterapiio" },
          { title: "Skip", value: "skip" },
        ],
        initial: 2,
      },
      {
        type: (_, v) => (v["xMode"] === "xapi" ? "password" : null),
        name: "xApiKey",
        message: "X_API_KEY",
      },
      {
        type: (_, v) => (v["xMode"] === "xapi" ? "password" : null),
        name: "xApiSecret",
        message: "X_API_SECRET",
      },
      {
        type: (_, v) => (v["xMode"] === "xapi" ? "password" : null),
        name: "xAccessToken",
        message: "X_ACCESS_TOKEN",
      },
      {
        type: (_, v) => (v["xMode"] === "xapi" ? "password" : null),
        name: "xAccessSecret",
        message: "X_ACCESS_SECRET",
      },
      {
        type: (_, v) => (v["xMode"] === "twitterapiio" ? "password" : null),
        name: "twitterApiIoKey",
        message: "TWITTERAPI_IO_KEY",
      },
      {
        type: "password",
        name: "githubToken",
        message: "GITHUB_TOKEN (GitHub finders; classic token needs no scopes)",
      },
      {
        type: "password",
        name: "lumaSessionCookie",
        message: "LUMA_SESSION_COOKIE (optional; hosted-event guest lists)",
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
  if (answers["xApiKey"]) updates["X_API_KEY"] = answers["xApiKey"] as string;
  if (answers["xApiSecret"]) updates["X_API_SECRET"] = answers["xApiSecret"] as string;
  if (answers["xAccessToken"]) updates["X_ACCESS_TOKEN"] = answers["xAccessToken"] as string;
  if (answers["xAccessSecret"]) updates["X_ACCESS_SECRET"] = answers["xAccessSecret"] as string;
  if (answers["twitterApiIoKey"])
    updates["TWITTERAPI_IO_KEY"] = answers["twitterApiIoKey"] as string;
  if (answers["githubToken"]) updates["GITHUB_TOKEN"] = answers["githubToken"] as string;
  if (answers["lumaSessionCookie"])
    updates["LUMA_SESSION_COOKIE"] = answers["lumaSessionCookie"] as string;

  if (Object.keys(updates).length === 0) {
    note("No changes.");
    return;
  }
  saveSecrets(updates);
  ok(`Saved ${Object.keys(updates).length} key(s) to ${c.dim(secretsPath())}`);
}
