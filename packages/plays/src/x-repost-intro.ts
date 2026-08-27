import { type EmailPlayDef, type Prepared, runEmailPlay, standardEnrich } from "./_run-play.ts";
import { buildFollowUpEmail, registerSequence } from "./_cadence.ts";
import { xRepostIntroMetadata } from "./_metadata.ts";

/**
 * Founder-lane prospect from the x-reposters finder: someone who reposted a
 * watched X account's tweet and whose bio/site say they build things. The hook
 * is the specific tweet they amplified; the ask is product adoption through
 * the founder's ICP frame. Never asks for a repost — that spends the better
 * ask on the cheaper one.
 */
export interface XRepostIntroTarget {
  name: string;
  email?: string | null;
  company?: string | null;
  title?: string | null;
  /** Pre-researched dossier from deepResearchPerson. When set, `prepare` uses it verbatim. */
  dossier?: string;
  /** The single hook the draft should lead with, chosen against the ICP. */
  angle?: string | null;
  /** X handle, without the @. */
  handle: string;
  twitterUrl: string;
  /** Numeric X user id, for DM deep-links elsewhere. */
  xUserId?: string;
  /** The watched account they reposted. */
  seedHandle: string;
  /** Founder-authored line on why this seed's audience matters (repoEdge analog). */
  seedEdge?: string;
  tweetUrl: string;
  tweetText: string;
  mode: "retweet" | "quote";
  /** Their own words when they quoted — the best hook when present. */
  quote?: string | null;
  followers?: number;
  score?: number;
  why?: string;
  /** Whether their DMs are open, and which engine answered (semantics differ). */
  dmOpen?: boolean;
  engine?: string;
}

export interface XRepostIntroRunOptions {
  dryRun: boolean;
  targets: XRepostIntroTarget[];
  onProgress?: (
    index: number,
    draft: { subject: string; body: string; flags: string[]; sent: boolean; receiptIds: number[] },
  ) => void;
}

interface XRepostIntroDraft {
  target: XRepostIntroTarget;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
}

const PLAY_NAME = "x-repost-intro";

const xRepostIntroDef: EmailPlayDef<XRepostIntroTarget> = {
  playName: PLAY_NAME,
  promptName: "x-repost-intro-email",
  maxBodyWords: 100,
  enrollCadence: true,
  toEmail: (t) => t.email ?? "",
  // The finder does the research up-front (deepResearchPerson on the X
  // profile) and passes the dossier in — use it verbatim, don't re-pay. The
  // generic fallback covers /queue regenerates on rows without one.
  prepare: (t, _dryRun): Promise<Prepared> =>
    t.dossier != null
      ? Promise.resolve({ receiptIds: [], dossier: t.dossier })
      : standardEnrich({
          playName: PLAY_NAME,
          enrichInput: {
            ...(t.email ? { email: t.email } : {}),
            name: t.name,
          },
          enrichSlice: 5000,
        }),
  buildInputBlock: (t, prep, cfg) =>
    [
      `FOUNDER: ${cfg.founderName}`,
      `PRODUCT: ${cfg.productOneLiner}`,
      ...(cfg.icpOneLiner ? [`ICP: ${cfg.icpOneLiner}`] : []),
      `PROSPECT: ${t.name} (@${t.handle} on X)`,
      `COMPANY: ${t.company ?? "(unknown)"}`,
      `SEED: @${t.seedHandle}`,
      ...(t.seedEdge ? [`SEED_EDGE: ${t.seedEdge}`] : []),
      `THEY_REPOSTED: ${t.tweetText} (${t.tweetUrl})`,
      `MODE: ${t.mode}`,
      ...(t.quote ? [`THEIR_QUOTE: ${t.quote}`] : []),
      `ANGLE: ${t.angle ?? "(none detected — keep it honest and narrow)"}`,
      `DOSSIER:\n${prep.dossier || "(no dossier; rely on the repost + angle only)"}`,
    ].join("\n"),
  prospectMeta: (t) => ({
    name: t.name,
    email: t.email ?? null,
    company: t.company ?? null,
    // Polymorphic social-URL column — this one is an X profile.
    linkedin_url: t.twitterUrl,
    source: "x-reposters",
    source_profile_url: t.twitterUrl,
  }),
  metadata: xRepostIntroMetadata,
};

export function runXRepostIntro(
  opts: XRepostIntroRunOptions,
): Promise<{ drafted: XRepostIntroDraft[] }> {
  return runEmailPlay(xRepostIntroDef, opts);
}

registerSequence({
  playName: PLAY_NAME,
  steps: [
    {
      dayOffset: 4,
      channel: "email",
      breakOnReply: true,
      label: "value follow-up",
      builder: buildFollowUpEmail({
        playName: PLAY_NAME,
        promptName: "x-repost-intro-followup",
        contextLines: [`CONTEXT: cold intro off their repost went unanswered ~4 days ago.`],
      }),
    },
    {
      dayOffset: 5, // ~9 days from enrollment
      channel: "email",
      breakOnReply: true,
      label: "value follow-up",
      builder: buildFollowUpEmail({
        playName: PLAY_NAME,
        promptName: "x-repost-intro-followup",
        contextLines: [
          `CONTEXT: second touch; still no reply. Keep it shorter than the first ping.`,
        ],
      }),
    },
    {
      dayOffset: 9, // ~18 days from enrollment
      channel: "email",
      breakOnReply: true,
      label: "breakup",
      builder: buildFollowUpEmail({
        playName: PLAY_NAME,
        promptName: "breakup-email",
        contextLines: [`PLAY: x-repost-intro. Sender is closing the file.`],
      }),
    },
  ],
});
