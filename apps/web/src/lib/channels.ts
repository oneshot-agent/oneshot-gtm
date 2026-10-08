import type { QueueRowView } from "@oneshot-gtm/shared-types";

type Channel = QueueRowView["channel"];

export const CHANNEL_LABELS: Record<Channel, string> = {
  email: "Email",
  linkedin: "LinkedIn",
  x: "X",
  reddit: "Reddit",
  "hacker-news": "Hacker News",
};

/** First-touch length limit per channel, in characters; null when words govern (email). */
export const CHANNEL_MAX_CHARS: Record<Channel, number | null> = {
  email: null,
  linkedin: 200,
  x: 280,
  reddit: null,
  "hacker-news": null,
};

/**
 * Channels a row's person can be reached on, from its payload. The same
 * rule the server's channelAddresses applies before it switches a channel.
 */
export function reachableChannels(payload: unknown): Channel[] {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  if ((p.platform === "reddit" || p.platform === "hacker-news") && typeof p.postUrl === "string")
    return [p.platform];
  const has = (key: string) => typeof p[key] === "string" && (p[key] as string).trim() !== "";
  const out: Channel[] = [];
  if (has("email")) out.push("email");
  if (has("linkedinUrl") && /linkedin\.com\/in\//i.test(p["linkedinUrl"] as string)) {
    out.push("linkedin");
  }
  const text = (key: string) => (typeof p[key] === "string" ? (p[key] as string) : null);
  if (xHandleFrom(text("handle")) ?? xHandleFrom(text("twitterUrl"))) out.push("x");
  return out;
}

/** An X handle (no @) from a handle or an x.com / twitter.com profile URL. */
export function xHandleFrom(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  const m = v.match(
    /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i,
  );
  const handle = m ? m[1]! : v.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
  return X_RESERVED_PATHS.has(handle.toLowerCase()) ? null : handle;
}

/** x.com paths that look like a handle but name no profile (mirrors core's channels.ts). */
const X_RESERVED_PATHS = new Set([
  "about",
  "compose",
  "explore",
  "hashtag",
  "home",
  "i",
  "intent",
  "jobs",
  "login",
  "logout",
  "messages",
  "notifications",
  "privacy",
  "search",
  "settings",
  "share",
  "signup",
  "tos",
]);
