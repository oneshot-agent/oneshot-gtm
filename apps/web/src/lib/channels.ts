import type { QueueRowView } from "@oneshot-gtm/shared-types";

type Channel = QueueRowView["channel"];

export const CHANNEL_LABELS: Record<Channel, string> = {
  email: "Email",
  linkedin: "LinkedIn",
  x: "X",
};

/** First-touch length limit per channel, in characters; null when words govern (email). */
export const CHANNEL_MAX_CHARS: Record<Channel, number | null> = {
  email: null,
  linkedin: 200,
  x: 280,
};

/**
 * Channels a row's person can be reached on, from its payload — the same
 * rule the server's channelAddresses applies before it switches a channel.
 */
export function reachableChannels(payload: unknown): Channel[] {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const has = (key: string) => typeof p[key] === "string" && (p[key] as string).trim() !== "";
  const out: Channel[] = [];
  if (has("email")) out.push("email");
  if (has("linkedinUrl") && /linkedin\.com\/in\//i.test(p["linkedinUrl"] as string)) {
    out.push("linkedin");
  }
  if (has("handle") || has("twitterUrl")) out.push("x");
  return out;
}
