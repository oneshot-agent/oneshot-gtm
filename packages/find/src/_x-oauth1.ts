/**
 * OAuth 1.0a request signing for the X API v2 reads the x-reposters finder
 * does. Self-contained RFC 5849 HMAC-SHA1 — GET only, no bodies to sign.
 *
 * User-context OAuth1 is required: the app-only bearer token 401s on every v2
 * read this finder makes, and user context is also what makes
 * `receives_your_dm` come back free on the same calls.
 */

import crypto from "node:crypto";

export interface XCreds {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

const CRED_ENV_VARS = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"] as const;

/** OAuth1 user-context creds from the environment, naming whatever is missing. */
export function loadXCreds(env: Record<string, string | undefined> = process.env): XCreds {
  const missing = CRED_ENV_VARS.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `missing ${missing.join(", ")} — the x-reposters finder needs OAuth1 user-context ` +
        `credentials in .env (app-only bearer tokens 401 on the v2 reads it makes)`,
    );
  }
  return {
    apiKey: env["X_API_KEY"]!,
    apiSecret: env["X_API_SECRET"]!,
    accessToken: env["X_ACCESS_TOKEN"]!,
    accessSecret: env["X_ACCESS_SECRET"]!,
  };
}

/**
 * RFC-3986 percent-encoding. encodeURIComponent leaves `!*'()` literal but the
 * OAuth signer encodes them, so a query containing any of those would be signed
 * one way and sent another — a 401 that looks like bad creds.
 */
export function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Build a `a=b&c=d` string with both sides RFC-3986 encoded. */
export function queryString(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(String(v))}`)
    .join("&");
}

/**
 * Signed Authorization header for a GET of `url` (query string included — the
 * exact URL being fetched must be the one signed). `nonce`/`timestamp` are
 * injectable for known-answer tests only.
 */
export function oauth1Header(
  creds: XCreds,
  method: string,
  url: string,
  opts: { nonce?: string; timestamp?: string } = {},
): string {
  const u = new URL(url);
  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: opts.nonce ?? crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: opts.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  // Signature base: every query + oauth param, encoded, sorted by encoded key
  // (then encoded value), joined — per RFC 5849 §3.4.1.3.2.
  const pairs: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) pairs.push([rfc3986(k), rfc3986(v)]);
  for (const [k, v] of Object.entries(oauthParams)) pairs.push([rfc3986(k), rfc3986(v)]);
  pairs.sort(([ak, av], [bk, bv]) => (ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk)));
  const paramString = pairs.map(([k, v]) => `${k}=${v}`).join("&");

  const base = `${method.toUpperCase()}&${rfc3986(baseUrl)}&${rfc3986(paramString)}`;
  const key = `${rfc3986(creds.apiSecret)}&${rfc3986(creds.accessSecret)}`;
  const signature = crypto.createHmac("sha1", key).update(base).digest("base64");

  const header = { ...oauthParams, oauth_signature: signature };
  return (
    "OAuth " +
    Object.entries(header)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${rfc3986(k)}="${rfc3986(v)}"`)
      .join(", ")
  );
}
