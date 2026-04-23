import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  configDir,
  getBalance,
  getLedger,
  llmApiKey,
  loadConfig,
  oneshotEnvReady,
  secretSource,
} from "@oneshot-gtm/core";

export type CheckSeverity = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  severity: CheckSeverity;
  message: string;
  hint?: string;
}

export async function runDoctor(): Promise<CheckResult[]> {
  const cfg = loadConfig();
  const results: CheckResult[] = [];

  results.push({
    name: "config dir",
    severity: existsSync(configDir()) ? "ok" : "warn",
    message: existsSync(configDir()) ? configDir() : `missing: ${configDir()}`,
    ...(existsSync(configDir()) ? {} : { hint: "run: oneshot-gtm init" }),
  });

  results.push({
    name: "founder profile",
    severity: cfg.founderName && cfg.productOneLiner ? "ok" : "warn",
    message:
      cfg.founderName && cfg.productOneLiner
        ? `${cfg.founderName} — ${cfg.productOneLiner}`
        : "founder name + product one-liner not set",
    ...(cfg.founderName && cfg.productOneLiner ? {} : { hint: "run: oneshot-gtm config founder" }),
  });

  const llmEnv = {
    openrouter: "OPENROUTER_API_KEY",
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
  }[cfg.llmProvider];

  const llmSrc = secretSource(llmEnv as never);
  results.push({
    name: `llm key (${cfg.llmProvider})`,
    severity: llmApiKey(cfg.llmProvider) ? "ok" : "fail",
    message: llmApiKey(cfg.llmProvider) ? `set (${llmSrc ?? "?"})` : `${llmEnv} not set`,
    ...(llmApiKey(cfg.llmProvider) ? {} : { hint: `oneshot-gtm config keys` }),
  });

  const cdpSrc = secretSource("CDP_API_KEY_ID");
  const pkSrc = secretSource("AGENT_PRIVATE_KEY");
  const walletSrc = process.env.AGENT_PRIVATE_KEY ? pkSrc : cdpSrc;
  results.push({
    name: "oneshot wallet env",
    severity: oneshotEnvReady() ? "ok" : "fail",
    message: oneshotEnvReady()
      ? `${process.env.AGENT_PRIVATE_KEY ? "AGENT_PRIVATE_KEY" : "CDP wallet"} set (${walletSrc ?? "?"})`
      : "no wallet credentials",
    ...(oneshotEnvReady() ? {} : { hint: "oneshot-gtm config keys" }),
  });

  try {
    const ledger = getLedger();
    const sample = ledger.listReceipts({ limit: 1 });
    results.push({
      name: "ledger",
      severity: "ok",
      message: `ok, ${sample.length === 0 ? "empty" : "has receipts"} (${join(configDir(), "ledger.sqlite")})`,
    });
  } catch (err) {
    results.push({
      name: "ledger",
      severity: "fail",
      message: `error opening ledger: ${(err as Error).message}`,
    });
  }

  if (oneshotEnvReady()) {
    try {
      const bal = await getBalance();
      results.push({
        name: "wallet balance",
        severity: "ok",
        message: `${bal.balance}`,
      });
    } catch (err) {
      results.push({
        name: "wallet balance",
        severity: "warn",
        message: `could not fetch: ${(err as Error).message}`,
      });
    }
  }

  return results;
}
