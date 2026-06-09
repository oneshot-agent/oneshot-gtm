import { type EmailPlayDef, runEmailPlay, standardEnrich } from "./_run-play.ts";
import { buildFollowUpEmail, registerSequence } from "./_cadence.ts";

export interface AcceleratorBatchTarget {
  name: string;
  email: string;
  company: string;
  cohort: string;
  launchUrl?: string;
  productOneLiner?: string;
  linkedinUrl?: string;
  phone?: string;
  /** The SENDER's own cohort (peer angle). Stamped onto finder rows from the
   *  trigger config so the row is self-contained; falls back to the run-level
   *  option for manually-entered /run targets. */
  senderCohort?: string;
  /** Optional time-bound offer for the sender's cohort. Same fallback rules. */
  freeForCohortOffer?: string;
}

export interface AcceleratorBatchRunOptions {
  dryRun: boolean;
  targets: AcceleratorBatchTarget[];
  /** Per-target progress hook installed by /api/run SSE handler. */
  onProgress?: (
    index: number,
    draft: { subject: string; body: string; flags: string[]; sent: boolean; receiptIds: number[] },
  ) => void;
  /** Run-level fallback applied to any target that doesn't carry its own. */
  senderCohort?: string;
  freeForCohortOffer?: string;
}

export interface AcceleratorBatchDraft {
  target: AcceleratorBatchTarget;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
}

const PLAY_NAME = "accelerator-batch";

export function runAcceleratorBatch(
  opts: AcceleratorBatchRunOptions,
): Promise<{ drafted: AcceleratorBatchDraft[] }> {
  // senderCohort / freeForCohortOffer are read target-first (finder rows carry
  // their own, stamped from trigger config) with the run-level option as a
  // fallback for manually-entered /run targets. Built per-call to close over
  // that fallback.
  const senderCohortFor = (t: AcceleratorBatchTarget): string =>
    (t.senderCohort?.trim() || opts.senderCohort || "").trim();
  const offerFor = (t: AcceleratorBatchTarget): string | undefined =>
    t.freeForCohortOffer ?? opts.freeForCohortOffer;
  const def: EmailPlayDef<AcceleratorBatchTarget> = {
    playName: PLAY_NAME,
    promptName: "accelerator-batch-email",
    maxBodyWords: 150,
    enrollCadence: true,
    toEmail: (t) => t.email,
    // Enrich on both preview and real send (cached by email); deepResearch is
    // real-send only AND only when a launch URL is present to anchor it.
    prepare: (t, dryRun) =>
      standardEnrich({
        playName: PLAY_NAME,
        enrichInput: {
          ...(t.email ? { email: t.email } : {}),
          ...(t.linkedinUrl ? { linkedinUrl: t.linkedinUrl } : {}),
          name: t.name,
        },
        enrichSlice: 3500,
        ...(!dryRun && t.launchUrl
          ? {
              research: {
                topic: `Recent public work and decisions by ${t.name} at ${t.company} (${t.cohort}). Pull launch context from ${t.launchUrl}.`,
              },
            }
          : {}),
      }),
    buildInputBlock: (t, prep, cfg) =>
      [
        `FOUNDER: ${cfg.founderName}`,
        `PRODUCT: ${cfg.productOneLiner}`,
        `SENDER COHORT: ${senderCohortFor(t) || "(unspecified)"}`,
        `PROSPECT: ${t.name} at ${t.company}`,
        `PROSPECT COHORT: ${t.cohort}`,
        `PROSPECT PRODUCT: ${t.productOneLiner ?? "(unknown)"}`,
        `LAUNCH URL: ${t.launchUrl ?? "(none)"}`,
        `FREE-FOR-COHORT OFFER: ${offerFor(t) ?? "(no active offer for this cohort)"}`,
        `DOSSIER:\n${prep.dossier || "(dry-run; rely on the cohort match only)"}`,
      ].join("\n"),
    prospectMeta: (t) => ({
      name: t.name,
      email: t.email,
      company: t.company,
      linkedin_url: t.linkedinUrl ?? null,
      phone: t.phone ?? null,
      source: `accelerator-${t.cohort}`,
    }),
    metadata: (t) => ({
      senderCohort: senderCohortFor(t),
      prospectCohort: t.cohort,
    }),
  };

  return runEmailPlay(def, opts);
}

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
        promptName: "breakup-email",
        contextLines: [
          `PLAY: accelerator-batch. The accelerator-batch motion is one-touch + one breakup; this is the final note. Lean very short.`,
        ],
      }),
    },
  ],
});
