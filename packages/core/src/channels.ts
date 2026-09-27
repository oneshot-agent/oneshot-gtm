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
 * Who sends a first touch on this channel today. X has no OneShot action API,
 * so X DMs are copied and sent by hand. LinkedIn invites are wired to the
 * OneShot invite route in a later change; until then nothing sends them.
 */
export function firstTouchSender(channel: OutreachChannel): ChannelSender {
  switch (channel) {
    case "email":
      return "api";
    case "x":
      return "manual";
    case "linkedin":
      return "unavailable";
  }
}
