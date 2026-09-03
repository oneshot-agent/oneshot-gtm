import { emailDomain } from "./_lib.ts";
import { type EmailPlayDef, runEmailPlay, standardEnrich } from "./_run-play.ts";
import { newBusinessMetadata } from "./_metadata.ts";
import { buildFollowUpEmail, registerSequence } from "./_cadence.ts";

const PLAY_NAME = "new-business";

export interface NewBusinessTarget {
  name: string;
  email: string;
  /** The newly-formed business. */
  company: string;
  /** e.g. "family-owned taqueria", "HVAC contractor", "two-chair dental practice". */
  businessType: string;
  /** What was recently issued, e.g. "food service permit", "contractor licence",
   *  "motor carrier authority". */
  licenseType: string;
  /** How recently, in plain words — e.g. "3 weeks ago", "this month". Fed by the
   *  recent-issue lane of the local-registry finder (#459). */
  issuedAgo: string;
  /** The concrete thing that helps a business at this exact starting point —
   *  plain English, hours/dollars terms, never a feature list. */
  yourEdge: string;
  linkedinUrl?: string;
  phone?: string;
  sourceProfileUrl?: string;
  /** Job title from the person-level ICP gate — persisted to prospects.title. */
  title?: string;
}

export interface NewBusinessRunOptions {
  dryRun: boolean;
  targets: NewBusinessTarget[];
  /** Per-target progress hook installed by /api/run SSE handler. */
  onProgress?: (
    index: number,
    draft: { subject: string; body: string; flags: string[]; sent: boolean; receiptIds: number[] },
  ) => void;
  /** Abort signal for the run — see `runEmailPlay`'s `signal`. */
  signal?: AbortSignal;
}

export interface NewBusinessDraft {
  target: NewBusinessTarget;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
}

const newBusinessDef: EmailPlayDef<NewBusinessTarget> = {
  playName: PLAY_NAME,
  promptName: "new-business-email",
  maxBodyWords: 150,
  // One touch + one follow-up that doubles as the breakup — mirrors
  // accelerator-batch's shape and free-pilot's, above.
  enrollCadence: true,
  toEmail: (t) => t.email,
  prepare: (t) =>
    standardEnrich({
      playName: PLAY_NAME,
      enrichInput: {
        ...(t.email ? { email: t.email } : {}),
        name: t.name,
        companyDomain: emailDomain(t.email),
      },
      enrichSlice: 3500,
    }),
  buildInputBlock: (t, prep, cfg) =>
    [
      `FOUNDER: ${cfg.founderName}`,
      `PRODUCT: ${cfg.productOneLiner}`,
      `PROSPECT: ${t.name} at ${t.company}`,
      `BUSINESS TYPE: ${t.businessType}`,
      `LICENSE/AUTHORITY: ${t.licenseType}, issued ${t.issuedAgo}`,
      `YOUR EDGE: ${t.yourEdge}`,
      `DOSSIER:\n${prep.dossier || "(dry-run)"}`,
    ].join("\n"),
  prospectMeta: (t) => ({
    name: t.name,
    email: t.email,
    company: t.company,
    linkedin_url: t.linkedinUrl ?? null,
    phone: t.phone ?? null,
    source: "new-business",
    source_profile_url: t.sourceProfileUrl ?? null,
  }),
  metadata: newBusinessMetadata,
};

export function runNewBusiness(
  opts: NewBusinessRunOptions,
): Promise<{ drafted: NewBusinessDraft[] }> {
  return runEmailPlay(newBusinessDef, opts);
}

// One-touch + one follow-up that IS the breakup — mirrors accelerator-batch
// and free-pilot, not the five-step profile-intro.
registerSequence({
  playName: PLAY_NAME,
  steps: [
    {
      dayOffset: 5,
      channel: "email",
      breakOnReply: true,
      label: "single follow-up + breakup",
      builder: buildFollowUpEmail({
        playName: PLAY_NAME,
        promptName: "new-business-followup",
        contextLines: [
          `PLAY: new-business. The new-business motion is one-touch + one breakup; this is the final note. Lean very short.`,
        ],
      }),
    },
  ],
});
