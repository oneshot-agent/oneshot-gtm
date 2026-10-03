import { loadConfig, saveConfig } from "./config.ts";
import { resolveIdentities } from "./identities.ts";
import {
  MailboxLookupError,
  mailboxConnection,
  mailboxConnectionForAddress,
} from "./mailbox-config.ts";
import type { EmailIdentity } from "./types.ts";

export type SendVia = NonNullable<EmailIdentity["sendVia"]>;

export function parseSendVia(raw: unknown): SendVia {
  if (raw === "provider" || raw === "smtp") return raw;
  throw new Error(`sendVia must be "provider" or "smtp" (got ${JSON.stringify(raw)})`);
}

/**
 * Check that `identityId` can send via `sendVia`. `smtp` is for Smartlead
 * mailboxes only, and their direct SMTP + IMAP credentials must resolve now:
 * a mailbox that cannot be reached directly is refused here rather than
 * failing every send later. `provider` is always allowed. Returns the SMTP
 * host for the caller to show.
 */
export async function validateSendVia(
  identityId: string,
  sendVia: SendVia,
): Promise<{ smtpHost: string | null }> {
  const identity = resolveIdentities(loadConfig()).find((i) => i.id === identityId);
  if (!identity) throw new Error(`No identity '${identityId}' in the pool.`);
  if (sendVia === "provider") return { smtpHost: null };
  if (identity.provider !== "smartlead") {
    throw new Error(
      `'${identityId}' is a ${identity.provider} identity; sendVia smtp is for Smartlead mailboxes.`,
    );
  }
  const connection = await mailboxConnection(identityId);
  return { smtpHost: connection.smtp.host };
}

/**
 * Validate, then persist `sendVia` on one identity (the legacy pool is
 * materialized first, as for other identity edits). The id is unchanged, so
 * pins, caps and warm-up carry on. `provider` drops the field (the default).
 */
export async function setIdentitySendVia(
  identityId: string,
  sendVia: SendVia,
): Promise<{ changed: boolean; smtpHost: string | null }> {
  const { smtpHost } = await validateSendVia(identityId, sendVia);
  const cfg = loadConfig();
  const pool = cfg.emailIdentities ?? resolveIdentities(cfg);
  const current = pool.find((i) => i.id === identityId);
  if (!current) throw new Error(`No identity '${identityId}' in the pool.`);
  if ((current.sendVia ?? "provider") === sendVia) return { changed: false, smtpHost };
  saveConfig({
    ...cfg,
    emailIdentities: pool.map((i) => (i.id === identityId ? withSendVia(i, sendVia) : i)),
  });
  return { changed: true, smtpHost };
}

/**
 * The send path a NEW Smartlead mailbox starts on: direct SMTP (keyed,
 * duplicate-protected) when its IMAP + SMTP credentials resolve now, else
 * the Smartlead API, with the reason to show. `lookupFailed` = the Smartlead
 * account listing could not be read at all (an outage, not missing
 * credentials), so a caller can ask for a retry instead. Only registration
 * calls this; an existing identity's send path is never changed by it.
 */
export async function defaultSendViaForSmartlead(
  address: string,
): Promise<{ sendVia: SendVia; reason: string | null; lookupFailed: boolean }> {
  try {
    await mailboxConnectionForAddress(address);
    return { sendVia: "smtp", reason: null, lookupFailed: false };
  } catch (err) {
    return {
      sendVia: "provider",
      reason: (err as Error).message,
      lookupFailed: err instanceof MailboxLookupError,
    };
  }
}

export function withSendVia(identity: EmailIdentity, sendVia: SendVia): EmailIdentity {
  const { sendVia: _drop, ...rest } = identity;
  void _drop;
  return sendVia === "smtp" ? { ...rest, sendVia } : rest;
}
