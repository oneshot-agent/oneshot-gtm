import { normalizeWebsite } from "@oneshot-gtm/shared-types";
import { aiFingerprint, invalidateOnboardingAI } from "./onboarding.ts";
import {
  deleteGmailToken,
  hasCalendarScope,
  identityCapacities,
  isValidTimeZone,
  listSendingDomains,
  loadConfig,
  loadGmailTokens,
  parseSendVia,
  registerOneShotIdentity,
  registerSmartleadIdentity,
  resolveIdentities,
  saveConfig,
  saveSecrets,
  secretSource,
  secretsPath,
  validateSendVia,
  withDeadline,
  withSendVia,
  type DomainPoolEntry,
  type EmailIdentity,
  type OneShotConfig,
  isSlackWebhookUrl,
} from "@oneshot-gtm/core";
import type {
  DomainPoolView,
  LlmProvider,
  SenderIdentityView,
  SetupRequest,
  WalletMode,
} from "@oneshot-gtm/shared-types";
import {
  connectLinkedInWithCookie,
  finishLinkedInLogin,
  startLinkedInLogin,
  type LinkedInSessionResult,
  cancelLinkedInLogin,
  linkedinLoginState,
} from "@oneshot-gtm/find";
import { jsonResponse } from "../server.ts";

/** Keep clientId local: strip it from responses so browser updates cannot clobber it. */
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
  const tokens = loadGmailTokens();
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
      sendVia: i.provider === "smartlead" ? (i.sendVia ?? "provider") : null,
      sentToday: cap?.identitySentToday ?? 0,
      domainSentToday: cap?.domainSentToday ?? 0,
      capToday: cap && Number.isFinite(cap.capToday) ? cap.capToday : null,
      legacy,
      hasCalendarScope: i.provider === "gmail" ? hasCalendarScope(tokens[i.id] ?? null) : null,
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
 * Bound the setup status wait: listDomains can take 60-80s. The sender picker
 * fetches the full list separately through /api/setup/domains.
 */
const SETUP_STATUS_DOMAINS_DEADLINE_MS = 2_500;
/** The dedicated domain-list route can wait longer; it's off the page's critical path. */
const SETUP_DOMAINS_DEADLINE_MS = 45_000;

/** A pool this old is served immediately but refreshed in the background. */
const DOMAIN_CACHE_FRESH_MS = 60_000;

/**
 * The last pool the platform returned, shared by both routes. `[]` is never
 * cached. It means "unknown", and a later real answer must replace it. One
 * underlying `listSendingDomains()` is shared between concurrent callers, and
 * it keeps running after a caller's deadline fires, so a status call that
 * gave up at 2.5s still fills the cache for the next load.
 */
let domainCache: { views: DomainPoolView[]; at: number } | null = null;
let domainInflight: Promise<DomainPoolView[]> | null = null;
/** When the platform last answered empty (or failed): "unknown", not cached, but not re-asked on every page load either. */
let lastEmptyAt = 0;

/** Test seam: forget the cached pool between cases. */
export function resetDomainCacheForTests(): void {
  domainCache = null;
  domainInflight = null;
  lastEmptyAt = 0;
}

function refreshDomainViews(): Promise<DomainPoolView[]> {
  if (domainInflight) return domainInflight;
  const p = listSendingDomains()
    .then((entries) => {
      const views = domainViews(entries);
      if (views.length > 0) domainCache = { views, at: Date.now() };
      else lastEmptyAt = Date.now();
      return views;
    })
    .catch((err: unknown) => {
      lastEmptyAt = Date.now();
      throw err;
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
 * is none, so the setup page always renders. A missing domain list degrades
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
 * Serve cached pools immediately and refresh stale ones in the background.
 * Only the first cold-cache caller waits; later callers get [] while the fetch
 * is in flight or for one minute after an empty response.
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
  if (domainInflight) return [];
  if (Date.now() - lastEmptyAt < DOMAIN_CACHE_FRESH_MS) return [];
  return provisionedDomainViews(SETUP_STATUS_DOMAINS_DEADLINE_MS);
}

/** GET /api/setup/domains. The provisioned pool alone, for the sender picker. */
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
        X_API_KEY: secretSource("X_API_KEY"),
        X_API_SECRET: secretSource("X_API_SECRET"),
        X_ACCESS_TOKEN: secretSource("X_ACCESS_TOKEN"),
        X_ACCESS_SECRET: secretSource("X_ACCESS_SECRET"),
        TWITTERAPI_IO_KEY: secretSource("TWITTERAPI_IO_KEY"),
        GITHUB_TOKEN: secretSource("GITHUB_TOKEN"),
        LUMA_SESSION_COOKIE: secretSource("LUMA_SESSION_COOKIE"),
        LINKEDIN_SESSION_COOKIE: secretSource("LINKEDIN_SESSION_COOKIE"),
      },
    },
    200,
    req,
  );
}

