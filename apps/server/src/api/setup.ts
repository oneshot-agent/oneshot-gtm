import {
  deleteGmailToken,
  getLedger,
  listSendingDomains,
  loadConfig,
  registerOneShotIdentity,
  resolveIdentities,
  saveConfig,
  saveSecrets,
  secretSource,
  secretsPath,
  todayStartSqliteUtc,
  warmupCap,
  type DomainPoolEntry,
  type EmailIdentity,
  type OneShotConfig,
} from "@oneshot-gtm/core";
import type {
  DomainPoolView,
  LlmProvider,
  SenderIdentityView,
  SetupRequest,
  WalletMode,
} from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

/**
 * The anonymous clientId is local-only — never exposed to the web layer.
 * Strip it before any HTTP response so the browser never sees it (and can't
 * accidentally clobber it on a subsequent POST).
 */
/**
 * Strip the anonymous clientId before sending cfg to the web layer. Exported
 * so we can unit-test the privacy boundary directly.
 */
export function publicCfg(cfg: OneShotConfig): Omit<OneShotConfig, "clientId"> {
  const { clientId: _omit, ...rest } = cfg;
  void _omit;
  return rest;
}

function identityViews(cfg: OneShotConfig): SenderIdentityView[] {
  const ledger = getLedger();
  const todayStart = todayStartSqliteUtc();
  const legacy = cfg.emailIdentities == null;
  return resolveIdentities(cfg).map((i) => {
    const cap = warmupCap(i, ledger.firstEmailSendAt(i.id));
    return {
      id: i.id,
      provider: i.provider,
      label: i.label ?? null,
      address: i.address ?? null,
      sendingDomain: i.sendingDomain ?? null,
      mailbox: i.mailbox ?? null,
      maxPerDay: i.maxPerDay,
      warmup: i.warmup,
      sentToday: ledger.countEmailSendsSince(i.id, todayStart),
      capToday: cap === Infinity ? null : cap,
      legacy,
    };
  });
}

/** SDK domain-pool entries → the trimmed shape the browser consumes. */
function domainViews(entries: DomainPoolEntry[]): DomainPoolView[] {
  return entries.map((d) => ({
    domain: d.domain,
    poolStatus: d.pool_status,
    warmupScore: d.warmup_score,
    dailySendLimit: d.daily_send_limit,
    dailySentCount: d.daily_sent_count,
  }));
}

/**
 * Best-effort provisioned-domain pool for the setup UI. Swallows every failure
 * (transient OR auth) to `[]` so the setup page always renders — a missing
 * domain list degrades the picker, it shouldn't 500 the whole status call.
 */
async function provisionedDomainViews(): Promise<DomainPoolView[]> {
  try {
    return domainViews(await listSendingDomains());
  } catch {
    return [];
  }
}

