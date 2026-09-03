import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  capGroupKey,
  configDir,
  dailySpendStatus,
  daysAgoSqliteUtc,
  getBalance,
  getGmailProfile,
  getLedger,
  GMAIL_AUTH_HINT,
  gmailAccountFor,
  identityCapacities,
  listSendingDomains,
  listSmartleadAccounts,
  llmApiKey,
  loadConfig,
  smartleadApiKey,
  type SmartleadAccount,
  missingGmailSecrets,
  oneshotEnvReady,
  resolveIdentities,
  secretSource,
  secretsPath,
  currentWorkspaceName,
  listWorkspaces,
  loadGmailTokens,
  spendCeilingReason,
} from "@oneshot-gtm/core";
import { finderApprovalHealth, storedTriggerConfig, TRIGGERS } from "@oneshot-gtm/find";

type CheckSeverity = "ok" | "warn" | "fail";

/** Section a check renders under in the dashboard's grouped Doctor panel. */
type CheckGroup = "install" | "senders" | "deliverability" | "finders" | "spend";

interface CheckResult {
  name: string;
  group: CheckGroup;
  severity: CheckSeverity;
  message: string;
  hint?: string;
  approvalRate?: number | null;
  approved?: number;
  reviewed?: number;
  threshold?: number;
  windowDays?: number;
  minSamples?: number;
  deprioritized?: boolean;
}

function finderApprovalChecks(): CheckResult[] {
  const ledger = getLedger();
  return TRIGGERS.map((spec) => {
    const health = finderApprovalHealth(
      spec.name,
      storedTriggerConfig(ledger.getTrigger(spec.name), spec),
    );
    const pct = health.rate == null ? "no reviewed rows" : `${(health.rate * 100).toFixed(1)}%`;
    return {
      name: `finder ${spec.name}`,
      group: "finders",
      severity: health.deprioritized ? "warn" : "ok",
      message: health.sufficientData
        ? `${pct} approved (${health.approved}/${health.reviewed}, ${health.windowDays}d)${health.deprioritized ? " — deprioritized: low-approval-rate" : ""}`
        : `${pct} (${health.reviewed}/${health.minSamples} reviewed minimum) — insufficient data, no penalty`,
      ...(health.deprioritized
        ? { hint: "tune approvalRateThreshold in the trigger config or use --ignore-approval-rate" }
        : {}),
      approvalRate: health.rate,
      approved: health.approved,
      reviewed: health.reviewed,
      threshold: health.threshold,
      windowDays: health.windowDays,
      minSamples: health.minSamples,
      deprioritized: health.deprioritized,
    };
  });
}

/** Trailing window for the bounce rate — long enough to accumulate signal at founder-scale volume. */
const BOUNCE_WINDOW_DAYS = 30;
/**
 * Sends required before a rate is reported at all. At low volume the rate is
 * mostly noise: one bad address out of three sends is 33%, which would scream
 * about a perfectly healthy mailbox.
 */
const MIN_SENDS_TO_JUDGE = 20;
/** Industry rule of thumb: sustained hard bounces above ~2% start costing reputation, ~5% is where providers act. */
const HARD_WARN_RATE = 0.02;
const HARD_FAIL_RATE = 0.05;
/**
 * Extra days of SENDS included in the denominator beyond the bounce window.
 *
 * The two sides are timestamped by different events: a bounce is dated when the
 * DSN arrived, a send when it went out. Using an identical window would count a
 * DSN that landed just inside it while excluding the send that caused it —
 * inflating the rate, on a check that can report `fail`. A DSN almost always
 * arrives within minutes and effectively always within two days, so widening
 * only the denominator makes the ratio honest. It biases the rate very slightly
 * LOW, which is the right direction for an error that would otherwise cry wolf.
 */
const SEND_WINDOW_GRACE_DAYS = 2;

/**
 * Per-identity delivery health from harvested DSNs. Two numbers, deliberately
 * not averaged together:
 *  - hard-bounce RATE — list quality. Noisy at low volume, hence the sample gate.
 *  - policy-block COUNT — reputation. Reported from the first occurrence, because
 *    a single "blocked as spam" is a real signal about the sending domain and
 *    would vanish if divided into a percentage.
 */
