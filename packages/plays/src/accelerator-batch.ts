import { deepResearch, getLedger, loadConfig } from "@oneshot-gtm/core";
import {
  draftEmailFromPrompt,
  errorDraft,
  lintEmail,
  safeEnrich,
  sendDraftedEmail,
} from "./_lib.ts";
import { buildFollowUpEmail, enrollInCadence, registerSequence } from "./_cadence.ts";

export type AcceleratorCohort =
  | "yc-w26"
  | "yc-s26"
  | "yc-w25"
  | "yc-s25"
  | "od"
  | "spc"
  | "antler"
  | "techstars"
  | "neo"
  | "soma"
  | "other";

export interface AcceleratorBatchTarget {
  name: string;
  email: string;
  company: string;
  cohort: string;
  launchUrl?: string;
  productOneLiner?: string;
  linkedinUrl?: string;
  phone?: string;
}

export interface AcceleratorBatchRunOptions {
  dryRun: boolean;
  targets: AcceleratorBatchTarget[];
  senderCohort: string;
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

export async function runAcceleratorBatch(
  opts: AcceleratorBatchRunOptions,
): Promise<{ drafted: AcceleratorBatchDraft[] }> {
  const cfg = loadConfig();
  if (!cfg.founderName || !cfg.productOneLiner) {
    throw new Error("founder profile incomplete. Run: oneshot-gtm config founder");
  }
  const drafted: AcceleratorBatchDraft[] = [];

  for (const target of opts.targets) {
   try {
    const receiptIds: number[] = [];

    // Enrich on both preview and real send (cached by email) so the reviewed
    // draft is personalized; the heavier deepResearch stays real-send only.
    const enr = await safeEnrich(
      {
        ...(target.email ? { email: target.email } : {}),
        ...(target.linkedinUrl ? { linkedinUrl: target.linkedinUrl } : {}),
        name: target.name,
      },
      { playName: PLAY_NAME },
    );
    if (enr.receiptId) receiptIds.push(enr.receiptId);
    let dossier = JSON.stringify(enr.result, null, 2).slice(0, 3500);

    if (!opts.dryRun) {
      if (target.launchUrl) {
        const research = await deepResearch(
          {
            topic: `Recent public work and decisions by ${target.name} at ${target.company} (${target.cohort}). Pull launch context from ${target.launchUrl}.`,
            depth: "quick",
          },
          { playName: PLAY_NAME },
        );
        receiptIds.push(research.receiptId);
        dossier += "\n\n---\n\n" + JSON.stringify(research.result, null, 2).slice(0, 4000);
      }
    }

    const draft = await draftEmailFromPrompt({
      promptName: "accelerator-batch-email",
      inputBlock: [
        `FOUNDER: ${cfg.founderName}`,
        `PRODUCT: ${cfg.productOneLiner}`,
        `SENDER COHORT: ${opts.senderCohort}`,
        `PROSPECT: ${target.name} at ${target.company}`,
        `PROSPECT COHORT: ${target.cohort}`,
        `PROSPECT PRODUCT: ${target.productOneLiner ?? "(unknown)"}`,
        `LAUNCH URL: ${target.launchUrl ?? "(none)"}`,
        `FREE-FOR-COHORT OFFER: ${opts.freeForCohortOffer ?? "(no active offer for this cohort)"}`,
        `DOSSIER:\n${dossier || "(dry-run; rely on the cohort match only)"}`,
      ].join("\n"),
    });

    const flags = lintEmail(draft.subject, draft.body, 100);

    const send = await sendDraftedEmail({
      playName: PLAY_NAME,
      to: target.email,
      draft,
      flags,
      prospectMeta: {
        name: target.name,
        email: target.email,
        company: target.company,
        linkedin_url: target.linkedinUrl ?? null,
        phone: target.phone ?? null,
        source: `accelerator-${target.cohort}`,
      },
      metadata: {
        senderCohort: opts.senderCohort,
        prospectCohort: target.cohort,
      },
      dryRun: opts.dryRun,
    });

    if (send.sent) {
      const ledger = getLedger();
      const prospect = ledger.findProspectByEmail(target.email);
      if (prospect) {
        enrollInCadence({ prospectId: prospect.id, playName: PLAY_NAME });
      }
    }

    drafted.push({
      target,
      subject: draft.subject,
      body: draft.body,
      receiptIds: [...receiptIds, ...send.receiptIds],
      sent: send.sent,
      flags,
    });
   } catch (err) {
    drafted.push({ target, ...errorDraft((err as Error)?.message) });
   }
  }

  return { drafted };
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
