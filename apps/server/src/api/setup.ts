import {
  deleteGmailToken,
  identityCapacities,
  isValidTimeZone,
  listSendingDomains,
  loadConfig,
  registerOneShotIdentity,
  registerSmartleadIdentity,
  resolveIdentities,
  saveConfig,
  saveSecrets,
  secretSource,
  secretsPath,
  withDeadline,
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
  const legacy = cfg.emailIdentities == null;
  // Per cap-group: capToday + domainSentToday reflect the shared per-domain
  // budget (all mailboxes on one OneShot domain pool one reputation/limit).
  const caps = identityCapacities();
  return resolveIdentities(cfg).map((i) => {
    const cap = caps.get(i.id);
    return {
      id: i.id,
      provider: i.provider,
      label: i.label ?? null,
      address: i.address ?? null,
      sendingDomain: i.sendingDomain ?? null,
      mailbox: i.mailbox ?? null,
      maxPerDay: i.maxPerDay,
      warmup: i.warmup,
      sentToday: cap?.identitySentToday ?? 0,
      domainSentToday: cap?.domainSentToday ?? 0,
      capToday: cap && Number.isFinite(cap.capToday) ? cap.capToday : null,
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
 * How long GET /api/setup waits for the platform's domain list before
 * answering without it. The sectioned /setup page (issue #451) renders
 * nothing until this call returns, and `listDomains` has been observed
 * taking 60–80s — so the status call carries only a quick best-effort copy
 * and the picker fetches the full list separately via /api/setup/domains.
 */
const SETUP_STATUS_DOMAINS_DEADLINE_MS = 2_500;
/** The dedicated domain-list route can wait longer; it's off the page's critical path. */
const SETUP_DOMAINS_DEADLINE_MS = 45_000;

/** A pool this old is served immediately but refreshed in the background. */
const DOMAIN_CACHE_FRESH_MS = 60_000;

/**
 * The last pool the platform returned, shared by both routes. `[]` is never
 * cached — it means "unknown", and a later real answer must replace it. One
 * underlying `listSendingDomains()` is shared between concurrent callers, and
 * it keeps running after a caller's deadline fires, so a status call that
 * gave up at 2.5s still fills the cache for the next load.
 */
let domainCache: { views: DomainPoolView[]; at: number } | null = null;
let domainInflight: Promise<DomainPoolView[]> | null = null;

/** Test seam: forget the cached pool between cases. */
export function resetDomainCacheForTests(): void {
  domainCache = null;
  domainInflight = null;
}

function refreshDomainViews(): Promise<DomainPoolView[]> {
  if (domainInflight) return domainInflight;
  const p = listSendingDomains()
    .then((entries) => {
      const views = domainViews(entries);
      if (views.length > 0) domainCache = { views, at: Date.now() };
      return views;
    })
    .finally(() => {
      if (domainInflight === p) domainInflight = null;
    });
  domainInflight = p;
  return p;
}

/**
 * Best-effort provisioned-domain pool for the setup UI. Swallows every failure
 * (transient, auth, OR the deadline) to the last good pool, or `[]` when there
 * is none, so the setup page always renders — a missing domain list degrades
 * the picker, it shouldn't 500 or stall the status call.
 */
async function provisionedDomainViews(deadlineMs: number): Promise<DomainPoolView[]> {
  try {
    return await withDeadline(refreshDomainViews(), deadlineMs, "provisioned domain list");
  } catch {
    return domainCache?.views ?? [];
  }
}

/**
 * What the status call carries: a cached pool is served at once (and
 * refreshed in the background when stale); only a cold cache waits, briefly.
 */
async function cachedDomainViews(): Promise<DomainPoolView[]> {
  if (domainCache) {
    if (Date.now() - domainCache.at > DOMAIN_CACHE_FRESH_MS) {
      refreshDomainViews().catch(() => {
        // background refresh; the stale pool stays until a real answer lands
      });
    }
    return domainCache.views;
  }
  return provisionedDomainViews(SETUP_STATUS_DOMAINS_DEADLINE_MS);
}

/** GET /api/setup/domains — the provisioned pool alone, for the sender picker. */
export async function getSetupDomains(req: Request): Promise<Response> {
  const fresh = domainCache && Date.now() - domainCache.at <= DOMAIN_CACHE_FRESH_MS;
  return jsonResponse(
    {
      provisionedDomains: fresh
        ? domainCache!.views
        : await provisionedDomainViews(SETUP_DOMAINS_DEADLINE_MS),
    },
    200,
    req,
  );
}

export async function getSetupStatus(req: Request): Promise<Response> {
  const cfg = loadConfig();
  return jsonResponse(
    {
      cfg: publicCfg(cfg),
      identities: identityViews(cfg),
      provisionedDomains: await cachedDomainViews(),
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
        SMARTLEAD_API_KEY: secretSource("SMARTLEAD_API_KEY"),
        LINKEDIN_REPLY_WEBHOOK_SECRET: secretSource("LINKEDIN_REPLY_WEBHOOK_SECRET"),
        X_API_KEY: secretSource("X_API_KEY"),
        X_API_SECRET: secretSource("X_API_SECRET"),
        X_ACCESS_TOKEN: secretSource("X_ACCESS_TOKEN"),
        X_ACCESS_SECRET: secretSource("X_ACCESS_SECRET"),
        TWITTERAPI_IO_KEY: secretSource("TWITTERAPI_IO_KEY"),
        GITHUB_TOKEN: secretSource("GITHUB_TOKEN"),
        LUMA_SESSION_COOKIE: secretSource("LUMA_SESSION_COOKIE"),
      },
    },
    200,
    req,
  );
}

/**
 * Thrown for a body the caller can fix (bad cap, bad ceiling, unknown time
 * zone). The handler maps it to a 400 so the /setup form can show the message
 * inline; anything else still surfaces as the generic 500.
 */
export class SetupValidationError extends Error {
  override readonly name = "SetupValidationError";
}

/**
 * Per-identity daily cap as submitted by the web form or a raw API client:
 * `null` = uncapped, a finite number >= 0 = that cap (floored). Anything else
 * — a string, NaN, a negative — is rejected instead of being coerced to
 * "uncapped": the old fail-open coercion turned a typo in the cap box into
 * unlimited sends for that identity.
 */
export function validateIdentityCap(value: unknown, where: string): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  throw new SetupValidationError(
    `invalid maxPerDay ${JSON.stringify(value)} for ${where} — must be a whole number of sends per day (0 or more), or null for no cap`,
  );
}

export async function setup(req: Request): Promise<Response> {
  const body = (await req.json()) as SetupRequest;
  try {
    applySetup(body);
  } catch (err) {
    if (err instanceof SetupValidationError) {
      return jsonResponse({ error: err.message }, 400, req);
    }
    throw err;
  }
  return jsonResponse({ ok: true }, 200, req);
}

/**
 * Validate everything first, then write. A SetupValidationError thrown from
 * any check below leaves config.json, the identity pool and .env exactly as
 * they were — a partial write behind a 400 would make the 400 a lie.
 */
function applySetup(body: SetupRequest): void {
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
  for (const add of adds) {
    if ("maxPerDay" in add && add.maxPerDay !== undefined) {
      const where = add.provider === "smartlead" ? add.address : add.sendingDomain;
      validateIdentityCap(add.maxPerDay, `new ${add.provider} sender ${where}`);
    }
  }

  // Identity-pool edits (cap changes / removals). The first edit materializes
  // the pool from legacy config so the change has somewhere to persist.
  let emailIdentities = current.emailIdentities;
  const hasIdentityEdits =
    (body.identityUpdates?.length ?? 0) > 0 || (body.removeIdentityIds?.length ?? 0) > 0;
  const remove = new Set(body.removeIdentityIds ?? []);
  if (hasIdentityEdits) {
    let pool: EmailIdentity[] = current.emailIdentities ?? resolveIdentities(current);
    for (const upd of body.identityUpdates ?? []) {
      const cap = validateIdentityCap(upd.maxPerDay, upd.id);
      pool = pool.map((i) => (i.id === upd.id ? { ...i, maxPerDay: cap } : i));
    }
    if (remove.size > 0) pool = pool.filter((i) => !remove.has(i.id));
    emailIdentities = pool;
  }

  // clientId is preserved from current — body.clientId is intentionally
  // ignored so a malicious or accidental web POST can't rotate the anonymous
  // install id. saveConfig writes the entire cfg, so omitting clientId here
  // would silently drop it from disk.
  // mergeSetupConfig is the last validator (ceiling, time zone): nothing
  // below this line runs if it throws.
  const merged = mergeSetupConfig(current, body, emailIdentities, llmProvider, walletMode);
  saveConfig(merged);

  for (const id of remove) {
    try {
      deleteGmailToken(id);
    } catch {
      // token-store cleanup is best-effort; the identity is gone either way.
    }
  }

  // Adds run AFTER the main saveConfig: registerOneShotIdentity reloads the
  // freshly-persisted config (so it sees the cap/removal edits above and any
  // legacy-pool materialization) before appending. Validated already.
  for (const add of adds) {
    if (add.provider === "smartlead") {
      if (!add.address?.trim()) continue;
      registerSmartleadIdentity({
        address: add.address,
        label: add.label,
        ...("maxPerDay" in add ? { maxPerDay: add.maxPerDay ?? null } : {}),
        providerMessagePerDay: add.providerMessagePerDay ?? null,
      });
      continue;
    }
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
}

export function mergeSetupConfig(
  current: OneShotConfig,
  body: SetupRequest,
  emailIdentities: EmailIdentity[] | null,
  llmProvider: LlmProvider = body.llmProvider ?? current.llmProvider,
  walletMode: WalletMode = body.walletMode ?? current.walletMode,
): OneShotConfig {
  return {
    ...current,
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
    founderCredentials: mergeString(body.founderCredentials, current.founderCredentials),
    productPortfolio: mergeString(body.productPortfolio, current.productPortfolio),
    partners: mergeString(body.partners, current.partners),
    founderAdmission: mergeString(body.founderAdmission, current.founderAdmission),
    productBrief: mergeString(body.productBrief, current.productBrief),
    mobileSignature: body.mobileSignature ?? current.mobileSignature,
    queueReviewOrder:
      body.queueReviewOrder === "ranked" || body.queueReviewOrder === "newest"
        ? body.queueReviewOrder
        : current.queueReviewOrder,
    timezone: mergeTimeZone(body.timezone, current.timezone),
    dailySpendCeilingUsd:
      body.dailySpendCeilingUsd === undefined
        ? current.dailySpendCeilingUsd
        : validateSpendCeiling(body.dailySpendCeilingUsd),
  };
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

/**
 * Same validation the CLI path (`configSpendCeiling`) already enforces
 * before persisting the daily USD spend ceiling — `null` clears it back to
 * unlimited, anything else must be a positive finite number. Without this,
 * a direct API client (or a founder typing/submitting 0 in the /setup form,
 * whose `<Input type="number" min="0">` doesn't stop 0) could persist a
 * ceiling of 0, negative, or NaN. A ceiling of 0 makes
 * `effectiveUsd (0) >= ceilingUsd (0)` true immediately with zero spend —
 * silently halting every scheduled finder, run-now, and automatic drain
 * install-wide, the opposite of the unlimited default this feature ships.
 */
function validateSpendCeiling(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value <= 0) {
    throw new SetupValidationError(
      `invalid dailySpendCeilingUsd '${value}' — must be a positive number of USD, or null to clear`,
    );
  }
  return value;
}

/**
 * Time zone merge: undefined keeps the stored zone, null/blank clears it back
 * to the runtime default (installTimeZone in core), anything else must be an
 * IANA name Intl recognises — "Mars/Olympus" is a 400, not a saved string that
 * later makes every Luma slot resolve to UTC.
 */
function mergeTimeZone(incoming: string | null | undefined, current: string | null): string | null {
  if (incoming === undefined) return current;
  if (incoming === null || incoming.trim().length === 0) return null;
  const zone = incoming.trim();
  if (!isValidTimeZone(zone)) {
    throw new SetupValidationError(
      `invalid timezone '${zone}' — must be an IANA zone such as Europe/Vienna, or blank to use this machine's zone`,
    );
  }
  return zone;
}
