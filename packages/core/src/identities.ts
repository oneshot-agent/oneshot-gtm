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
 * The active sender pool. `emailIdentities` set → returned verbatim. Null =
 * legacy single-identity mode: synthesize one identity from the pre-rotation
 * fields. Legacy identities stay uncapped — capping would silently stall sends.
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
 * Persist a freshly authorized Gmail account (token → chmod-600 store,
 * identity → pool). The legacy pool is materialized first so existing prospect
 * pins survive; re-auth only refreshes the token, tuned caps are left alone.
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
 * Add a Smartlead-connected mailbox to the pool. No per-identity credential —
 * sends use the workspace-wide SMARTLEAD_API_KEY and pin From by address.
 * Default ramp is clamped to Smartlead's own `message_per_day` when given; an
 * explicit `maxPerDay` (incl. null = uncapped) is respected as-is. Re-add = no-op.
 */
export function registerSmartleadIdentity(input: {
  address: string;
  label?: string | null;
  maxPerDay?: number | null;
  /** Smartlead's per-mailbox message_per_day, from the accounts listing. */
  providerMessagePerDay?: number | null;
}): { identityId: string; created: boolean } {
  const address = input.address.trim().toLowerCase();
  if (!address) throw new Error("smartlead identity needs an address");
  const identityId = `smartlead:${address}`;
  const cfg = loadConfig();
  const pool: EmailIdentity[] = cfg.emailIdentities
    ? [...cfg.emailIdentities]
    : resolveIdentities(cfg);
  if (pool.some((i) => i.id === identityId)) return { identityId, created: false };
  let caps: Pick<EmailIdentity, "maxPerDay" | "warmup">;
  if ("maxPerDay" in input) {
    const maxPerDay = input.maxPerDay ?? null;
    // Explicit ceiling keeps the ramp toward it; explicit null = truly
    // uncapped, so the ramp is cleared too (warmupCap would re-impose 50).
    caps =
      maxPerDay == null ? { maxPerDay: null, warmup: null } : { ...WARMUP_DEFAULTS, maxPerDay };
  } else {
    const provider = input.providerMessagePerDay;
    const ceiling =
      typeof provider === "number" && Number.isFinite(provider) && provider > 0
        ? Math.min(WARMUP_DEFAULTS.maxPerDay ?? provider, provider)
        : WARMUP_DEFAULTS.maxPerDay;
    caps = { ...WARMUP_DEFAULTS, maxPerDay: ceiling };
  }
  pool.push({
    id: identityId,
    provider: "smartlead",
    label: input.label?.trim() || address,
    address,
    ...caps,
  });
  saveConfig({ ...cfg, emailIdentities: pool });
  return { identityId, created: true };
}

/**
 * Founder-name-derived default local-part, fallback "agent". Mirrors
 * `fromLocalpart` in oneshot.ts; duplicated here to avoid an import cycle.
 */
function defaultMailbox(founderName: string | null): string {
  const first = normalizeMailbox((founderName ?? "").trim().split(/\s+/)[0] ?? "");
  return first.length > 0 ? first : "agent";
}

/**
 * Add a OneShot sending identity (wallet-owned domain + mailbox local-part) to
 * the pool. Same invariants as the Gmail path: legacy pool materialized on
 * first add, duplicate id = no-op. `sendingDomain` is NOT validated here —
 * callers check against `listSendingDomains()`. Caps: neither field → default
 * ramp; `maxPerDay: n` → ceiling with ramp; `maxPerDay: null` → uncapped AND
 * warmup cleared (a ramp would re-impose 50); explicit `warmup` always wins.
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
 * Drop an identity from the pool (legacy pool materialized first). NOTE:
 * prospects pinned to this id refuse to send until it's restored —
 * `resolveSenderIdentity` surfaces that loudly by design.
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
 * Refresh token for a gmail identity (gmail-tokens.json, keyed by id). ONLY
 * the legacy synthetic identity may fall back to GMAIL_REFRESH_TOKEN — a
 * general fallback could switch a thread's From address mid-conversation.
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
