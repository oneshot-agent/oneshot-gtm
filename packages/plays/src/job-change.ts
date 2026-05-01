import { deepResearch, enrichProfile, getLedger, loadConfig } from "@oneshot-gtm/core";
import { draftEmailFromPrompt, lintEmail, sendDraftedEmail } from "./_lib.ts";
import { buildFollowUpEmail, enrollInCadence, registerSequence } from "./_cadence.ts";

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

export async function runJobChange(
  opts: JobChangeRunOptions,
): Promise<{ drafted: JobChangeDraft[] }> {
  const cfg = loadConfig();
  if (!cfg.founderName || !cfg.productOneLiner) {
    throw new Error("founder profile incomplete. Run: oneshot-gtm config founder");
  }
  const drafted: JobChangeDraft[] = [];

  for (const target of opts.targets) {
    const receiptIds: number[] = [];
    let dossier = "";

    if (!opts.dryRun) {
      const enr = await enrichProfile(
        {
          ...(target.email ? { email: target.email } : {}),
          ...(target.linkedinUrl ? { linkedinUrl: target.linkedinUrl } : {}),
          name: target.name,
        },
        { playName: PLAY_NAME },
      );
      receiptIds.push(enr.receiptId);
      dossier = JSON.stringify(enr.result, null, 2).slice(0, 4000);

      const research = await deepResearch(
        {
          topic: `Public posts, talks, and recent decisions by ${target.name} (joined ${target.newCompany} as ${target.newRole}, formerly ${target.previousRole ?? "?"} at ${target.previousCompany ?? "?"})`,
          depth: "quick",
        },
        { playName: PLAY_NAME },
      );
      receiptIds.push(research.receiptId);
      dossier += "\n\n---\n\n" + JSON.stringify(research.result, null, 2).slice(0, 4000);
    }

    const draft = await draftEmailFromPrompt({
      promptName: "job-change-email",
      inputBlock: [
        `FOUNDER: ${cfg.founderName}`,
        `PRODUCT: ${cfg.productOneLiner}`,
        `PROSPECT: ${target.name}`,
        `NEW ROLE: ${target.newRole} at ${target.newCompany}`,
        `PREVIOUS: ${target.previousRole ?? "unknown"} at ${target.previousCompany ?? "unknown"}`,
        `DOSSIER:\n${dossier || "(dry-run; rely on the trigger only)"}`,
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
        company: target.newCompany,
        linkedin_url: target.linkedinUrl ?? null,
        phone: target.phone ?? null,
        source: "job-change",
      },
      metadata: { newRole: target.newRole, newCompany: target.newCompany },
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
      dayOffset: 5,
      channel: "email",
      breakOnReply: true,
      label: "value follow-up",
      builder: buildFollowUpEmail({
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
        promptName: "breakup-email",
        contextLines: [`PLAY: job-change. Sender is closing the file.`],
      }),
    },
  ],
});
