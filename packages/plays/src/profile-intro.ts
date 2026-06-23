import { type EmailPlayDef, type Prepared, runEmailPlay, standardEnrich } from "./_run-play.ts";
import { buildFollowUpEmail, registerSequence } from "./_cadence.ts";

/**
 * A manually-added prospect researched from a LinkedIn or X/Twitter URL. Unlike
 * the signal-specific plays, there's no external trigger artifact — the hook is
 * the person's own dossier, and the LLM picks the angle. `dossier` is the
 * pre-researched context (from deepResearchPerson); when present, `prepare`
 * uses it verbatim instead of re-enriching (so X profiles with no email still
 * draft, and `/queue` regenerate doesn't re-pay for research).
 */
export interface ProfileIntroTarget {
  name: string;
  email?: string | null;
  company?: string | null;
  linkedinUrl?: string | null;
  twitterUrl?: string | null;
  phone?: string | null;
  /** Pre-researched dossier text. When set, `prepare` returns it directly. */
  dossier?: string;
  /** The single hook the draft should lead with, chosen against the ICP. */
  angle?: string | null;
}

export interface ProfileIntroRunOptions {
  dryRun: boolean;
  targets: ProfileIntroTarget[];
  onProgress?: (
    index: number,
    draft: { subject: string; body: string; flags: string[]; sent: boolean; receiptIds: number[] },
  ) => void;
}

interface ProfileIntroDraft {
  target: ProfileIntroTarget;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
}

const PLAY_NAME = "profile-intro";

const profileIntroDef: EmailPlayDef<ProfileIntroTarget> = {
  playName: PLAY_NAME,
  promptName: "profile-intro-email",
  maxBodyWords: 100,
  enrollCadence: true,
  toEmail: (t) => t.email ?? "",
  // The add-prospect flow does the heavy research up-front and passes the
  // dossier in, so use it verbatim. The generic fallback (no dossier supplied)
  // enriches by email/linkedin like the other plays.
  prepare: (t, _dryRun): Promise<Prepared> =>
    t.dossier != null
      ? Promise.resolve({ receiptIds: [], dossier: t.dossier })
      : standardEnrich({
          playName: PLAY_NAME,
          enrichInput: {
            ...(t.email ? { email: t.email } : {}),
            ...(t.linkedinUrl ? { linkedinUrl: t.linkedinUrl } : {}),
            name: t.name,
          },
          enrichSlice: 5000,
        }),
  buildInputBlock: (t, prep, cfg) =>
    [
      `FOUNDER: ${cfg.founderName}`,
      `PRODUCT: ${cfg.productOneLiner}`,
      ...(cfg.icpOneLiner ? [`ICP: ${cfg.icpOneLiner}`] : []),
      `PROSPECT: ${t.name}`,
      `COMPANY: ${t.company ?? "(unknown)"}`,
      `ANGLE: ${t.angle ?? "(none detected — keep it honest and narrow)"}`,
      `DOSSIER:\n${prep.dossier || "(no dossier; rely on the angle only)"}`,
    ].join("\n"),
  prospectMeta: (t) => ({
    name: t.name,
    email: t.email ?? null,
    company: t.company ?? null,
    linkedin_url: t.linkedinUrl ?? t.twitterUrl ?? null,
    phone: t.phone ?? null,
    source: "manual",
  }),
};

export function runProfileIntro(
  opts: ProfileIntroRunOptions,
): Promise<{ drafted: ProfileIntroDraft[] }> {
  return runEmailPlay(profileIntroDef, opts);
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
        promptName: "profile-intro-followup",
        contextLines: [`CONTEXT: cold intro from their profile went unanswered ~4 days ago.`],
      }),
    },
    {
      dayOffset: 5, // ~9 days from enrollment
      channel: "email",
      breakOnReply: true,
      label: "value follow-up",
      builder: buildFollowUpEmail({
        playName: PLAY_NAME,
        promptName: "profile-intro-followup",
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
        contextLines: [`PLAY: profile-intro. Sender is closing the file.`],
      }),
    },
  ],
});