/**
 * The three LinkedIn connect routes. Two ways in, one outcome shape:
 *  - POST /api/setup/linkedin-login/start: open a hosted browser on the
 *    LinkedIn login page in a fresh OneShot browser profile and return its
 *    live URL (a credential: shown to the founder, never logged);
 *  - POST /api/setup/linkedin-login/finish: save the logged-in state into
 *    the profile and verify it;
 *  - POST /api/setup/linkedin-session: import the stored `li_at`
 *    cookie into a fresh profile and verify it (no browser login needed).
 * The cookie never appears in a response or a log; only the outcome does.
 */
function sessionResponse(result: LinkedInSessionResult, req: Request): Response {
  return jsonResponse(
    {
      ok: true,
      loggedIn: result.loggedIn,
      name: result.name,
      profileId: result.profileId,
      costUsd: result.costUsd,
      reason: result.reason ?? null,
      checkedAt: new Date().toISOString(),
    },
    200,
    req,
  );
}

function platformFailure(err: unknown, req: Request): Response {
  const message = ((err as Error).message ?? "connect failed").slice(0, 300);
  return jsonResponse({ error: message }, 502, req);
}

export async function linkedinSessionRoute(req: Request): Promise<Response> {
  if (!secretSource("LINKEDIN_SESSION_COOKIE")) {
    return jsonResponse(
      { error: "paste the LinkedIn session cookie (li_at) first, or log in with LinkedIn instead" },
      400,
      req,
    );
  }
  try {
    const result = await connectLinkedInWithCookie({
      playName: "setup",
      memo: "connect linkedin session (cookie)",
    });
    return sessionResponse(result, req);
  } catch (err) {
    return platformFailure(err, req);
  }
}

export async function linkedinLoginStartRoute(req: Request): Promise<Response> {
  try {
    const started = await startLinkedInLogin({
      playName: "setup",
      memo: "connect linkedin session (login)",
    });
    return jsonResponse(
      {
        ok: true,
        profileId: started.profileId,
        liveUrl: started.liveUrl,
        status: started.status,
        expiresAt: started.expiresAt,
      },
      200,
      req,
    );
  } catch (err) {
    return platformFailure(err, req);
  }
}

export async function linkedinLoginCancelRoute(req: Request): Promise<Response> {
  try {
    const out = await cancelLinkedInLogin({ playName: "setup", memo: "cancel linkedin login" });
    return jsonResponse({ ok: true, ...out }, 200, req);
  } catch (err) {
    return platformFailure(err, req);
  }
}

export async function linkedinLoginStateRoute(req: Request): Promise<Response> {
  try {
    const out = await linkedinLoginState({ playName: "setup", memo: "linkedin login state" });
    return jsonResponse({ ok: true, ...out }, 200, req);
  } catch (err) {
    return platformFailure(err, req);
  }
}

