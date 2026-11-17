import { getSharedDb, logEvent } from "@oneshot-gtm/core";
import type { CurrentMember } from "@oneshot-gtm/shared-types";

/**
 * Who a request is acting as. `currentMember` is the only place identity is
 * read, so another sign-in method plugs in here and nowhere else.
 *
 * Two ways in:
 *  - Directly on the host machine (the server binds 127.0.0.1): a loopback
 *    Host, no identity header and no proxy headers. That is the owner.
 *  - Through `tailscale serve` on a host from the allowed list. Tailscale
 *    passes the browser's Host through unchanged, strips any
 *    `Tailscale-User-Login` the client sent and sets its own for a signed-in
 *    tailnet user. That login must be an active member's email.
 *
 * `tailscale serve` picks its backend from the TLS server name, not the Host
 * header, so a tailnet device can send `Host: 127.0.0.1` through it. Such a
 * request still carries the proxy's `X-Forwarded-*` headers, which is why a
 * loopback Host alone does not make a request local. See docs/members.md.
 */

const IDENTITY_HEADER = "tailscale-user-login";

/** Set by a proxy in front of the server, never by a browser or the CLI talking to it directly. */
const PROXY_HEADERS: readonly string[] = [
  "x-forwarded-for",
  "x-forwarded-host",
  "forwarded",
  "tailscale-funnel-request",
];

/** The names the server answers on its own machine. Takes a lowercased hostname without a port. */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

/** The hostname of a `Host` header value: lowercased, without the port. */
function hostnameOf(host: string | null): string | null {
  if (!host) return null;
  return host.replace(/:\d+$/, "").toLowerCase() || null;
}

/**
 * Tailscale sends an ASCII login as it is and a non-ASCII one as RFC 2047
 * Q-encoded words (`=?utf-8?q?...?=`). Anything else is returned unchanged and
 * then matches no member.
 */
function decodeIdentity(value: string): string {
  const words = value.trim().split(/\s+/);
  const bytes: number[] = [];
  for (const word of words) {
    const m = /^=\?utf-8\?q\?([^?]*)\?=$/i.exec(word);
    if (!m) return value.trim();
    const text = m[1]!;
    for (let i = 0; i < text.length; i++) {
      const hex = text[i] === "=" ? text.slice(i + 1, i + 3) : "";
      if (/^[0-9a-f]{2}$/i.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
      } else {
        bytes.push(text[i] === "_" ? 0x20 : text.charCodeAt(i));
      }
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function loggedShared<T>(what: string, fallback: T, read: () => T): T {
  try {
    return read();
  } catch (err) {
    logEvent(
      "members.read_failed",
      { what, message_120: ((err as Error).message ?? "").slice(0, 120) },
      "warn",
    );
    return fallback;
  }
}

/** True for a hostname (no port) on the shared allowed list. A failed read allows nothing. */
function isAllowedHostname(hostname: string): boolean {
  return loggedShared("allowed_hosts", false, () => getSharedDb().isAllowedHost(hostname));
}

/**
 * The owner for a request made on the host machine: the listed owner when
 * there is one, else a local owner without an email, which is what a
 * single-user install has always been.
 */
function localOwner(): CurrentMember {
  const owner = loggedShared("owner", null, () => getSharedDb().ownerMember());
  return owner
    ? { email: owner.email, name: owner.name, role: "owner" }
    : { email: null, name: null, role: "owner" };
}

/** The member a request acts as, or null when it is nobody's. */
export function currentMember(req: Request): CurrentMember | null {
  const hostname = hostnameOf(req.headers.get("host"));
  if (!hostname) return null;
  const identity = req.headers.get(IDENTITY_HEADER);

  if (isLoopbackHostname(hostname)) {
    // A proxied request is not local, whatever Host it claims.
    if (identity !== null || PROXY_HEADERS.some((h) => req.headers.has(h))) return null;
    return localOwner();
  }

  if (identity === null || !isAllowedHostname(hostname)) return null;
  const login = decodeIdentity(identity);
  const member = loggedShared("member", null, () => getSharedDb().activeMember(login));
  return member ? { email: member.email, name: member.name, role: member.role } : null;
}

/** True when the request's Host is one the dashboard answers on: loopback, or on the allowed list. */
export function isAllowedRequestHost(req: Request): boolean {
  const hostname = hostnameOf(req.headers.get("host"));
  return hostname !== null && (isLoopbackHostname(hostname) || isAllowedHostname(hostname));
}

/** The http(s) hostname of an Origin header value, lowercased; null when it is not one. */
function originHostname(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True for a page served from a host on the allowed list. Loopback pages and a missing Origin are not this. */
export function isAllowedHostOrigin(origin: string): boolean {
  const hostname = origin === "" ? null : originHostname(origin);
  return hostname !== null && !isLoopbackHostname(hostname) && isAllowedHostname(hostname);
}

/**
 * The Origin test for mutating requests. No Origin (curl, the CLI, a
 * server-side fetch) passes; a page passes when it is served from loopback or
 * from an allowed host.
 */
export function isAllowedOrigin(origin: string): boolean {
  if (origin === "") return true;
  const hostname = originHostname(origin);
  return hostname !== null && (isLoopbackHostname(hostname) || isAllowedHostname(hostname));
}
