import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  capGroupKey,
  configDir,
  getBalance,
  getGmailProfile,
  getLedger,
  GMAIL_AUTH_HINT,
  gmailAccountFor,
  identityCapacities,
  listSendingDomains,
  llmApiKey,
  loadConfig,
  missingGmailSecrets,
  oneshotEnvReady,
  resolveIdentities,
  secretSource,
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
    const identities = resolveIdentities(cfg);
    // Per cap-group capacity (the shared per-domain budget). Used for the usage
    // string so doctor reports the real gate, not a per-mailbox illusion.
    const caps = identityCapacities();
    const groupSize = new Map<string, number>();
    for (const i of identities) {
      const k = capGroupKey(i);
      groupSize.set(k, (groupSize.get(k) ?? 0) + 1);
    }

    // Provisioned-domain pool, fetched once and only when it can matter (a
    // wallet exists AND at least one OneShot identity to report on). Empty map =
    // "couldn't enumerate" → skip the warmth report rather than cry wolf.
    // We report warmth, not ownership: a pinned send (we always set from_domain)
    // AUTO-PROVISIONS an unknown domain and BYPASSES the server's warmup gating,
    // so there is no domain_not_owned failure to pre-empt — the deliverability
    // risk is sending from a cold/warming domain with only the client cap as a
    // throttle.
    let domainPool: Map<string, { warmupScore: number | null; status: string }> | null = null;
    if (oneshotEnvReady() && identities.some((i) => i.provider === "oneshot")) {
      try {
        const pool = await listSendingDomains();
        if (pool.length > 0) {
          domainPool = new Map(
            pool.map((d) => [
              d.domain.toLowerCase(),
              { warmupScore: d.warmup_score, status: d.pool_status },
            ]),
          );
        }
      } catch {
        // Leave null — transient/auth failure shouldn't downgrade the check.
      }
    }

    for (const identity of identities) {
      const c = caps.get(identity.id);
      const capStr = c && Number.isFinite(c.capToday) ? String(c.capToday) : "∞";
      const shared = (groupSize.get(capGroupKey(identity)) ?? 1) > 1;
      // When mailboxes share a domain, show the shared domain total alongside
      // this mailbox's own count so the cap reads honestly.
      const usage = shared
        ? `today ${c?.identitySentToday ?? 0} · domain ${c?.domainSentToday ?? 0}/${capStr} shared`
        : `today ${c?.identitySentToday ?? 0}/${capStr}`;
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
        const localpart = identity.mailbox ? `${identity.mailbox}@` : "";
        const entry = domain && domainPool ? domainPool.get(domain.toLowerCase()) : undefined;
        if (!domain) {
          results.push({
            name,
            severity: "warn",
            message: `no sendingDomain — SDK default domain · ${usage}`,
          });
        } else if (domainPool && !entry) {
          // Known pool, domain absent: not an error (auto-provisions on first
          // send) but it'll go out cold with no server warmup — lean on the cap.
          results.push({
            name,
            severity: "warn",
            message: `${localpart}${domain} not yet provisioned — auto-provisions on first send and bypasses server warm-up; client cap is the only throttle · ${usage}`,
            hint: "Confirm you control this domain, or pick a warmed one (oneshot-gtm identities list).",
          });
        } else if (entry && (entry.status === "paused" || entry.status === "removed")) {
          results.push({
            name,
            severity: "warn",
            message: `${localpart}${domain} is ${entry.status} in the pool · ${usage}`,
            hint: `Resume it on /setup (Sender → Provisioned domains) or run: oneshot-gtm domains resume ${domain}`,
          });
        } else {
          const warmth =
            entry?.status === "warming"
              ? ` · warming${entry.warmupScore != null ? ` (score ${entry.warmupScore})` : ""} — pinned sends skip server warm-up, client cap throttles`
              : "";
          results.push({
            name,
            severity: "ok",
            message: `sending from ${localpart}${domain} · ${usage}${warmth}`,
          });
        }
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
