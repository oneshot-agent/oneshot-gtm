import { deepResearch, getLedger, loadConfig } from "@oneshot-gtm/core";
import { draftEmailFromPrompt, lintEmail, safeEnrich, sendDraftedEmail } from "./_lib.ts";
import { buildFollowUpEmail, enrollInCadence, registerSequence } from "./_cadence.ts";

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

export async function runPostFunding(
  opts: PostFundingRunOptions,
): Promise<{ drafted: PostFundingDraft[] }> {
  const cfg = loadConfig();
  if (!cfg.founderName || !cfg.productOneLiner) {
    throw new Error("founder profile incomplete. Run: oneshot-gtm config founder");
  }
  const drafted: PostFundingDraft[] = [];

  for (const target of opts.targets) {
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
      const research = await deepResearch(
        {
          topic: `${target.company} ${target.round} announcement: open job postings, hiring page, public roadmap, named challenges in the press release. Source: ${target.sourceUrl}`,
          depth: "quick",
        },
        { playName: PLAY_NAME },
      );
      receiptIds.push(research.receiptId);
      dossier += "\n\n---\n\n" + JSON.stringify(research.result, null, 2).slice(0, 4000);
    }

    const draft = await draftEmailFromPrompt({
      promptName: "post-funding-email",
      inputBlock: [
        `FOUNDER: ${cfg.founderName}`,
        `PRODUCT: ${cfg.productOneLiner}`,
        `PROSPECT: ${target.name} at ${target.company}`,
        `ROUND: ${target.round} ($${target.amountUsd.toLocaleString()})`,
        `LEAD INVESTOR: ${target.leadInvestor ?? "(unspecified)"}`,
        `SOURCE: ${target.sourceUrl}`,
        `DOSSIER:\n${dossier || "(dry-run; rely on the round details only)"}`,
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
        source: "post-funding",
      },
      metadata: {
        round: target.round,
        amountUsd: target.amountUsd,
        leadInvestor: target.leadInvestor,
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
  }

  return { drafted };
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