function deliverabilityChecks(): CheckResult[] {
  const results: CheckResult[] = [];
  try {
    const ledger = getLedger();
    const identities = resolveIdentities(loadConfig());
    const since = new Date(Date.now() - BOUNCE_WINDOW_DAYS * 24 * 3600 * 1000);
    const stats = ledger.bounceStatsByIdentity({ sinceIso: since.toISOString() });

    // Bounce detection reads DSNs out of a mailbox we can authenticate to, so
    // it only covers Gmail identities. A OneShot send's return path belongs to
    // the platform, and Smartlead hosts its mailboxes — neither surfaces DSNs
    // to us, so those identities are structurally invisible here. Saying so
    // matters: silence about an unmonitored sender reads as "no bounces" when
    // it means "we can't tell".
    const blind = identities.filter((i) => i.provider !== "gmail");
    if (blind.length > 0) {
      const providers = [...new Set(blind.map((i) => i.provider))].join(", ");
      results.push({
        name: "deliverability",
        group: "deliverability",
        severity: "warn",
        message: `${blind.length} identit${blind.length === 1 ? "y" : "ies"} not covered (${providers}) — bounce detection reads DSNs from Gmail mailboxes only`,
      });
    }

    // Nothing has ever bounced anywhere — say so once instead of emitting a
    // reassuring "0.0%" per identity that only means the sweep hasn't run.
    if (stats.size === 0) {
      const gmailCount = identities.length - blind.length;
      results.push({
        name: "deliverability",
        group: "deliverability",
        severity: "ok",
        message:
          gmailCount === 0
            ? `no Gmail identity to monitor — no bounce data available`
            : `no delivery failures recorded in the last ${BOUNCE_WINDOW_DAYS}d`,
      });
      return results;
    }
    for (const identity of identities) {
      if (identity.provider !== "gmail") continue; // reported once above, as uncovered
      const s = stats.get(identity.id);
      const sent = ledger.countEmailSendsSince(
        identity.id,
        daysAgoSqliteUtc(BOUNCE_WINDOW_DAYS + SEND_WINDOW_GRACE_DAYS),
      );
      const label = identity.address ?? identity.sendingDomain ?? identity.id;
      // A monitored identity with no bounces gets its own line rather than
      // being skipped. Silently omitting it is indistinguishable from "not
      // evaluated" — and once ANOTHER identity is reporting numbers, the
      // absence of a line reads as an oversight rather than as good news.
      if (!s) {
        results.push({
          name: "deliverability",
          group: "deliverability",
          severity: "ok",
          message:
            sent === 0
              ? `${label} no sends in the last ${BOUNCE_WINDOW_DAYS}d`
              : `${label} 0 bounced of ${sent} sent (${BOUNCE_WINDOW_DAYS}d)`,
        });
        continue;
      }
      const blockNote =
        s.block > 0
          ? ` — ${s.block} spam-block${s.block === 1 ? "" : "s"}, check content/volume`
          : "";

      if (sent < MIN_SENDS_TO_JUDGE) {
        results.push({
          name: "deliverability",
          group: "deliverability",
          severity: s.block > 0 ? "warn" : "ok",
          message: `${label} ${s.hard} hard / ${s.block} blocked of ${sent} sent (${BOUNCE_WINDOW_DAYS}d) — too few sends to rate${blockNote}`,
        });
        continue;
      }

      const rate = s.hard / sent;
      const pct = `${(rate * 100).toFixed(1)}%`;
      const severity: CheckSeverity =
        rate > HARD_FAIL_RATE ? "fail" : rate > HARD_WARN_RATE || s.block > 0 ? "warn" : "ok";
      results.push({
        name: "deliverability",
        group: "deliverability",
        severity,
        message: `${label} ${pct} bounced (${s.hard}/${sent}, ${BOUNCE_WINDOW_DAYS}d)${blockNote}`,
        ...(severity === "ok"
          ? {}
          : {
              hint:
                rate > HARD_WARN_RATE
                  ? "verify emails before sending — hard bounces are dead addresses"
                  : "spam-blocks are a reputation signal, not a bad address",
            }),
      });
    }
  } catch (err) {
    results.push({
      name: "deliverability",
      group: "deliverability",
      severity: "warn",
      message: `could not evaluate: ${(err as Error).message}`,
    });
  }
  return results;
}

