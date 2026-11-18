import { randomUUID } from "node:crypto";
import {
  _resetGmailCache,
  exchangeGmailAuthCode,
  getGmailProfile,
  gmailConsentUrl,
  registerGmailIdentity,
  saveGmailToken,
} from "@oneshot-gtm/core";
import { isLoopbackOrigin, jsonResponse } from "../server.ts";
import { isAllowedHostOrigin } from "../members.ts";

/**
 * Browser variant of `oneshot-gtm gmail auth`: /setup's "Connect Gmail"
 * button navigates to /start, Google consent redirects back to /callback on
 * this same server, and the member lands back on /setup with the
 * outcome in a query param. Opened on the host machine, the redirect URI is
 * a 127.0.0.1/localhost origin: valid for Desktop-type OAuth clients. A
 * member on an allowed non-loopback host needs a Web client with this exact
 * callback URI registered (docs/members.md).
 */

const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map<
  string,
  { createdAt: number; redirectUri: string; purpose: "send" | "calendar" }
>();

function prune(): void {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [state, entry] of pendingStates) {
    if (entry.createdAt < cutoff) pendingStates.delete(state);
  }
}

function clientCreds(): { clientId: string; clientSecret: string } | null {
  const clientId = (process.env["GMAIL_CLIENT_ID"] ?? "").trim();
  const clientSecret = (process.env["GMAIL_CLIENT_SECRET"] ?? "").trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function authOrigin(req: Request): string {
  const url = new URL(req.url);
  // The member gate has already authenticated the request. Tailscale
  // preserves Host but terminates TLS before forwarding to this HTTP server.
  // Never take a replacement host from forwarding headers or alter loopback.
  if (isAllowedHostOrigin(url.origin) && req.headers.get("x-forwarded-proto") === "https") {
    url.protocol = "https:";
  }
  return url.origin;
}

export function startGmailAuthRoute(req: Request): Response {
  const creds = clientCreds();
  if (!creds) {
    return jsonResponse(
      { error: "GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not set — save them in /setup first" },
      409,
      req,
    );
  }
  prune();
  const url = new URL(req.url);
  const redirectUri = `${authOrigin(req)}/api/gmail/auth/callback`;
  const state = randomUUID();
  // `?purpose=calendar` (used by the /setup calendar picker's "Connect a
  // calendar-only mailbox" affordance): a mailbox connected purely to read
  // its calendar must NOT silently enrol as a sender (issue #577): see
  // registerGmailIdentity's `calendarOnly` handling. Anything else defaults
  // to the ordinary sending purpose.
  const purpose = url.searchParams.get("purpose") === "calendar" ? "calendar" : "send";
  pendingStates.set(state, { createdAt: Date.now(), redirectUri, purpose });
  return Response.redirect(gmailConsentUrl({ clientId: creds.clientId, redirectUri, state }), 302);
}

export async function gmailAuthCallbackRoute(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const origin = authOrigin(req);
  const backToSetup = (outcome: string): Response =>
    Response.redirect(`${origin}/setup?gmailAuth=${encodeURIComponent(outcome)}`, 302);
  const authError = (message: string): Response => {
    if (
      !isLoopbackOrigin(origin) &&
      /redirect_uri_mismatch|redirect[^\n]*\b(?:rejected|mismatch|loopback)\b|loopback[^\n]*redirect/i.test(
        message,
      )
    ) {
      return backToSetup(
        `error:Google rejected the Gmail redirect. Add ${origin}/api/gmail/auth/callback to a Google Cloud Web application OAuth client's Authorized redirect URIs, save that Web client's ID and secret in Setup → Credentials, then retry. A Desktop client cannot use this address.`,
      );
    }
    return backToSetup(`error:${message.slice(0, 140)}`);
  };

  const consentError = url.searchParams.get("error");
  if (consentError) {
    // Preserve loopback's existing error text. Remote invalid_request errors
    // carry the Desktop client's loopback restriction in error_description.
    if (isLoopbackOrigin(origin)) return backToSetup(`error:${consentError}`);
    return authError(
      consentError === "invalid_request"
        ? `${consentError}: ${url.searchParams.get("error_description") ?? ""}`
        : consentError,
    );
  }

  const state = url.searchParams.get("state") ?? "";
  const pending = pendingStates.get(state);
  pendingStates.delete(state);
  if (!pending || Date.now() - pending.createdAt > STATE_TTL_MS) {
    return backToSetup("error:state mismatch or expired — retry");
  }
  const code = url.searchParams.get("code");
  if (!code) return backToSetup("error:no code in callback");
  const creds = clientCreds();
  if (!creds) return backToSetup("error:client credentials missing");

  try {
    const exchanged = await exchangeGmailAuthCode({
      code,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      redirectUri: pending.redirectUri,
    });
    // Resolve which account consented BEFORE registering, so the identity id
    // is the real address, not a guess. Throwaway cache key, cleared after.
    _resetGmailCache();
    const { emailAddress } = await getGmailProfile({
      id: "web-auth-pending",
      refreshToken: exchanged.refreshToken,
    });
    _resetGmailCache();
    const { identityId } = registerGmailIdentity({
      address: emailAddress,
      refreshToken: exchanged.refreshToken,
      calendarOnly: pending.purpose === "calendar",
    });
    // registerGmailIdentity always writes the token via saveGmailToken
    // without a scope (it predates issue #577); overwrite with the scope
    // Google actually granted on THIS consent so doctor/setup can tell a
    // calendar-capable identity from a Gmail-only one.
    saveGmailToken(identityId, {
      refreshToken: exchanged.refreshToken,
      address: emailAddress,
      scope: exchanged.scope,
    });
    return backToSetup(`ok:${emailAddress}`);
  } catch (err) {
    return authError((err as Error).message ?? "token exchange failed");
  }
}
