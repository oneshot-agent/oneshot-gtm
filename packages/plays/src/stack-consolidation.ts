import { emailDomain } from "./_lib.ts";
import { type EmailPlayDef, runEmailPlay, standardEnrich } from "./_run-play.ts";
import { buildFollowUpEmail, registerSequence } from "./_cadence.ts";

const PLAY_NAME = "stack-consolidation";

export interface StackConsolidationTarget {
  name: string;
  email: string;
  company: string;
  /** Comma-separated list of API vendors detected in the repo. */
  vendorStack: string;
  /** How your product collapses the vendor sprawl (one fact). */
  yourEdge: string;
  /** Optional source URL (the repo) for the founder's reference. */
  evidenceUrl?: string;
  linkedinUrl?: string;
  phone?: string;
}

export interface StackConsolidationRunOptions {
  dryRun: boolean;
  targets: StackConsolidationTarget[];
}

export interface StackConsolidationDraft {
  target: StackConsolidationTarget;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
}

const stackConsolidationDef: EmailPlayDef<StackConsolidationTarget> = {
  playName: PLAY_NAME,
  promptName: "stack-consolidation-email",
  maxBodyWords: 100,
  enrollCadence: true,
  toEmail: (t) => t.email,
  // Enrich on both preview and real send (cached by email). No deepResearch —
  // the manifest-derived vendor stack is the load-bearing signal here.
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
      `STACK: ${t.vendorStack}`,
      `YOUR EDGE: ${t.yourEdge}`,
      `DOSSIER:\n${prep.dossier || "(dry-run)"}`,
    ].join("\n"),
  prospectMeta: (t) => ({
    name: t.name,
    email: t.email,
    company: t.company,
    linkedin_url: t.linkedinUrl ?? null,
    phone: t.phone ?? null,
    source: "stack-consolidation",
  }),
  metadata: (t) => ({ vendorStack: t.vendorStack, evidenceUrl: t.evidenceUrl ?? null }),
};

export function runStackConsolidation(
  opts: StackConsolidationRunOptions,
): Promise<{ drafted: StackConsolidationDraft[] }> {
  return runEmailPlay(stackConsolidationDef, opts);
}

registerSequence({
  playName: PLAY_NAME,
  steps: [
    {
      dayOffset: 3,
      channel: "email",
      breakOnReply: true,
      label: "value follow-up",
      builder: buildFollowUpEmail({
        playName: PLAY_NAME,
        promptName: "stack-consolidation-followup",
        contextLines: [
          `PLAY: stack-consolidation. Day-3 value follow-up after the consolidation-honesty pitch.`,
        ],
      }),
    },
    {
      dayOffset: 8,
      channel: "email",
      breakOnReply: true,
      label: "breakup",
      builder: buildFollowUpEmail({
        playName: PLAY_NAME,
        promptName: "breakup-email",
        contextLines: [
          `PLAY: stack-consolidation. Final breakup after the consolidation-honesty pitch.`,
        ],
      }),
    },
  ],
});