/** A placement result older than this is reported as stale — reputation moves. */
const CANARY_STALE_DAYS = 14;

/**
 * REPORTS the last inbox-placement canary; never runs one. doctor is expected
 * to be safe to run at any time, and a canary sends real mail — firing one per
 * doctor invocation would both spend sending reputation and, by repeatedly
 * mailing the same seed address, train its filter until the test always passed.
 */
function placementCheck(): CheckResult {
  try {
    const last = getLedger().latestCanaryResult();
    if (!last) {
      return {
        name: "inbox placement",
        group: "deliverability",
        severity: "ok",
        message: "never tested",
        hint: "run: bun run cli -- gmail placement (needs a second authorized Gmail account)",
      };
    }
    const ageDays = Math.floor(
      (Date.now() - new Date(`${last.created_at.replace(" ", "T")}Z`).getTime()) / 86_400_000,
    );
    const age = Number.isFinite(ageDays) ? `${ageDays}d ago` : "unknown age";
    const auth = `spf=${last.spf} dkim=${last.dkim} dmarc=${last.dmarc}`;
    const caveat = last.same_domain ? " · same-domain, not a real-world verdict" : "";
    // A tab-binned message is delivered but unread in practice, so it is not an
    // "ok" outcome for cold outreach even though nothing rejected it.
    const severity: CheckSeverity =
      last.placement === "spam"
        ? "fail"
        : last.placement === "promotions" ||
            last.placement === "tab" ||
            last.placement === "not_delivered" ||
            last.same_domain === 1 ||
            ageDays > CANARY_STALE_DAYS
          ? "warn"
          : "ok";
    return {
      name: "inbox placement",
      group: "deliverability",
      severity,
      message: `${last.placement} (${age}) · ${auth}${caveat}`,
      ...(ageDays > CANARY_STALE_DAYS
        ? { hint: `last tested ${age} — re-run: bun run cli -- gmail placement` }
        : {}),
    };
  } catch (err) {
    return {
      name: "inbox placement",
      group: "deliverability",
      severity: "warn",
      message: `could not evaluate: ${(err as Error).message}`,
    };
  }
}

/**
 * Workspace identity + cross-workspace guardrails. Other workspaces' homes are
 * read by PATH (config.json / gmail-tokens.json) — core's config is bound to
 * THIS home at import time and can't be re-pointed. Sharing a sending domain
 * across workspaces silently doubles its daily budget (caps are per-ledger);
 * sharing a Gmail account cross-wires reply detection (both pollers see both
 * products' replies).
 */