export async function linkedinLoginFinishRoute(req: Request): Promise<Response> {
  try {
    const result = await finishLinkedInLogin({
      playName: "setup",
      memo: "connect linkedin session (login)",
    });
    return sessionResponse(result, req);
  } catch (err) {
    return platformFailure(err, req);
  }
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
 * Accept null (uncapped) or a finite non-negative number (floored). Reject all
 * other values so malformed caps cannot silently permit unlimited sends.
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
    await validateSendViaUpdates(body);
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
 * `sendVia` edits need a network check (the mailbox's SMTP + IMAP credentials
 * must resolve), so they are validated here, before the synchronous apply.
 */
async function validateSendViaUpdates(body: SetupRequest): Promise<void> {
  for (const upd of body.identityUpdates ?? []) {
    if (upd.sendVia === undefined) continue;
    try {
      await validateSendVia(upd.id, parseSendVia(upd.sendVia));
    } catch (err) {
      throw new SetupValidationError(`${upd.id}: ${(err as Error).message}`);
    }
  }
}

/**
 * Validate before writing so a 400 leaves config, identity pool, and .env unchanged.
 */
function applySetup(body: SetupRequest): void {
  if (body.onboardingStep === 1) {
    if (!body.founderName?.trim() || !body.productOneLiner?.trim())
      throw new SetupValidationError("Enter your name and product description.");
    const domain = normalizeWebsite(body.productDomain ?? "");
    if (!domain) throw new SetupValidationError("Enter a website domain or HTTP(S) URL.");
    body.productDomain = domain;
  }
  if (body.onboardingStep === 2 && !body.icpOneLiner?.trim())
    throw new SetupValidationError("Describe your target customer.");
  if (
    body.onboardingStep === 3 &&
    (!["openrouter", "openai", "anthropic"].includes(body.llmProvider ?? "") ||
      !body.llmModel?.trim())
  )
    throw new SetupValidationError("Select a provider and model.");
  const current = loadConfig();
  const llmProvider: LlmProvider = body.llmProvider ?? current.llmProvider;
  const walletMode: WalletMode = body.walletMode ?? current.walletMode;

  // New domains are valid: pinned sends auto-provision them on first use.
  // Pinned sends bypass platform warmup gating, so new identities default to
  // the client-side warmup ramp for deliverability.
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
      if (upd.maxPerDay !== undefined) {
        const cap = validateIdentityCap(upd.maxPerDay, upd.id);
        pool = pool.map((i) => (i.id === upd.id ? { ...i, maxPerDay: cap } : i));
      }
      if (upd.sendVia !== undefined) {
        const sendVia = parseSendVia(upd.sendVia);
        pool = pool.map((i) => (i.id === upd.id ? withSendVia(i, sendVia) : i));
      }
    }
    if (remove.size > 0) pool = pool.filter((i) => !remove.has(i.id));
    emailIdentities = pool;
  }

  // clientId is preserved from current: body.clientId is intentionally
  // ignored so a malicious or accidental web POST can't rotate the anonymous
  // install id. saveConfig writes the entire cfg, so omitting clientId here
  // would silently drop it from disk.
  // mergeSetupConfig is the last validator (ceiling, time zone): nothing
  // below this line runs if it throws.
  const merged = mergeSetupConfig(current, body, emailIdentities, llmProvider, walletMode);

  // A calendarIdentityId must point at a Gmail identity actually in the pool
  // (post-edits): refusing here is much cheaper than a scheduler tick
  // discovering it can't find the identity every 10 minutes forever.
  if (body.calendarIdentityId !== undefined && body.calendarIdentityId !== null) {
    const pool = merged.emailIdentities ?? resolveIdentities(merged);
    const identity = pool.find((i) => i.id === body.calendarIdentityId);
    if (!identity || identity.provider !== "gmail") {
      throw new SetupValidationError(
        `calendarIdentityId '${body.calendarIdentityId}' is not a connected Gmail identity`,
      );
    }
  }

  const previousAI = aiFingerprint();
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
  if (previousAI !== aiFingerprint()) invalidateOnboardingAI();
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
    founderCohort: mergeString(body.founderCohort, current.founderCohort ?? null),
    founderAdmission: mergeString(body.founderAdmission, current.founderAdmission),
    productBrief: mergeString(body.productBrief, current.productBrief),
    // Optional field: absent on both sides stays absent, so a body that does
    // not touch it re-saves the config byte-identical.
    ...(body.founderVoice !== undefined || current.founderVoice !== undefined
      ? { founderVoice: mergeString(body.founderVoice, current.founderVoice ?? null) }
      : {}),
    mobileSignature: body.mobileSignature ?? current.mobileSignature,
    slackWebhookUrl: mergeSlackWebhookUrl(body.slackWebhookUrl, current.slackWebhookUrl),
    queueReviewOrder:
      body.queueReviewOrder === "ranked" || body.queueReviewOrder === "newest"
        ? body.queueReviewOrder
        : current.queueReviewOrder,
    // Optional field: absent on both sides stays absent.
    ...(body.replyClassifier !== undefined || current.replyClassifier !== undefined
      ? {
          replyClassifier:
            body.replyClassifier === undefined
              ? current.replyClassifier
              : validateReplyClassifier(body.replyClassifier),
        }
      : {}),
    timezone: mergeTimeZone(body.timezone, current.timezone),
    dailySpendCeilingUsd:
      body.dailySpendCeilingUsd === undefined
        ? current.dailySpendCeilingUsd
        : validateSpendCeiling(body.dailySpendCeilingUsd),
    calendarIdentityId:
      body.calendarIdentityId === undefined ? current.calendarIdentityId : body.calendarIdentityId,
    calendarId:
      body.calendarId === undefined ? current.calendarId : body.calendarId.trim() || "primary",
  };
}

