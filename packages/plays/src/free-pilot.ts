import { emailDomain } from "./_lib.ts";
import { type EmailPlayDef, runEmailPlay, standardEnrich } from "./_run-play.ts";
import { freePilotMetadata } from "./_metadata.ts";
import { buildFollowUpEmail, registerSequence } from "./_cadence.ts";

const PLAY_NAME = "free-pilot";

export interface FreePilotTarget {
  name: string;
  email: string;
  /** The owner-operator's business. */
  company: string;
  /** e.g. "family-owned taqueria", "HVAC contractor", "two-chair dental practice". */
  businessType: string;
  /** The concrete thing you set up for them free, and what it saves them —
   *  plain English, hours/dollars terms, never a feature list. */
  yourEdge: string;
  linkedinUrl?: string;
  phone?: string;
  sourceProfileUrl?: string;
  /** Job title from the person-level ICP gate — persisted to prospects.title. */
  title?: string;
}

export interface FreePilotRunOptions {
  dryRun: boolean;
  targets: FreePilotTarget[];
  /** Per-target progress hook installed by /api/run SSE handler. */
  onProgress?: (
    index: number,
    draft: { subject: string; body: string; flags: string[]; sent: boolean; receiptIds: number[] },
  ) => void;
  /** Abort signal for the run — see `runEmailPlay`'s `signal`. */
  signal?: AbortSignal;
}

export interface FreePilotDraft {
  target: FreePilotTarget;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
}

const freePilotDef: EmailPlayDef<FreePilotTarget> = {
  playName: PLAY_NAME,
  promptName: "free-pilot-email",
  maxBodyWords: 150,
  // One touch + one follow-up that doubles as the breakup — mirrors
  // accelerator-batch's shape. An owner-operator who didn't bite on a free,
  // no-obligation setup doesn't want a multi-touch chase.
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
      `YOUR EDGE: ${t.yourEdge}`,
      `DOSSIER:\n${prep.dossier || "(dry-run)"}`,
    ].join("\n"),
  prospectMeta: (t) => ({
    name: t.name,
    email: t.email,
    company: t.company,
    linkedin_url: t.linkedinUrl ?? null,
    phone: t.phone ?? null,
    source: "free-pilot",
    source_profile_url: t.sourceProfileUrl ?? null,
  }),
  metadata: freePilotMetadata,
};

export function runFreePilot(opts: FreePilotRunOptions): Promise<{ drafted: FreePilotDraft[] }> {
  return runEmailPlay(freePilotDef, opts);
}

// One-touch + one follow-up that IS the breakup — mirrors accelerator-batch,
// not the five-step profile-intro. An owner-operator who ignored a free,
// no-obligation offer doesn't want a chase.
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
        promptName: "free-pilot-followup",
        contextLines: [
          `PLAY: free-pilot. The free-pilot motion is one-touch + one breakup; this is the final note. Lean very short. No "design partner", "pilot program", or "LOI".`,
        ],
      }),
    },
  ],
});
