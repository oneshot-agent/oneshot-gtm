import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  configDir,
  getBalance,
  getGmailProfile,
  getLedger,
  GMAIL_AUTH_HINT,
  gmailAccountFor,
  llmApiKey,
  loadConfig,
  missingGmailSecrets,
  oneshotEnvReady,
  resolveIdentities,
  secretSource,
  todayStartSqliteUtc,
  warmupCap,
} from "@oneshot-gtm/core";

type CheckSeverity = "ok" | "warn" | "fail";

interface CheckResult {
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
    name: "wallet env",
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

  // One line per sender identity in the rotation pool. Legacy installs
  // (emailIdentities unset) get their single synthesized identity, so this
  // doubles as the old single-provider gmail check.
  try {
    const ledger = getLedger();
    const todayStart = todayStartSqliteUtc();
    for (const identity of resolveIdentities(cfg)) {
      const sentToday = ledger.countEmailSendsSince(identity.id, todayStart);
      const cap = warmupCap(identity, ledger.firstEmailSendAt(identity.id));
      const usage = `today ${sentToday}/${cap === Infinity ? "∞" : cap}`;
      const name = `sender ${identity.id}`;
      if (identity.provider === "gmail") {
        const missing = missingGmailSecrets().filter((k) => k !== "GMAIL_REFRESH_TOKEN");
        const account = gmailAccountFor(identity);
        if (missing.length > 0 || !account) {
          results.push({
            name,
            severity: "fail",
            message:
              missing.length > 0 ? `missing: ${missing.join(", ")}` : "no refresh token stored",
            hint: GMAIL_AUTH_HINT,
          });
          continue;
        }
        try {
          const { emailAddress } = await getGmailProfile(account);
          results.push({ name, severity: "ok", message: `sending as ${emailAddress} · ${usage}` });
        } catch (err) {
          results.push({
            name,
            severity: "fail",
            message: `auth check failed: ${(err as Error).message}`,
            hint: GMAIL_AUTH_HINT,
          });
        }
      } else {
        const domain = identity.sendingDomain ?? cfg.sendingDomain;
        results.push({
          name,
          severity: domain ? "ok" : "warn",
          message: domain
            ? `sending from ${domain} · ${usage}`
            : `no sendingDomain — SDK default domain · ${usage}`,
        });
      }
    }
  } catch (err) {
    results.push({
      name: "sender identities",
      severity: "warn",
      message: `could not evaluate: ${(err as Error).message}`,
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
