import { browserTask, enrichProfile, getLedger, loadConfig } from "@oneshot-gtm/core";
import { draftEmailFromPrompt, lintEmail, sendDraftedEmail } from "./_lib.ts";
import { buildFollowUpEmail, enrollInCadence, registerSequence } from "./_cadence.ts";

const PLAY_NAME = "competitor-switch";

export interface CompetitorSwitchTarget {
  name: string;
  email: string;
  company: string;
  competitor: string;
  /** Optional URL to scrape (G2 review page, BuiltWith page, public job post). */
  evidenceUrl?: string;
  /** Optional pre-supplied evidence string. */
  evidenceText?: string;
  /** Your product's specific advantage over this competitor (one fact). */
  yourEdge: string;
  linkedinUrl?: string;
  phone?: string;
}

export interface CompetitorSwitchRunOptions {
  dryRun: boolean;
  targets: CompetitorSwitchTarget[];
  /** Skip the browser-scraping step even if evidenceUrl is set. */
  skipBrowserScrape?: boolean;
}

export interface CompetitorSwitchDraft {
  target: CompetitorSwitchTarget;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
  scrapedEvidence?: string;
}

export async function runCompetitorSwitch(
  opts: CompetitorSwitchRunOptions,
): Promise<{ drafted: CompetitorSwitchDraft[] }> {
  const cfg = loadConfig();
  if (!cfg.founderName || !cfg.productOneLiner) {
    throw new Error("founder profile incomplete. Run: oneshot-gtm config founder");
  }
  const drafted: CompetitorSwitchDraft[] = [];

  for (const t of opts.targets) {
    const receiptIds: number[] = [];
    let scrapedEvidence: string | undefined;
    let dossier = "";

    if (!opts.dryRun) {
      const enr = await enrichProfile(
        {
          ...(t.email ? { email: t.email } : {}),
          name: t.name,
          companyDomain: extractDomain(t.email),
        },
        { playName: PLAY_NAME },
      );
      receiptIds.push(enr.receiptId);
      dossier = JSON.stringify(enr.result, null, 2).slice(0, 3500);

      if (t.evidenceUrl && !opts.skipBrowserScrape) {
        const browse = await browserTask(
          {
            task: `Read the page at ${t.evidenceUrl} and extract: (1) any specific complaints or pain points the user mentioned about ${t.competitor}, (2) any mentions of features they wished existed, (3) any context about company size or use case. Return concise structured JSON.`,
            startUrl: t.evidenceUrl,
            outputSchema: {
              type: "object",
              properties: {
                pain_points: { type: "array", items: { type: "string" } },
                wished_features: { type: "array", items: { type: "string" } },
                use_case_context: { type: "string" },
              },
            },
            maxSteps: 12,
          },
          { playName: PLAY_NAME },
        );
        receiptIds.push(browse.receiptId);
        scrapedEvidence =
          typeof browse.result.output === "string"
            ? browse.result.output
            : JSON.stringify(browse.result.output ?? {});
      }
    }

    const evidence = scrapedEvidence ?? t.evidenceText ?? "(no evidence supplied)";

    const draft = await draftEmailFromPrompt({
      promptName: "competitor-switch-email",
      inputBlock: [
        `FOUNDER: ${cfg.founderName}`,
        `PRODUCT: ${cfg.productOneLiner}`,
        `PROSPECT: ${t.name} at ${t.company}`,
        `COMPETITOR: ${t.competitor}`,
        `EVIDENCE: ${evidence}`,
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
        source: "competitor-switch",
      },
      metadata: { competitor: t.competitor, evidenceUrl: t.evidenceUrl ?? null },
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
      ...(scrapedEvidence ? { scrapedEvidence } : {}),
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
      dayOffset: 7,
      channel: "email",
      breakOnReply: true,
      label: "breakup",
      builder: buildFollowUpEmail({
        promptName: "breakup-email",
        contextLines: [
          `PLAY: competitor-switch. Single follow-up after the migration-honesty pitch.`,
        ],
      }),
    },
  ],
});