function workspaceChecks(cfg: ReturnType<typeof loadConfig>): CheckResult[] {
  const out: CheckResult[] = [];
  const name = currentWorkspaceName();
  let all: ReturnType<typeof listWorkspaces> = [];
  try {
    all = listWorkspaces();
  } catch (err) {
    out.push({
      name: "workspace",
      group: "install",
      severity: "warn",
      message: `${name} · ${configDir()}`,
      hint: `workspace registry unreadable: ${(err as Error).message}`,
    });
    return out;
  }
  const mine = all.find(([n]) => n === name)?.[1];
  out.push({
    name: "workspace",
    group: "install",
    severity: "ok",
    message: `${name} · ${configDir()}${mine ? ` · port ${mine.port}` : ""}`,
  });

  const myIdentities = resolveIdentities(cfg);
  const myDomains = new Set(
    myIdentities
      .map((i) => (i.provider === "oneshot" ? (i.sendingDomain ?? cfg.sendingDomain) : null))
      .filter((d): d is string => !!d)
      .map((d) => d.toLowerCase()),
  );
  // Identity `address` is informational and absent in legacy Gmail mode; the
  // token store is what actually polls, so it's the authoritative list.
  const myGmail = new Set(
    [
      ...myIdentities.map((i) => (i.provider === "gmail" ? i.address : null)),
      ...Object.values(loadGmailTokens()).map((t) => t.address),
    ]
      .filter((a): a is string => !!a)
      .map((a) => a.toLowerCase()),
  );
  const mySmartlead = new Set(
    myIdentities
      .map((i) => (i.provider === "smartlead" ? i.address : null))
      .filter((a): a is string => !!a)
      .map((a) => a.toLowerCase()),
  );
  const portsSeen = new Map<number, string>();
  for (const [other, entry] of all) {
    if (entry.port && portsSeen.has(entry.port)) {
      out.push({
        name: `workspace port ${entry.port}`,
        group: "install",
        severity: "warn",
        message: `'${other}' and '${portsSeen.get(entry.port)}' both default to :${entry.port}`,
        hint: "run one with --port, or recreate the workspace",
      });
    }
    if (entry.port) portsSeen.set(entry.port, other);
    if (other === name) continue;
    const theirCfg = readJson<{
      sendingDomain?: string | null;
      emailProvider?: string | null;
      emailIdentities?: Array<{
        provider: string;
        sendingDomain?: string | null;
        address?: string | null;
      }> | null;
    }>(join(entry.home, "config.json"));
    const theirTokens = readJson<Record<string, { address?: string }>>(
      join(entry.home, "gmail-tokens.json"),
    );
    if (!theirCfg) continue;
    const theirDomains = new Set(
      (theirCfg.emailIdentities ?? [])
        .map((i) => (i.provider === "oneshot" ? (i.sendingDomain ?? theirCfg.sendingDomain) : null))
        .concat(
          // Mirror resolveIdentities: no pool OR an empty pool sends via sendingDomain.
          // …except a legacy Gmail install, whose sendingDomain is inert.
          (theirCfg.emailIdentities == null || theirCfg.emailIdentities.length === 0) &&
            theirCfg.emailProvider !== "gmail"
            ? [theirCfg.sendingDomain ?? null]
            : [],
        )
        .filter((d): d is string => !!d)
        .map((d) => d.toLowerCase()),
    );
    const theirGmail = new Set(
      [
        ...(theirCfg.emailIdentities ?? []).map((i) => (i.provider === "gmail" ? i.address : null)),
        ...Object.values(theirTokens ?? {}).map((t) => t.address ?? null),
      ]
        .filter((a): a is string => !!a)
        .map((a) => a.toLowerCase()),
    );
    for (const d of myDomains) {
      if (theirDomains.has(d)) {
        out.push({
          name: `sending domain ${d}`,
          group: "senders",
          severity: "warn",
          message: `also used by workspace '${other}' — caps are per-workspace, so the domain's real daily budget is doubled`,
          hint: "give each workspace its own sending domain (oneshot-gtm identities add)",
        });
      }
    }
    for (const a of myGmail) {
      if (theirGmail.has(a)) {
        out.push({
          name: `gmail ${a}`,
          group: "senders",
          severity: "warn",
          message: `also authorized in workspace '${other}' — both inbox pollers will see both products' replies`,
          hint: "use a separate Gmail account per workspace",
        });
      }
    }
    const theirSmartlead = new Set(
      (theirCfg.emailIdentities ?? [])
        .map((i) => (i.provider === "smartlead" ? i.address : null))
        .filter((a): a is string => !!a)
        .map((a) => a.toLowerCase()),
    );
    for (const a of mySmartlead) {
      if (theirSmartlead.has(a)) {
        out.push({
          name: `smartlead ${a}`,
          group: "senders",
          severity: "warn",
          message: `also registered in workspace '${other}' — caps are per-workspace, so the mailbox's real daily budget is doubled`,
          hint: "register each Smartlead mailbox in only one workspace",
        });
      }
    }
  }
  return out;
}

