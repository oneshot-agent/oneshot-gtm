import { type EmailPlayDef, runEmailPlay, standardEnrich } from "./_run-play.ts";
import { buildFollowUpEmail, registerSequence } from "./_cadence.ts";

export interface PostFundingTarget {
  name: string;
  email: string;
  company: string;
  round: string;
  amountUsd: number;
  leadInvestor?: string;
  sourceUrl: string;
  linkedinUrl?: string;
  phone?: string;
}

export interface PostFundingRunOptions {
  dryRun: boolean;
  targets: PostFundingTarget[];
  /** Per-target progress hook installed by /api/run SSE handler. */
  onProgress?: (
    index: number,
    draft: { subject: string; body: string; flags: string[]; sent: boolean; receiptIds: number[] },
  ) => void;
}

export interface PostFundingDraft {
  target: PostFundingTarget;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
}

const PLAY_NAME = "post-funding";

const postFundingDef: EmailPlayDef<PostFundingTarget> = {
  playName: PLAY_NAME,
  promptName: "post-funding-email",
  maxBodyWords: 150,
  enrollCadence: true,
  toEmail: (t) => t.email,
  // Enrich on both preview and real send (cached by email) so the reviewed
  // draft is personalized; the heavier deepResearch stays real-send only.
  prepare: (t, dryRun) =>
    standardEnrich({
      playName: PLAY_NAME,
      enrichInput: {
        ...(t.email ? { email: t.email } : {}),
        ...(t.linkedinUrl ? { linkedinUrl: t.linkedinUrl } : {}),
        name: t.name,
      },
      enrichSlice: 3500,
      ...(dryRun
        ? {}
        : {
            research: {
              topic: `${t.company} ${t.round} announcement: open job postings, hiring page, public roadmap, named challenges in the press release. Source: ${t.sourceUrl}`,
            },
          }),
    }),
  buildInputBlock: (t, prep, cfg) =>
    [
      `FOUNDER: ${cfg.founderName}`,
      `PRODUCT: ${cfg.productOneLiner}`,
      `PROSPECT: ${t.name} at ${t.company}`,
      `ROUND: ${t.round} ($${t.amountUsd.toLocaleString()})`,
      `LEAD INVESTOR: ${t.leadInvestor ?? "(unspecified)"}`,
      `SOURCE: ${t.sourceUrl}`,
      `DOSSIER:\n${prep.dossier || "(dry-run; rely on the round details only)"}`,
    ].join("\n"),
  prospectMeta: (t) => ({
    name: t.name,
    email: t.email,
    company: t.company,
    linkedin_url: t.linkedinUrl ?? null,
    phone: t.phone ?? null,
    source: "post-funding",
  }),
  metadata: (t) => ({
    round: t.round,
    amountUsd: t.amountUsd,
    leadInvestor: t.leadInvestor,
  }),
};

export function runPostFunding(
  opts: PostFundingRunOptions,
): Promise<{ drafted: PostFundingDraft[] }> {
  return runEmailPlay(postFundingDef, opts);
}

registerSequence({
  playName: PLAY_NAME,
  steps: [
    {
      dayOffset: 9,
      channel: "email",
      breakOnReply: true,
      label: "case-study follow-up",
      builder: buildFollowUpEmail({
        playName: PLAY_NAME,
        promptName: "post-funding-followup",
        contextLines: [
          `CONTEXT: prospect's company recently raised; first email sent ~9 days ago, no reply.`,
        ],
      }),
    },
    {
      dayOffset: 9, // ~21 days from enrollment
      channel: "email",
      breakOnReply: true,
      label: "breakup",
      builder: buildFollowUpEmail({
        playName: PLAY_NAME,
        promptName: "breakup-email",
        contextLines: [`PLAY: post-funding.`],
      }),
    },
  ],
});
