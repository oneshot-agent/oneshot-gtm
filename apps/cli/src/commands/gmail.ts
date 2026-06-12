import { randomUUID } from "node:crypto";
import {
  _resetGmailCache,
  getGmailProfile,
  GMAIL_IDENTITY_DEFAULTS,
  loadConfig,
  resolveIdentities,
  saveConfig,
  saveGmailToken,
  saveSecrets,
  secretsPath,
  type EmailIdentity,
} from "@oneshot-gtm/core";
import prompts from "prompts";
import { c, header, note, ok, warn } from "../output.ts";

const SCOPES = "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

function tryOpenBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // best-effort — the URL is printed either way.
  }
}

/**
 * OAuth consent flow for the Gmail send path: loopback redirect on an
 * ephemeral local port, then code → refresh-token exchange. The refresh token
 * is what `sendEmail`/`listInbox` use at runtime (gmail.ts); access tokens are
 * minted on demand from it.
 */
export async function commandGmailAuth(): Promise<void> {
  header("Authorize Gmail / Google Workspace");
  note("Needs a Google Cloud OAuth client (Desktop type) with the Gmail API enabled.");
  note("Console: https://console.cloud.google.com/apis/credentials");

  const answers = await prompts(
    [
      {
        type: "text",
        name: "clientId",
        message: "GMAIL_CLIENT_ID",
        initial: process.env["GMAIL_CLIENT_ID"] ?? "",
        validate: (v: string) => (v.trim().length > 0 ? true : "required"),
      },
      {
        type: "password",
        name: "clientSecret",
        message: process.env["GMAIL_CLIENT_SECRET"]
          ? "GMAIL_CLIENT_SECRET (blank = keep current)"
          : "GMAIL_CLIENT_SECRET",
      },
    ],
    { onCancel: () => process.exit(0) },
  );
  const clientId = (answers["clientId"] as string).trim();
  const clientSecret =
    ((answers["clientSecret"] as string) || "").trim() ||
    (process.env["GMAIL_CLIENT_SECRET"] ?? "").trim();
  if (!clientSecret) {
    warn("GMAIL_CLIENT_SECRET is required.");
    return;
  }

  const state = randomUUID();
  let resolveCode: (v: { code: string } | { error: string }) => void;
  const codePromise = new Promise<{ code: string } | { error: string }>((resolve) => {
    resolveCode = resolve;
  });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/") return new Response("not found", { status: 404 });
      const err = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const gotState = url.searchParams.get("state");
      if (err) resolveCode({ error: err });
      else if (gotState !== state) resolveCode({ error: "state mismatch — possible CSRF, retry" });
      else if (code) resolveCode({ code });
      else resolveCode({ error: "no code in callback" });
      return new Response(
        "<html><body style='font-family:sans-serif'><h3>oneshot-gtm</h3><p>You can close this tab and return to the terminal.</p></body></html>",
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });

  try {
    const redirectUri = `http://127.0.0.1:${server.port}`;
    const consentUrl = `${AUTH_URL}?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES,
      access_type: "offline",
      prompt: "consent",
      state,
    })}`;

    note(`Opening browser for consent — if it doesn't open, visit:\n  ${c.cyan(consentUrl)}`);
    tryOpenBrowser(consentUrl);

    const outcome = await Promise.race([
      codePromise,
      new Promise<{ error: string }>((resolve) =>
        setTimeout(() => resolve({ error: "timed out waiting for consent (5m)" }), AUTH_TIMEOUT_MS),
      ),
    ]);
    if ("error" in outcome) {
      warn(`Authorization failed: ${outcome.error}`);
      return;
    }

    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: outcome.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tokens = (await tokenRes.json()) as {
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!tokenRes.ok || !tokens.refresh_token) {
      warn(
        `Token exchange failed: ${tokens.error ?? tokenRes.status} ${tokens.error_description ?? ""}`,
      );
      if (!tokens.refresh_token && tokenRes.ok) {
        note("No refresh_token returned — revoke prior access at myaccount.google.com/permissions and retry.");
      }
      return;
    }

    // OAuth-app creds are shared across accounts; the per-account refresh
    // token goes into the gmail-tokens.json store keyed by identity id.
    saveSecrets({ GMAIL_CLIENT_ID: clientId, GMAIL_CLIENT_SECRET: clientSecret });
    _resetGmailCache();

    const { emailAddress } = await getGmailProfile({
      id: "pending",
      refreshToken: tokens.refresh_token,
    });
    const identityId = `gmail:${emailAddress.toLowerCase()}`;
    saveGmailToken(identityId, { refreshToken: tokens.refresh_token, address: emailAddress });
    _resetGmailCache();
    ok(`Saved refresh token for ${c.cyan(emailAddress)} (${c.dim(secretsPath())} dir)`);

    // Materialize the rotation pool: legacy single-identity installs get
    // their synthesized identity persisted first so existing prospects keep
    // their original From address, then this account joins with warm-up caps.
    const cfg = loadConfig();
    const pool: EmailIdentity[] = cfg.emailIdentities ? [...cfg.emailIdentities] : resolveIdentities(cfg);
    const existing = pool.findIndex((i) => i.id === identityId);
    const entry: EmailIdentity = {
      id: identityId,
      provider: "gmail",
      label: emailAddress,
      address: emailAddress,
      ...GMAIL_IDENTITY_DEFAULTS,
    };
    if (existing >= 0) {
      // Re-auth of a known account: keep its tuned caps, just confirm identity.
      ok(`Identity ${c.cyan(identityId)} re-authorized (caps unchanged).`);
    } else {
      pool.push(entry);
      saveConfig({ ...cfg, emailIdentities: pool });
      ok(
        `Identity ${c.cyan(identityId)} added to the rotation pool ` +
          `(warm-up: ${GMAIL_IDENTITY_DEFAULTS.warmup!.startPerDay}/day, ` +
          `+${GMAIL_IDENTITY_DEFAULTS.warmup!.incrementPerWeek}/week, max ${GMAIL_IDENTITY_DEFAULTS.maxPerDay}/day).`,
      );
      note("New prospects rotate across the pool; existing threads keep their original sender.");
    }
  } finally {
    server.stop(true);
  }
}
