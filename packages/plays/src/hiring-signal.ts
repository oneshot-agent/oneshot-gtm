import { getLedger, loadConfig, webRead, webSearch } from "@oneshot-gtm/core";
import { draftEmailFromPrompt, lintEmail, sendDraftedEmail } from "./_lib.ts";
import { buildFollowUpEmail, enrollInCadence, registerSequence } from "./_cadence.ts";

const PLAY_NAME = "hiring-signal";

export interface HiringSignalTarget {
  /** Hiring manager / function head receiving the email. */
  name: string;
  email: string;
  company: string;
  /** Job title to search for. */
  jobTitle: string;
  /** Optional direct URL to a known job post — skips the search. */
  jobPostUrl?: string;
  /** Your one-line claim about how your product compresses ramp time for this role. */
  yourClaim: string;
  linkedinUrl?: string;
  phone?: string;
}

export interface HiringSignalRunOptions {
  dryRun: boolean;
  targets: HiringSignalTarget[];
  /** Skip the web-search/read steps. */
  skipScrape?: boolean;
}

export interface HiringSignalDraft {
  target: HiringSignalTarget;
  subject: string;
  body: string;
  jobPostHook: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
}

export async function runHiringSignal(
  opts: HiringSignalRunOptions,
): Promise<{ drafted: HiringSignalDraft[] }> {
  const cfg = loadConfig();
  if (!cfg.founderName || !cfg.productOneLiner) {
    throw new Error("founder profile incomplete. Run: oneshot-gtm config founder");
  }
  const drafted: HiringSignalDraft[] = [];

  for (const t of opts.targets) {
    const receiptIds: number[] = [];
    let jobPostHook = "(no specific job post phrase scraped)";

    if (!opts.dryRun) {
      let jobUrl: string | undefined = t.jobPostUrl;
      if (!jobUrl && !opts.skipScrape) {
        const search = await webSearch(
          {
            query: `${t.company} careers ${t.jobTitle} site:lever.co OR site:greenhouse.io OR site:workable.com OR site:ashbyhq.com`,
            maxResults: 5,
          },
          { playName: PLAY_NAME },
        );
        receiptIds.push(search.receiptId);
        jobUrl = search.result.results[0]?.url;
      }

      if (jobUrl) {
        const read = await webRead({ url: jobUrl }, { playName: PLAY_NAME });
        receiptIds.push(read.receiptId);
        const md = read.result.markdown ?? "";
        // Find a load-bearing phrase: first non-trivial sentence after 'About the role' or 'Responsibilities' if present.
        const hookMatch = md.match(
          /(?:About the role|Responsibilities|Requirements|What you[' ]?ll do)[^\n]*\n+([\s\S]{40,300})/i,
        );
        jobPostHook = (hookMatch?.[1] ?? md.slice(0, 400)).replace(/\s+/g, " ").trim();
      }
    }

    const draft = await draftEmailFromPrompt({
      promptName: "hiring-signal-email",
      inputBlock: [
        `FOUNDER: ${cfg.founderName}`,
        `PRODUCT: ${cfg.productOneLiner}`,
        `PROSPECT: ${t.name} at ${t.company}`,
        `JOB TITLE: ${t.jobTitle}`,
        `JOB POST HOOK (real phrase from the post): ${jobPostHook}`,
        `YOUR CLAIM: ${t.yourClaim}`,
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
        source: "hiring-signal",
      },
      metadata: { jobTitle: t.jobTitle, jobPostUrl: t.jobPostUrl ?? null },
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
      jobPostHook,
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
      dayOffset: 3,
      channel: "email",
      breakOnReply: true,
      label: "value follow-up",
      builder: buildFollowUpEmail({
        promptName: "hiring-signal-followup",
        contextLines: [`PLAY: hiring-signal. Day-3 value follow-up about the open role.`],
      }),
    },
    {
      dayOffset: 8,
      channel: "email",
      breakOnReply: true,
      label: "breakup",
      builder: buildFollowUpEmail({
        promptName: "breakup-email",
        contextLines: [`PLAY: hiring-signal. Final breakup.`],
      }),
    },
  ],
});
