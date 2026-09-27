/**
 * Outreach channels a queue row or cadence step can use. Email is the default;
 * LinkedIn and X are first-class choices, not fallbacks — a workspace or
 * trigger can run on any of them.
 *
 * Each channel says how a person is addressed on it and who sends: `api`
 * (OneShot has the action, the drain sends), `manual` (the founder sends by
 * hand and records it with Mark sent) or `unavailable` (nothing can send it
 * yet). Actions move from `manual`/`unavailable` to `api` as OneShot ships
 * them; nothing else about the row changes.
 */

export const OUTREACH_CHANNELS = ["email", "linkedin", "x"] as const;
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];

export type ChannelSender = "api" | "manual" | "unavailable";

export interface ChannelSpec {
  /** What identifies the person on this channel. */
  address: "email" | "linkedin_profile" | "x_handle";
  /** First-touch draft limit in characters; null when the prompt's word budget governs (email). */
  firstTouchMaxChars: number | null;
  label: string;
}

export const CHANNEL_SPECS: Record<OutreachChannel, ChannelSpec> = {
  email: { address: "email", firstTouchMaxChars: null, label: "Email" },
  // LinkedIn accepts 300 characters on a connection note; accounts without
  // Premium are held to 200, so the draft target is the lower one.
  linkedin: { address: "linkedin_profile", firstTouchMaxChars: 200, label: "LinkedIn" },
  x: { address: "x_handle", firstTouchMaxChars: 280, label: "X" },
};

export function isOutreachChannel(value: unknown): value is OutreachChannel {
  return typeof value === "string" && (OUTREACH_CHANNELS as readonly string[]).includes(value);
}

/** A stored channel value, read defensively: anything unknown is email, the column default. */
export function channelOf(value: unknown): OutreachChannel {
  return isOutreachChannel(value) ? value : "email";
}

/**
 * Who sends a first touch on this channel. Email and LinkedIn (a connection
 * request with a note, OneShot's invite route) go through the API. X has no
 * OneShot action API, so X DMs are copied and sent by hand.
 */
export function firstTouchSender(channel: OutreachChannel): ChannelSender {
  switch (channel) {
    case "email":
    case "linkedin":
      return "api";
    case "x":
      return "manual";
  }
}

/**
 * The channels a person can be reached on, from what the row's payload
 * carries: an email, a LinkedIn profile URL, an X handle or profile.
 */
export function channelAddresses(payload: Record<string, unknown>): OutreachChannel[] {
  const has = (key: string) =>
    typeof payload[key] === "string" && (payload[key] as string).trim() !== "";
  const out: OutreachChannel[] = [];
  if (has("email")) out.push("email");
  if (has("linkedinUrl") && /linkedin\.com\/in\//i.test(payload["linkedinUrl"] as string)) {
    out.push("linkedin");
  }
  if (has("handle") || has("twitterUrl")) out.push("x");
  return out;
}

/**
 * An X handle (without the @) from a handle or an x.com / twitter.com
 * profile URL; null when the value names no profile.
 */
export function xHandleFrom(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  const fromUrl = v.match(
    /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i,
  );
  const handle = fromUrl ? fromUrl[1]! : v.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
  const reserved = ["home", "i", "intent", "search", "share", "messages", "explore", "settings"];
  return reserved.includes(handle.toLowerCase()) ? null : handle;
}
