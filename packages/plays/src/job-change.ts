import { type EmailPlayDef, runEmailPlay, standardEnrich } from "./_run-play.ts";
import { buildFollowUpEmail, registerSequence } from "./_cadence.ts";

export interface JobChangeTarget {
  name: string;
  email: string;
  newRole: string;
  newCompany: string;
  previousRole?: string;
  previousCompany?: string;
  linkedinUrl?: string;
  phone?: string;
}

export interface JobChangeRunOptions {
  dryRun: boolean;
  targets: JobChangeTarget[];
  /** Per-target progress hook installed by /api/run SSE handler. */
  onProgress?: (
    index: number,
    draft: { subject: string; body: string; flags: string[]; sent: boolean; receiptIds: number[] },
  ) => void;
}

export interface JobChangeDraft {
  target: JobChangeTarget;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
}

const PLAY_NAME = "job-change";

const jobChangeDef: EmailPlayDef<JobChangeTarget> = {
  playName: PLAY_NAME,
  promptName: "job-change-email",
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
      enrichSlice: 4000,
      ...(dryRun
        ? {}
        : {
            research: {
              topic: `Public posts, talks, and recent decisions by ${t.name} (joined ${t.newCompany} as ${t.newRole}, formerly ${t.previousRole ?? "?"} at ${t.previousCompany ?? "?"})`,
            },
          }),
    }),
  buildInputBlock: (t, prep, cfg) =>
    [
      `FOUNDER: ${cfg.founderName}`,
      `PRODUCT: ${cfg.productOneLiner}`,
      `PROSPECT: ${t.name}`,
      `NEW ROLE: ${t.newRole} at ${t.newCompany}`,
      `PREVIOUS: ${t.previousRole ?? "unknown"} at ${t.previousCompany ?? "unknown"}`,
      `DOSSIER:\n${prep.dossier || "(dry-run; rely on the trigger only)"}`,
    ].join("\n"),
  prospectMeta: (t) => ({
    name: t.name,
    email: t.email,
    company: t.newCompany,
    linkedin_url: t.linkedinUrl ?? null,
    phone: t.phone ?? null,
    source: "job-change",
  }),
  metadata: (t) => ({ newRole: t.newRole, newCompany: t.newCompany }),
};

export function runJobChange(opts: JobChangeRunOptions): Promise<{ drafted: JobChangeDraft[] }> {
  return runEmailPlay(jobChangeDef, opts);
}

registerSequence({
  playName: PLAY_NAME,
  steps: [
    {
      dayOffset: 5,
      channel: "email",
      breakOnReply: true,
      label: "value follow-up",
      builder: buildFollowUpEmail({
        playName: PLAY_NAME,
        promptName: "job-change-followup",
        contextLines: [
          `CONTEXT: prospect recently joined a new role; first email went unanswered ~5 days ago.`,
        ],
      }),
    },
    {
      dayOffset: 9, // ~14 days from enrollment
      channel: "email",
      breakOnReply: true,
      label: "breakup",
      builder: buildFollowUpEmail({
        playName: PLAY_NAME,
        promptName: "breakup-email",
        contextLines: [`PLAY: job-change. Sender is closing the file.`],
      }),
    },
  ],
});
