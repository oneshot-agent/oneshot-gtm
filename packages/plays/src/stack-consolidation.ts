import { getLedger, loadConfig } from "@oneshot-gtm/core";
import { draftEmailFromPrompt, lintEmail, safeEnrich, sendDraftedEmail } from "./_lib.ts";
import { buildFollowUpEmail, enrollInCadence, registerSequence } from "./_cadence.ts";

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

export async function runStackConsolidation(
  opts: StackConsolidationRunOptions,
): Promise<{ drafted: StackConsolidationDraft[] }> {
  const cfg = loadConfig();
  if (!cfg.founderName || !cfg.productOneLiner) {
    throw new Error("founder profile incomplete. Run: oneshot-gtm config founder");
  }
  const drafted: StackConsolidationDraft[] = [];

  for (const t of opts.targets) {
    const receiptIds: number[] = [];

    // Enrich on both preview and real send so the reviewed draft is
    // personalized. safeEnrich is cached by email, so repeated previews / a
    // later verbatim send reuse the same lookup (no extra ~70s or spend).
    const enr = await safeEnrich(
      {
        ...(t.email ? { email: t.email } : {}),
        name: t.name,
        companyDomain: extractDomain(t.email),
      },
      { playName: PLAY_NAME },
    );
    if (enr.receiptId) receiptIds.push(enr.receiptId);
    const dossier = JSON.stringify(enr.result, null, 2).slice(0, 3500);

    const draft = await draftEmailFromPrompt({
      promptName: "stack-consolidation-email",
      inputBlock: [
        `FOUNDER: ${cfg.founderName}`,
        `PRODUCT: ${cfg.productOneLiner}`,
        `PROSPECT: ${t.name} at ${t.company}`,
        `STACK: ${t.vendorStack}`,
        `YOUR EDGE: ${t.yourEdge}`,
        `DOSSIER:\n${dossier || "(dry-run)"}`,
      ].join("\n"),
    });

    const flags = lintEmail(draft.subject, draft.body, 100);

    const send = await sendDraftedEmail({
      playName: PLAY_NAME,
      to: t.email,
      draft,
      flags,
      prospectMeta: {
        name: t.name,
        email: t.email,
        company: t.company,
        linkedin_url: t.linkedinUrl ?? null,
        phone: t.phone ?? null,
        source: "stack-consolidation",
      },
      metadata: { vendorStack: t.vendorStack, evidenceUrl: t.evidenceUrl ?? null },
      dryRun: opts.dryRun,
    });

    if (send.sent) {
      const ledger = getLedger();
      const prospect = ledger.findProspectByEmail(t.email);
      if (prospect) enrollInCadence({ prospectId: prospect.id, playName: PLAY_NAME });
    }

    drafted.push({
      target: t,
      subject: draft.subject,
      body: draft.body,
      receiptIds: [...receiptIds, ...send.receiptIds],
      sent: send.sent,
      flags,
    });
  }

  return { drafted };
}

function extractDomain(email: string): string | undefined {
  const at = email.indexOf("@");
  if (at < 0) return undefined;
  return email.slice(at + 1);
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
        promptName: "breakup-email",
        contextLines: [
          `PLAY: stack-consolidation. Final breakup after the consolidation-honesty pitch.`,
        ],
      }),
    },
  ],
});
