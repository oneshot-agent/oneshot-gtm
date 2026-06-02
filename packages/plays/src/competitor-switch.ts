import { browserTask } from "@oneshot-gtm/core";
import { emailDomain, safeEnrich } from "./_lib.ts";
import { type EmailPlayDef, runEmailPlay } from "./_run-play.ts";
import { buildFollowUpEmail, registerSequence } from "./_cadence.ts";

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

type CompetitorSwitchExtra = { scrapedEvidence?: string };

export function runCompetitorSwitch(
  opts: CompetitorSwitchRunOptions,
): Promise<{ drafted: CompetitorSwitchDraft[] }> {
  const def: EmailPlayDef<CompetitorSwitchTarget, CompetitorSwitchExtra> = {
    playName: PLAY_NAME,
    promptName: "competitor-switch-email",
    maxBodyWords: 100,
    enrollCadence: true,
    toEmail: (t) => t.email,
    prepare: async (t, dryRun) => {
      const receiptIds: number[] = [];
      let scrapedEvidence: string | undefined;

      // Enrich on both preview and real send (cached by email).
      const enr = await safeEnrich(
        {
          ...(t.email ? { email: t.email } : {}),
          name: t.name,
          companyDomain: emailDomain(t.email),
        },
        { playName: PLAY_NAME },
      );
      if (enr.receiptId) receiptIds.push(enr.receiptId);
      const dossier = JSON.stringify(enr.result, null, 2).slice(0, 3500);

      if (!dryRun) {
        // Skip the browserTask scrape when evidenceText was already supplied
        // (or when the founder explicitly opts out). Two reasons:
        // 1. The github-topics finder enqueues both — it builds evidenceText
        //    from the manifest scan and sets evidenceUrl to the repo. Scraping
        //    a code page for "pain points" returns nothing useful; the manifest-
        //    derived stitch line IS the evidence.
        // 2. browserTask is the slowest call in the SDK (maxSteps:12, easily
        //    30s-3min on JS-heavy pages). Re-scraping when we already have
        //    evidence wastes time + ~$0.30+ in browser-task spend.
        // The scrape still fires when the founder pasted only an evidenceUrl
        // (e.g. a G2 review page) — that's when extracting structured pain-
        // points actually pays off.
        const haveEvidenceText =
          typeof t.evidenceText === "string" && t.evidenceText.trim().length > 0;
        if (t.evidenceUrl && !opts.skipBrowserScrape && !haveEvidenceText) {
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

      return {
        receiptIds,
        dossier,
        ...(scrapedEvidence ? { extra: { scrapedEvidence } } : {}),
      };
    },
    buildInputBlock: (t, prep, cfg) => {
      const evidence = prep.extra?.scrapedEvidence ?? t.evidenceText ?? "(no evidence supplied)";
      return [
        `FOUNDER: ${cfg.founderName}`,
        `PRODUCT: ${cfg.productOneLiner}`,
        `PROSPECT: ${t.name} at ${t.company}`,
        `COMPETITOR: ${t.competitor}`,
        `EVIDENCE: ${evidence}`,
        `YOUR EDGE: ${t.yourEdge}`,
        `DOSSIER:\n${prep.dossier || "(dry-run)"}`,
      ].join("\n");
    },
    prospectMeta: (t) => ({
      name: t.name,
      email: t.email,
      company: t.company,
      linkedin_url: t.linkedinUrl ?? null,
      phone: t.phone ?? null,
      source: "competitor-switch",
    }),
    metadata: (t) => ({ competitor: t.competitor, evidenceUrl: t.evidenceUrl ?? null }),
  };

  return runEmailPlay(def, opts);
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
        promptName: "competitor-switch-followup",
        contextLines: [
          `PLAY: competitor-switch. Day-3 value follow-up after the migration-honesty pitch.`,
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
          `PLAY: competitor-switch. Final breakup after the migration-honesty pitch.`,
        ],
      }),
    },
  ],
});