export async function getSetupStatus(req: Request): Promise<Response> {
  const cfg = loadConfig();
  return jsonResponse(
    {
      cfg: publicCfg(cfg),
      identities: identityViews(cfg),
      provisionedDomains: await provisionedDomainViews(),
      secretsPath: secretsPath(),
      sources: {
        OPENROUTER_API_KEY: secretSource("OPENROUTER_API_KEY"),
        OPENAI_API_KEY: secretSource("OPENAI_API_KEY"),
        ANTHROPIC_API_KEY: secretSource("ANTHROPIC_API_KEY"),
        CDP_API_KEY_ID: secretSource("CDP_API_KEY_ID"),
        CDP_API_KEY_SECRET: secretSource("CDP_API_KEY_SECRET"),
        CDP_WALLET_SECRET: secretSource("CDP_WALLET_SECRET"),
        AGENT_PRIVATE_KEY: secretSource("AGENT_PRIVATE_KEY"),
        GMAIL_CLIENT_ID: secretSource("GMAIL_CLIENT_ID"),
        GMAIL_CLIENT_SECRET: secretSource("GMAIL_CLIENT_SECRET"),
        GMAIL_REFRESH_TOKEN: secretSource("GMAIL_REFRESH_TOKEN"),
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

  // NOTE: we deliberately do NOT reject domains absent from the provisioned
  // pool. A pinned send (we always set from_domain + from_mailbox) names the
  // domain, which AUTO-PROVISIONS it on the platform on first reference — there
  // is no `domain_not_owned` error to pre-empt. The /setup picker and CLI steer
  // toward already-warmed domains; a brand-new one is a legitimate add (it
  // provisions on the first cadence send). The real risk is deliverability, not
  // a hard failure: pinned sends bypass the server's warmup gating, so the
  // client-side warm-up ramp is the only throttle — hence new identities
  // default to it.
  const adds = body.addIdentities ?? [];

  // Identity-pool edits (cap changes / removals). The first edit materializes
  // the pool from legacy config so the change has somewhere to persist.
  let emailIdentities = current.emailIdentities;
  const hasIdentityEdits =
    (body.identityUpdates?.length ?? 0) > 0 || (body.removeIdentityIds?.length ?? 0) > 0;
  if (hasIdentityEdits) {
    let pool: EmailIdentity[] = current.emailIdentities ?? resolveIdentities(current);
    for (const upd of body.identityUpdates ?? []) {
      const cap =
        typeof upd.maxPerDay === "number" && Number.isFinite(upd.maxPerDay) && upd.maxPerDay >= 0
          ? Math.floor(upd.maxPerDay)
          : null;
      pool = pool.map((i) => (i.id === upd.id ? { ...i, maxPerDay: cap } : i));
    }
    const remove = new Set(body.removeIdentityIds ?? []);
    if (remove.size > 0) {
      pool = pool.filter((i) => !remove.has(i.id));
      for (const id of remove) {
        try {
          deleteGmailToken(id);
        } catch {
          // token-store cleanup is best-effort; the identity is gone either way.
        }
      }
    }
    emailIdentities = pool;
  }

  // clientId is preserved from current — body.clientId is intentionally
  // ignored so a malicious or accidental web POST can't rotate the anonymous
  // install id. saveConfig writes the entire cfg, so omitting clientId here
  // would silently drop it from disk.
  saveConfig({
    walletMode,
    llmProvider,
    llmModel: body.llmModel ?? current.llmModel,
    telemetryEnabled: body.telemetryEnabled ?? current.telemetryEnabled,
    founderName: mergeString(body.founderName, current.founderName),
    founderEmail: mergeString(body.founderEmail, current.founderEmail),
    productOneLiner: mergeString(body.productOneLiner, current.productOneLiner),
    productDomain: mergeString(body.productDomain, current.productDomain),
    sendingDomain: mergeString(body.sendingDomain, current.sendingDomain),
    emailProvider:
      body.emailProvider === "gmail" || body.emailProvider === "oneshot"
        ? body.emailProvider
        : current.emailProvider,
    emailIdentities,
    icpOneLiner: mergeString(body.icpOneLiner, current.icpOneLiner),
    cadenceOverrides: current.cadenceOverrides,
    founderCredentials: mergeString(body.founderCredentials, current.founderCredentials),
    productPortfolio: mergeString(body.productPortfolio, current.productPortfolio),
    partners: mergeString(body.partners, current.partners),
    mobileSignature: body.mobileSignature ?? current.mobileSignature,
    clientId: current.clientId,
  });

  // Adds run AFTER the main saveConfig: registerOneShotIdentity reloads the
  // freshly-persisted config (so it sees the cap/removal edits above and any
  // legacy-pool materialization) before appending. Validated already.
  for (const add of adds) {
    if (!add.sendingDomain?.trim()) continue;
    registerOneShotIdentity({
      sendingDomain: add.sendingDomain,
      mailbox: add.mailbox,
      label: add.label,
      ...("maxPerDay" in add ? { maxPerDay: add.maxPerDay ?? null } : {}),
    });
  }

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
