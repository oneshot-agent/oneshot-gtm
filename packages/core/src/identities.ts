import { loadGmailTokens } from "./config.ts";
import type { EmailIdentity, OneShotConfig } from "./types.ts";

export const LEGACY_ONESHOT_ID = "legacy-oneshot";
export const LEGACY_GMAIL_ID = "legacy-gmail";

/** Warm-up defaults for a freshly added Gmail account: 10/day, +10/week, max 50. */
export const GMAIL_IDENTITY_DEFAULTS: Pick<EmailIdentity, "maxPerDay" | "warmup"> = {
  maxPerDay: 50,
  warmup: { startPerDay: 10, incrementPerWeek: 10 },
};

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