/**
 * Both GitHub finders share ONE unauthenticated quota: 60 req/hr per IP, which
 * a single `github-stars` pass (repos x up to 3 pages) can exhaust on its own.
 * Unauthenticated, the finder does not run slower — it halts on a 403 that reads
 * like a broken endpoint. Only worth reporting when a GitHub finder is actually
 * enabled, so it stays silent for users who never turn them on.
 */
function githubTokenCheck(): CheckResult | null {
  let enabled: string[];
  try {
    enabled = getLedger()
      .listTriggers()
      .filter((t) => t.enabled === 1 && t.name.startsWith("github-"))
      .map((t) => t.name);
  } catch {
    return null; // ledger unreadable — its own check already reports that
  }
  if (enabled.length === 0) return null;

  const src = secretSource("GITHUB_TOKEN");
  if (process.env["GITHUB_TOKEN"]) {
    return {
      name: "github token",
      group: "install",
      severity: "ok",
      message: `set (${src ?? "?"}) — 5,000 req/hr`,
    };
  }
  return {
    name: "github token",
    group: "install",
    severity: "warn",
    message: `GITHUB_TOKEN not set — ${enabled.join(", ")} limited to 60 req/hr and will halt on 403`,
    hint: `create a classic token with NO scopes at https://github.com/settings/tokens/new, then add GITHUB_TOKEN=... to ${secretsPath()}`,
  };
}

/**
 * Same only-when-enabled shape as the GitHub check, but engine-aware: the
 * x-reposters trigger reads whichever credentials its configured engine needs.
 * First-party (default) needs all four OAuth1 user-context vars — an app-only
 * bearer token 401s on every v2 read the finder makes, so "some creds set" is
 * not enough. The twitterapi.io engine needs only its API key.
 */