/**
 * Merge a form-submitted string into the stored config:
 *   undefined → keep existing (caller didn't touch the field)
 *   ""        → clear (caller deliberately emptied the field)
 *   non-empty → trim + save
 */
/**
 * Same merge as `mergeString`, but a non-empty value must be a real Slack
 * incoming-webhook URL. The server POSTs reply/bounce/summary data to it, so
 * an arbitrary destination is a data-exfiltration hole, not a typo.
 */
function mergeSlackWebhookUrl(incoming: string | undefined, current: string | null): string | null {
  const merged = mergeString(incoming, current);
  if (incoming !== undefined && merged != null && !isSlackWebhookUrl(merged)) {
    throw new SetupValidationError(
      "slackWebhookUrl must be a Slack incoming-webhook URL (https://hooks.slack.com/services/…)",
    );
  }
  return merged;
}

function mergeString(incoming: string | undefined, current: string | null): string | null {
  if (incoming === undefined) return current;
  const trimmed = incoming.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Same validation the CLI path (`configSpendCeiling`) already enforces
 * before persisting the daily USD spend ceiling: `null` clears it back to
 * unlimited, anything else must be a positive finite number. Without this,
 * a direct API client (or a founder typing/submitting 0 in the /setup form,
 * whose `<Input type="number" min="0">` doesn't stop 0) could persist a
 * ceiling of 0, negative, or NaN. A ceiling of 0 makes
 * `effectiveUsd (0) >= ceilingUsd (0)` true immediately with zero spend:
 * silently halting every scheduled finder, run-now, and automatic drain
 * install-wide, the opposite of the unlimited default this feature ships.
 */
/**
 * Reply-classifier merge: null clears back to the default (`llm`, stored as
 * absent). `decisions` without a model would silently fall back on every
 * reply, so it's a 400, as is a confidence threshold outside 0–1.
 */
export function validateReplyClassifier(
  value: SetupRequest["replyClassifier"],
): OneShotConfig["replyClassifier"] {
  if (value === null || value === undefined) return undefined;
  if (value.engine !== "llm" && value.engine !== "decisions") {
    throw new SetupValidationError(
      `invalid replyClassifier.engine '${String(value.engine)}' — must be "llm" or "decisions"`,
    );
  }
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (value.engine === "decisions" && !model) {
    throw new SetupValidationError(`replyClassifier.engine "decisions" needs a model`);
  }
  if (
    value.minConfidence !== undefined &&
    (typeof value.minConfidence !== "number" ||
      !Number.isFinite(value.minConfidence) ||
      value.minConfidence < 0 ||
      value.minConfidence > 1)
  ) {
    throw new SetupValidationError(
      `invalid replyClassifier.minConfidence '${String(value.minConfidence)}' — must be a number from 0 to 1`,
    );
  }
  return {
    engine: value.engine,
    ...(model ? { model } : {}),
    ...(value.minConfidence !== undefined ? { minConfidence: value.minConfidence } : {}),
  };
}

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
 * IANA name Intl recognises: "Mars/Olympus" is a 400, not a saved string that
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
