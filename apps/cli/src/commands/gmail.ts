import { randomUUID } from "node:crypto";
import {
  _resetGmailCache,
  exchangeGmailAuthCode,
  getGmailProfile,
  GMAIL_IDENTITY_DEFAULTS,
  gmailConsentUrl,
  registerGmailIdentity,
  resolveCanaryPair,
  runPlacementCanary,
  SAME_DOMAIN_WARNING,
  saveSecrets,
  secretsPath,
  SINGLE_SEED_CAVEAT,
} from "@oneshot-gtm/core";
import prompts from "prompts";
import { bail, box, c, fail, header, note, ok, warn } from "../output.ts";

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
    const consentUrl = gmailConsentUrl({ clientId, redirectUri, state });

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

    let refreshToken: string;
    try {
      refreshToken = await exchangeGmailAuthCode({
        code: outcome.code,
        clientId,
        clientSecret,
        redirectUri,
      });
    } catch (err) {
      warn((err as Error).message);
      return;
    }

    // OAuth-app creds are shared across accounts; the per-account refresh
    // token goes into the gmail-tokens.json store keyed by identity id.
    saveSecrets({ GMAIL_CLIENT_ID: clientId, GMAIL_CLIENT_SECRET: clientSecret });
    _resetGmailCache();

    const { emailAddress } = await getGmailProfile({ id: "pending", refreshToken });
    _resetGmailCache();
    const { identityId, created } = registerGmailIdentity({ address: emailAddress, refreshToken });
    ok(`Saved refresh token for ${c.cyan(emailAddress)} (${c.dim(secretsPath())} dir)`);

    if (created) {
      ok(
        `Identity ${c.cyan(identityId)} added to the rotation pool ` +
          `(warm-up: ${GMAIL_IDENTITY_DEFAULTS.warmup!.startPerDay}/day, ` +
          `+${GMAIL_IDENTITY_DEFAULTS.warmup!.incrementPerWeek}/week, max ${GMAIL_IDENTITY_DEFAULTS.maxPerDay}/day).`,
      );
      note("New prospects rotate across the pool; existing threads keep their original sender.");
    } else {
      // Re-auth of a known account: token refreshed, tuned caps untouched.
      ok(`Identity ${c.cyan(identityId)} re-authorized (caps unchanged).`);
    }
  } finally {
    server.stop(true);
  }
}

/**
 * Inbox-placement canary. Sends one real email between two authorized
 * mailboxes and reports where the receiving account filed it, plus the
 * SPF/DKIM/DMARC verdicts the receiving server recorded on the delivered copy.
 *
 * Interactive confirmation by design: this SENDS, so it can't be something a
 * founder triggers by accident while poking at diagnostics.
 */
export async function commandGmailPlacement(opts: {
  from?: string;
  to?: string;
  play?: string;
  yes?: boolean;
}): Promise<void> {
  header("Inbox placement test");

  let pair: ReturnType<typeof resolveCanaryPair>;
  try {
    pair = resolveCanaryPair({
      ...(opts.from ? { fromIdentityId: opts.from } : {}),
      ...(opts.to ? { toIdentityId: opts.to } : {}),
    });
  } catch (err) {
    bail((err as Error).message);
  }

  note(`Sends one real email: ${c.cyan(pair.from.id)} → ${c.cyan(pair.to.id)}`);
  note(SINGLE_SEED_CAVEAT);

  if (!opts.yes) {
    const { go } = await prompts(
      { type: "confirm", name: "go", message: "Send the canary now?", initial: true },
      { onCancel: () => process.exit(0) },
    );
    if (!go) return;
  }

  note("Sending, then polling the receiving mailbox (up to 2 min)…");
  const result = await runPlacementCanary({
    ...(opts.from ? { fromIdentityId: opts.from } : {}),
    ...(opts.to ? { toIdentityId: opts.to } : {}),
    ...(opts.play ? { playName: opts.play } : {}),
  });

  const line = result.placement === "inbox" ? ok : result.placement === "spam" ? fail : warn;
  const latency = result.latencyMs != null ? ` in ${Math.round(result.latencyMs / 1000)}s` : "";
  line(`Landed in ${c.bold(result.placement.toUpperCase())}${latency}`);

  const body = [
    `from        ${result.fromAddress}`,
    `to          ${result.toAddress}`,
    `subject     ${result.subject}`,
    // Naming the source matters: a verdict on generic filler says little about
    // the copy that actually ships, and the founder should know which they got.
    `copy        ${result.sourcePlay ? `replayed real send from '${result.sourcePlay}'` : "GENERIC SAMPLE (no prior send to replay)"}`,
    `labels      ${result.labelIds.join(", ") || "—"}`,
    `spf         ${result.auth.spf}`,
    `dkim        ${result.auth.dkim}`,
    `dmarc       ${result.auth.dmarc}`,
  ].join("\n");
  box("Result", body);

  if (result.sameDomain) warn(SAME_DOMAIN_WARNING);
  if (result.placement === "not_delivered") {
    warn(
      "Never arrived within the deadline — inconclusive, not proof it was dropped. Re-run to confirm.",
    );
  }
  if (result.placement === "promotions" || result.placement === "tab") {
    note("Delivered, but tab-binned — for cold outreach that's close to invisible.");
  }
  if (!result.sameDomain && result.auth.spf === "unknown" && result.auth.dkim === "unknown") {
    note("No Authentication-Results header — the receiving server recorded no verdict.");
  }
  note("Recorded — `doctor` reports this result until you run another.");
}