function xCredsCheck(): CheckResult | null {
  let rows: Array<{ name: string; config_json?: string | null }>;
  try {
    rows = getLedger()
      .listTriggers()
      .filter((t) => t.enabled === 1 && t.name.startsWith("x-"));
  } catch {
    return null; // ledger unreadable — its own check already reports that
  }
  if (rows.length === 0) return null;

  let engine = "xapi";
  try {
    const cfg = JSON.parse(rows[0]?.config_json ?? "{}") as Record<string, unknown>;
    if (cfg["engine"] === "twitterapiio") engine = "twitterapiio";
  } catch {
    // unparseable config — assume the default engine
  }

  if (engine === "twitterapiio") {
    if (process.env["TWITTERAPI_IO_KEY"]) {
      return {
        name: "x creds (twitterapi.io)",
        group: "install",
        severity: "ok",
        message: `TWITTERAPI_IO_KEY set (${secretSource("TWITTERAPI_IO_KEY") ?? "?"})`,
      };
    }
    return {
      name: "x creds (twitterapi.io)",
      group: "install",
      severity: "warn",
      message: "TWITTERAPI_IO_KEY not set — x-reposters cannot harvest",
      hint: 'add TWITTERAPI_IO_KEY=... to .env (third-party scraper engine — ~55x cheaper than the X API; switch the trigger\'s `engine` to "xapi" for first-party)',
    };
  }

  const missing = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"].filter(
    (k) => !process.env[k],
  );
  if (missing.length === 0) {
    return {
      name: "x creds (first-party)",
      group: "install",
      severity: "ok",
      message: "OAuth1 user-context creds set",
    };
  }
  return {
    name: "x creds (first-party)",
    group: "install",
    severity: "warn",
    message: `${missing.join(", ")} not set — x-reposters cannot harvest`,
    hint: 'add the four OAuth1 user-context values from your X developer app to .env (app-only bearer tokens 401 on v2 reads); or set the trigger\'s `engine` to "twitterapiio" with TWITTERAPI_IO_KEY',
  };
}

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Install-wide daily USD spend ceiling (issue #481). Read-only: never
 * reserves or mutates anything, just reports today's spend against the
 * configured ceiling so a founder sees the same number that gates automated
 * finder/drain runs. Absent a configured ceiling, this is silent — the
 * historical behavior — so an install that never opted in doesn't get a
 * confusing "unlimited" line cluttering the panel.
 */
function dailySpendCeilingCheck(): CheckResult | null {
  let status: ReturnType<typeof dailySpendStatus>;
  try {
    status = dailySpendStatus();
  } catch (err) {
    return {
      name: "daily spend ceiling",
      group: "spend",
      severity: "warn",
      message: `could not evaluate: ${(err as Error).message}`,
    };
  }
  if (status.ceilingUsd == null) return null;
  return {
    name: "daily spend ceiling",
    group: "spend",
    severity: status.ceilingReached ? "warn" : "ok",
    message: status.ceilingReached
      ? spendCeilingReason(status)
      : `$${status.effectiveUsd.toFixed(2)}/$${status.ceilingUsd.toFixed(2)} spent today (resets at local midnight)`,
    ...(status.ceilingReached
      ? { hint: "automated finder runs + drains are halted; manual /queue sends still work" }
      : {}),
  };
}

export async function runDoctor(): Promise<CheckResult[]> {
  const cfg = loadConfig();
  const results: CheckResult[] = [];

  results.push(...workspaceChecks(cfg));

  results.push({
    name: "config dir",
    group: "install",
    severity: existsSync(configDir()) ? "ok" : "warn",
    message: existsSync(configDir()) ? configDir() : `missing: ${configDir()}`,
    ...(existsSync(configDir()) ? {} : { hint: "run: oneshot-gtm init" }),
  });

  results.push({
    name: "founder profile",
    group: "install",
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
    group: "install",
    severity: llmApiKey(cfg.llmProvider) ? "ok" : "fail",
    message: llmApiKey(cfg.llmProvider) ? `set (${llmSrc ?? "?"})` : `${llmEnv} not set`,
    ...(llmApiKey(cfg.llmProvider) ? {} : { hint: `oneshot-gtm config keys` }),
  });

  const gh = githubTokenCheck();
  if (gh) results.push(gh);

  const xc = xCredsCheck();
  if (xc) results.push(xc);

  const cdpSrc = secretSource("CDP_API_KEY_ID");
  const pkSrc = secretSource("AGENT_PRIVATE_KEY");
  const walletSrc = process.env.AGENT_PRIVATE_KEY ? pkSrc : cdpSrc;
  results.push({
    name: "wallet env",
    group: "install",
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
      group: "install",
      severity: "ok",
      message: `ok, ${sample.length === 0 ? "empty" : "has receipts"} (${join(configDir(), "ledger.sqlite")})`,
    });
  } catch (err) {
    results.push({
      name: "ledger",
      group: "install",
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

    // Smartlead account list, fetched once and only when it can matter (a key
    // exists AND at least one smartlead identity to report on). Null = the API
    // was unreachable → per-identity lines say "unverified" rather than fail.
    let smartleadByAddress: Map<string, SmartleadAccount> | null = null;
    if (smartleadApiKey() && identities.some((i) => i.provider === "smartlead")) {
      try {
        smartleadByAddress = new Map((await listSmartleadAccounts()).map((a) => [a.fromEmail, a]));
      } catch (err) {
        results.push({
          name: "smartlead",
          group: "senders",
          severity: "warn",
          message: `could not verify Smartlead accounts: ${(err as Error).message}`,
        });
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
            group: "senders",
            severity: "fail",
            message:
              missing.length > 0 ? `missing: ${missing.join(", ")}` : "no refresh token stored",
            hint: GMAIL_AUTH_HINT,
          });
          continue;
        }
        try {
          const { emailAddress } = await getGmailProfile(account);
          results.push({
            name,
            group: "senders",
            severity: "ok",
            message: `sending as ${emailAddress} · ${usage}`,
          });
        } catch (err) {
          results.push({
            name,
            group: "senders",
            severity: "fail",
            message: `auth check failed: ${(err as Error).message}`,
            hint: GMAIL_AUTH_HINT,
          });
        }
      } else if (identity.provider === "smartlead") {
        const address = identity.address?.trim().toLowerCase() ?? "";
        const account = address ? smartleadByAddress?.get(address) : undefined;
        if (!smartleadApiKey()) {
          results.push({
            name,
            group: "senders",
            severity: "fail",
            message: "SMARTLEAD_API_KEY not set — sends from this identity will fail",
            hint: "Store it with: bun run cli -- smartlead connect",
          });
        } else if (smartleadByAddress && !account) {
          results.push({
            name,
            group: "senders",
            severity: "fail",
            message: `${address || identity.id} is no longer connected in Smartlead`,
            hint: "Reconnect the mailbox in Smartlead, or remove the identity from the pool.",
          });
        } else if (account && !account.isSmtpSuccess) {
          results.push({
            name,
            group: "senders",
            severity: "fail",
            message: `${address} SMTP connection broken in Smartlead — reconnect it there · ${usage}`,
          });
        } else if (account && account.warmupStatus && account.warmupStatus !== "ACTIVE") {
          results.push({
            name,
            group: "senders",
            severity: "warn",
            message: `sending as ${address} · warmup ${account.warmupStatus.toLowerCase()} in Smartlead · ${usage}`,
          });
        } else if (account) {
          const rep = account.warmupReputation ? ` (${account.warmupReputation})` : "";
          const warm = account.warmupStatus ? ` · warmup active${rep}` : "";
          results.push({
            name,
            group: "senders",
            severity: "ok",
            message: `sending as ${address}${warm} · ${usage}`,
          });
        } else {
          results.push({
            name,
            group: "senders",
            severity: "warn",
            message: `sending as ${address || identity.id} · unverified (Smartlead API unreachable) · ${usage}`,
          });
        }
      } else {
        const domain = identity.sendingDomain ?? cfg.sendingDomain;
        const localpart = identity.mailbox ? `${identity.mailbox}@` : "";
        const entry = domain && domainPool ? domainPool.get(domain.toLowerCase()) : undefined;
        if (!domain) {
          results.push({
            name,
            group: "senders",
            severity: "warn",
            message: `no sendingDomain — SDK default domain · ${usage}`,
          });
        } else if (domainPool && !entry) {
          // Known pool, domain absent: not an error (auto-provisions on first
          // send) but it'll go out cold with no server warmup — lean on the cap.
          results.push({
            name,
            group: "senders",
            severity: "warn",
            message: `${localpart}${domain} not yet provisioned — auto-provisions on first send and bypasses server warm-up; client cap is the only throttle · ${usage}`,
            hint: "Confirm you control this domain, or pick a warmed one (oneshot-gtm identities list).",
          });
        } else if (entry && (entry.status === "paused" || entry.status === "removed")) {
          results.push({
            name,
            group: "senders",
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
            group: "senders",
            severity: "ok",
            message: `sending from ${localpart}${domain} · ${usage}${warmth}`,
          });
        }
      }
    }
  } catch (err) {
    results.push({
      name: "sender identities",
      group: "senders",
      severity: "warn",
      message: `could not evaluate: ${(err as Error).message}`,
    });
  }

  // Pushed separately, NOT from inside deliverabilityChecks: that function
  // returns early when nothing has ever bounced, which would have silently
  // dropped the placement line on exactly the fresh installs that most need
  // the "never tested" prompt.
  results.push(...deliverabilityChecks());
  results.push(placementCheck());
  try {
    results.push(...finderApprovalChecks());
  } catch (err) {
    results.push({
      name: "finder approval rates",
      group: "finders",
      severity: "warn",
      message: `could not evaluate: ${(err as Error).message}`,
    });
  }

  if (oneshotEnvReady()) {
    try {
      const bal = await getBalance();
      const amount = Number.parseFloat(bal.balance.trim());
      const usable = Number.isFinite(amount) && amount > 0;
      results.push({
        name: "wallet balance",
        group: "spend",
        severity: usable ? "ok" : "warn",
        message: `${bal.balance}`,
        ...(usable ? {} : { hint: "paid calls require USDC on Base" }),
      });
    } catch (err) {
      results.push({
        name: "wallet balance",
        group: "spend",
        severity: "warn",
        message: `could not fetch: ${(err as Error).message}`,
      });
    }
  }

  const spendCeiling = dailySpendCeilingCheck();
  if (spendCeiling) results.push(spendCeiling);

  return results;
}
