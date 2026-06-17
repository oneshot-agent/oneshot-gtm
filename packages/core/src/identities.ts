import {
  deleteGmailToken,
  loadConfig,
  loadGmailTokens,
  saveConfig,
  saveGmailToken,
} from "./config.ts";
import type { EmailIdentity, OneShotConfig } from "./types.ts";

export const LEGACY_ONESHOT_ID = "legacy-oneshot";
export const LEGACY_GMAIL_ID = "legacy-gmail";

/**
 * Cold-start warm-up ramp for a freshly added sending identity: 10/day,
 * +10/week, capped at 50/day. Provider-agnostic — a brand-new Gmail account and
 * a brand-new OneShot domain/mailbox both start cold, so both ramp the same way.
 */
export const WARMUP_DEFAULTS: Pick<EmailIdentity, "maxPerDay" | "warmup"> = {
  maxPerDay: 50,
  warmup: { startPerDay: 10, incrementPerWeek: 10 },
};

/** @deprecated alias for {@link WARMUP_DEFAULTS}; kept for existing call sites. */
export const GMAIL_IDENTITY_DEFAULTS = WARMUP_DEFAULTS;

/**
 * Normalize an email local-part: lowercase, trim, strip anything that isn't
 * alphanumeric / dot / dash / underscore / plus. Returns "" when nothing usable
 * survives so callers can fall back to a founder-derived default.
 */
function normalizeMailbox(raw: string | null | undefined): string {
  return (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._+-]/g, "");
}

/**
 * The active sender pool. `emailIdentities` set → returned verbatim.
 * Null → legacy single-identity mode: synthesize one identity from the
 * pre-rotation fields (emailProvider + sendingDomain / env refresh token) so
 * existing installs behave exactly as before rotation existed. Legacy
 * identities are uncapped — capping them would silently stall sends on
 * installs that never opted into rotation.
 */
export function resolveIdentities(cfg: OneShotConfig): EmailIdentity[] {
  if (cfg.emailIdentities && cfg.emailIdentities.length > 0) return cfg.emailIdentities;
  if (cfg.emailProvider === "gmail") {
    return [
      {
        id: LEGACY_GMAIL_ID,
        provider: "gmail",
        label: "Gmail (legacy single-account mode)",
        maxPerDay: null,
        warmup: null,
      },
    ];
  }
  return [
    {
      id: LEGACY_ONESHOT_ID,
      provider: "oneshot",
      label: "OneShot (legacy mode)",
      sendingDomain: cfg.sendingDomain,
      maxPerDay: null,
      warmup: null,
    },
  ];
}

/**
 * Persist a freshly authorized Gmail account: refresh token into the
 * chmod-600 store, identity into the rotation pool with warm-up defaults.
 * Legacy installs get their synthesized identity persisted first so existing
 * prospects keep their original From address. Re-auth of a known account
 * only refreshes the token — tuned caps are left alone.
 */
export function registerGmailIdentity(input: { address: string; refreshToken: string }): {
  identityId: string;
  created: boolean;
} {
  const identityId = `gmail:${input.address.trim().toLowerCase()}`;
  saveGmailToken(identityId, { refreshToken: input.refreshToken, address: input.address });
  const cfg = loadConfig();
  const pool: EmailIdentity[] = cfg.emailIdentities
    ? [...cfg.emailIdentities]
    : resolveIdentities(cfg);
  if (pool.some((i) => i.id === identityId)) return { identityId, created: false };
  pool.push({
    id: identityId,
    provider: "gmail",
    label: input.address,
    address: input.address,
    ...WARMUP_DEFAULTS,
  });
  saveConfig({ ...cfg, emailIdentities: pool });
  return { identityId, created: true };
}

/**
 * Founder-name-derived default local-part (first token, normalized) — the
 * mailbox used when an OneShot identity is added without an explicit one. Falls
 * back to "agent". Mirrors `fromLocalpart` in oneshot.ts but lives here to keep
 * identities.ts free of an import cycle with the send layer.
 */
function defaultMailbox(founderName: string | null): string {
  const first = normalizeMailbox((founderName ?? "").trim().split(/\s+/)[0] ?? "");
  return first.length > 0 ? first : "agent";
}

