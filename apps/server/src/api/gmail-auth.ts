import { randomUUID } from "node:crypto";
import {
  _resetGmailCache,
  exchangeGmailAuthCode,
  getGmailProfile,
  gmailConsentUrl,
  registerGmailIdentity,
} from "@oneshot-gtm/core";
import { jsonResponse } from "../server.ts";

/**
 * Browser variant of `oneshot-gtm gmail auth`: /setup's "Connect Gmail"
 * button navigates to /start, Google consent redirects back to /callback on
 * this same local server, and the founder lands back on /setup with the
 * outcome in a query param. Server is loopback-only, so the redirect URI is
 * always a 127.0.0.1/localhost origin — valid for Desktop-type OAuth clients.
 */

const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map<string, { createdAt: number; redirectUri: string }>();

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
  const redirectUri = `${url.origin}/api/gmail/auth/callback`;
  const state = randomUUID();
  pendingStates.set(state, { createdAt: Date.now(), redirectUri });
  return Response.redirect(gmailConsentUrl({ clientId: creds.clientId, redirectUri, state }), 302);
}

export async function gmailAuthCallbackRoute(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const backToSetup = (outcome: string): Response =>
    Response.redirect(`${url.origin}/setup?gmailAuth=${encodeURIComponent(outcome)}`, 302);

  const consentError = url.searchParams.get("error");
  if (consentError) return backToSetup(`error:${consentError}`);

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
    const refreshToken = await exchangeGmailAuthCode({
      code,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      redirectUri: pending.redirectUri,
    });
    // Resolve which account consented BEFORE registering, so the identity id
    // is the real address, not a guess. Throwaway cache key, cleared after.
    _resetGmailCache();
    const { emailAddress } = await getGmailProfile({ id: "web-auth-pending", refreshToken });
    _resetGmailCache();
    registerGmailIdentity({ address: emailAddress, refreshToken });
    return backToSetup(`ok:${emailAddress}`);
  } catch (err) {
    return backToSetup(`error:${((err as Error).message ?? "token exchange failed").slice(0, 140)}`);
  }
}
