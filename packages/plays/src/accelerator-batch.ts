import { loadConfig } from "@oneshot-gtm/core";
import { type EmailPlayDef, runEmailPlay, standardEnrich } from "./_run-play.ts";
import { acceleratorBatchMetadata } from "./_metadata.ts";
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
  /** Job title from the person-level ICP gate — persisted to prospects.title. */
  title?: string;
  /** The pitch angle, stamped onto finder rows from the trigger config (as
   *  every other finder stamps it) so the row drafts inline. */
  yourEdge: string;
  /**
   * DEAD FIELDS, accepted so pre-existing queue rows still deserialize, never
   * read. The sender's own cohort used to ride on the row, stamped from a
   * trigger field a readiness gate made mandatory — which is exactly how
   * installs ended up claiming a batch the founder was never in. Affiliation
   * now comes from `founderCohort` in config, read once at draft time, so a
   * stale stamp on an old row cannot resurrect the claim. `freeForCohortOffer`
   * is gone outright: a cold discount is banned by _humanizer.md.
   */
  senderCohort?: string;
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
  /** Abort signal for the run — see `runEmailPlay`'s `signal`. */
  signal?: AbortSignal;
}

interface AcceleratorBatchDraft {
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
  // The sender's affiliation is founder truth, so it comes from config and
  // nowhere else — not from the target, not from the run options, both of
  // which may still carry a fabricated cohort stamped by an older install.
  // Absent (the honest default for most founders) the prompt gets no SENDER
  // COHORT line at all and writes as the outsider it is.
  const founderCohort = (loadConfig().founderCohort ?? "").trim();
  const def: EmailPlayDef<AcceleratorBatchTarget> = {
    playName: PLAY_NAME,
    promptName: "accelerator-batch-email",
    maxBodyWords: 150,
    enrollCadence: true,
    toEmail: (t) => t.email,
    // Enrich on both preview and real send (cached by email); deepResearch is
    // real-send only AND only when a launch URL is present to anchor it.
    prepare: (t, dryRun, signal) =>
      standardEnrich({
        playName: PLAY_NAME,
        enrichInput: {
          ...(t.email ? { email: t.email } : {}),
          ...(t.linkedinUrl ? { linkedinUrl: t.linkedinUrl } : {}),
          name: t.name,
        },
        enrichSlice: 3500,
        ...(signal ? { signal } : {}),
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
        `YOUR EDGE: ${t.yourEdge}`,
        // Emitted ONLY when the founder actually was in a batch. A
        // "(unspecified)" placeholder is an invitation to improvise one.
        ...(founderCohort ? [`SENDER COHORT: ${founderCohort}`] : []),
        `PROSPECT: ${t.name} at ${t.company}`,
        `PROSPECT COHORT: ${t.cohort}`,
        `PROSPECT PRODUCT: ${t.productOneLiner ?? "(unknown)"}`,
        `LAUNCH URL: ${t.launchUrl ?? "(none)"}`,
        `DOSSIER:\n${prep.dossier || "(dry-run; rely on the public cohort record only)"}`,
      ].join("\n"),
    prospectMeta: (t) => ({
      name: t.name,
      email: t.email,
      company: t.company,
      linkedin_url: t.linkedinUrl ?? null,
      phone: t.phone ?? null,
      source: `accelerator-${t.cohort}`,
    }),
    // Shared fn + the config value _metadata.ts is contractually barred from
    // reading (pure target -> metadata, no config, no I/O).
    metadata: (t) => ({
      ...acceleratorBatchMetadata(t),
      senderCohort: founderCohort || null,
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
