import type { DraftAngle } from "@oneshot-gtm/shared-types";
import { loadConfig } from "@oneshot-gtm/core";
import { type EmailPlayDef, runEmailPlay, standardEnrich } from "./_run-play.ts";
import { acceleratorBatchMetadata } from "./_metadata.ts";
import { buildFollowUpEmail, registerSequence } from "./_cadence.ts";

export interface AcceleratorBatchTarget {
  name: string;
  email: string;
  company: string;
  cohort: string;
  /** Human program name ("YC Summer 2026"). The row's signal label; the slug stays for scoring. */
  cohortLabel?: string;
  /** `2026-03`: the cohort's demo-day month, stamped when its schedule is known. Status is computed at draft time. */
  demoDayMonth?: string;
  launchUrl?: string;
  productOneLiner?: string;
  linkedinUrl?: string;
  phone?: string;
  /** Job title from the person-level ICP gate: persisted to prospects.title. */
  title?: string;
  /** The pitch angle, stamped onto finder rows from the trigger config (as
   *  every other finder stamps it) so the row drafts inline. */
  yourEdge: string;
  /**
   * Legacy fields accepted only for queue-row deserialization; never read.
   * Sender affiliation comes from `founderCohort` in config at draft time,
   * so stale row data cannot invent membership. Cold discounts are banned.
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
  /** Abort signal for the run: see `runEmailPlay`'s `signal`. */
  signal?: AbortSignal;
  /** Explicit draft argument chosen by the user; bypasses automatic angle selection. */
  draftAngle?: string;
}

interface AcceleratorBatchDraft {
  target: AcceleratorBatchTarget;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
  /** Which edge angle the runner built the draft on (see `PlayDraft.angle`). */
  angle?: DraftAngle;
}

const PLAY_NAME = "accelerator-batch";

export function runAcceleratorBatch(
  opts: AcceleratorBatchRunOptions,
): Promise<{ drafted: AcceleratorBatchDraft[] }> {
  // Read sender affiliation only from config. Omit SENDER COHORT when unset
  // so target data and stale run options cannot invent a membership claim.
  const founderCohort = (loadConfig().founderCohort ?? "").trim();
  const def: EmailPlayDef<AcceleratorBatchTarget> = {
    playName: PLAY_NAME,
    promptName: "accelerator-batch-email",
    maxBodyWords: 150,
    // Enforce the prompt's link, price, and discount bans, as discovery-interview does.
    hardBans: true,
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
    buildInputBlock: (t, prep, cfg) => {
      // Missing edges must fail before a paid draft call. runEmailPlay turns this
      // into an errorDraft for /queue instead of drafting from "undefined".
      if (!t.yourEdge?.trim()) {
        throw new Error(
          "accelerator-batch: this row carries no yourEdge — re-run the finder, or set it on the row, before drafting",
        );
      }
      return [
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
      ].join("\n");
    },
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
      // Always the plain breakup, never `pilotOrBreakup`: a company still in
      // its batch is not who a configured pilot offer is for.
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