/**
 * Add a OneShot sending identity (a wallet-owned domain + a mailbox local-part)
 * to the rotation pool. The OneShot analogue of `registerGmailIdentity`: there
 * was previously no way to put a second OneShot domain — or a second mailbox on
 * one domain — into the pool, only the single legacy `sendingDomain` config.
 *
 * Mirrors the Gmail path's invariants: the pool is materialized from legacy
 * config on first add (so existing prospect pins to the legacy sender survive),
 * and a duplicate id is a no-op. `sendingDomain` is NOT validated here against
 * the provisioned pool — callers (setup API / CLI) do that against
 * `listSendingDomains()` so this stays a pure persistence helper.
 *
 * Cap defaults, least-surprising:
 *  - neither field given → full cold-start ramp (10/day, +10/week, max 50).
 *  - `maxPerDay: <n>` → that hard ceiling, still ramping up to it (the ramp is
 *    kept unless the caller overrides `warmup`).
 *  - `maxPerDay: null` → truly uncapped — warmup is cleared too, since a ramp
 *    without a ceiling would itself re-impose one (warmupCap clamps to 50).
 *  - `warmup` always wins when explicitly provided.
 */
export function registerOneShotIdentity(input: {
  sendingDomain: string;
  mailbox?: string | null;
  label?: string | null;
  maxPerDay?: number | null;
  warmup?: EmailIdentity["warmup"];
}): { identityId: string; created: boolean } {
  const cfg = loadConfig();
  const sendingDomain = input.sendingDomain.trim().toLowerCase();
  if (!sendingDomain) throw new Error("sendingDomain is required to add a OneShot identity");
  const mailbox = normalizeMailbox(input.mailbox) || defaultMailbox(cfg.founderName);
  const identityId = `oneshot:${mailbox}@${sendingDomain}`;

  const pool: EmailIdentity[] = cfg.emailIdentities
    ? [...cfg.emailIdentities]
    : resolveIdentities(cfg);
  if (pool.some((i) => i.id === identityId)) return { identityId, created: false };

  let maxPerDay: number | null;
  let warmup: EmailIdentity["warmup"];
  if (!("maxPerDay" in input) && !("warmup" in input)) {
    ({ maxPerDay, warmup } = WARMUP_DEFAULTS);
  } else {
    maxPerDay = input.maxPerDay ?? null;
    warmup =
      "warmup" in input
        ? (input.warmup ?? null)
        : maxPerDay == null
          ? null // uncapped — don't let a default ramp silently re-cap at 50
          : WARMUP_DEFAULTS.warmup;
  }
  const caps: Pick<EmailIdentity, "maxPerDay" | "warmup"> = { maxPerDay, warmup };
  pool.push({
    id: identityId,
    provider: "oneshot",
    label: input.label?.trim() || `${mailbox}@${sendingDomain}`,
    sendingDomain,
    mailbox,
    ...caps,
  });
  saveConfig({ ...cfg, emailIdentities: pool });
  return { identityId, created: true };
}

/**
 * Drop an identity from the rotation pool. Materializes the pool from legacy
 * config first so a removal on a not-yet-persisted pool still takes effect.
 * Best-effort token cleanup for Gmail identities. Returns whether anything was
 * removed. NOTE: prospects already pinned to this id will refuse to send until
 * the id is restored — `resolveSenderIdentity` surfaces that loudly by design.
 */
export function removeIdentity(identityId: string): { removed: boolean } {
  const cfg = loadConfig();
  const pool = cfg.emailIdentities ?? resolveIdentities(cfg);
  const next = pool.filter((i) => i.id !== identityId);
  if (next.length === pool.length) return { removed: false };
  try {
    deleteGmailToken(identityId);
  } catch {
    // token-store cleanup is best-effort; the identity is gone either way.
  }
  saveConfig({ ...cfg, emailIdentities: next });
  return { removed: true };
}

/**
 * Refresh token for a gmail identity. Identities created by `gmail auth` live
 * in the gmail-tokens.json store keyed by identity id. ONLY the legacy
 * synthetic identity may fall back to the single GMAIL_REFRESH_TOKEN secret —
 * letting any identity fall back would silently send from whatever account
 * the env token belongs to when a store entry goes missing, switching a
 * thread's From address mid-conversation.
 */
export function gmailAccountFor(
  identity: EmailIdentity,
): { id: string; refreshToken: string } | null {
  if (identity.provider !== "gmail") return null;
  const stored = loadGmailTokens()[identity.id];
  if (stored?.refreshToken) return { id: identity.id, refreshToken: stored.refreshToken };
  if (identity.id === LEGACY_GMAIL_ID) {
    const legacy = (process.env["GMAIL_REFRESH_TOKEN"] ?? "").trim();
    if (legacy) return { id: identity.id, refreshToken: legacy };
  }
  return null;
}
