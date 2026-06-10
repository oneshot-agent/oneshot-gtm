import { webRead, webSearch } from "@oneshot-gtm/core";
import { type EmailPlayDef, runEmailPlay } from "./_run-play.ts";
import { buildFollowUpEmail, registerSequence } from "./_cadence.ts";

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
  /** Per-target progress hook installed by /api/run SSE handler. */
  onProgress?: (
    index: number,
    draft: { subject: string; body: string; flags: string[]; sent: boolean; receiptIds: number[] },
  ) => void;
  /** Skip the web-search/read steps. */
  skipScrape?: boolean;
}

interface HiringSignalDraft {
  target: HiringSignalTarget;
  subject: string;
  body: string;
  jobPostHook: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
}

type HiringSignalExtra = { jobPostHook: string };

const NO_HOOK = "(no specific job post phrase scraped)";

export function runHiringSignal(
  opts: HiringSignalRunOptions,
): Promise<{ drafted: HiringSignalDraft[] }> {
  const def: EmailPlayDef<HiringSignalTarget, HiringSignalExtra> = {
    playName: PLAY_NAME,
    promptName: "hiring-signal-email",
    maxBodyWords: 150,
    enrollCadence: true,
    errorExtra: { jobPostHook: "(error)" },
    toEmail: (t) => t.email,
    prepare: async (t, dryRun) => {
      const receiptIds: number[] = [];
      let jobPostHook = NO_HOOK;

      if (!dryRun) {
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

      return { receiptIds, dossier: "", extra: { jobPostHook } };
    },
    buildInputBlock: (t, prep, cfg) =>
      [
        `FOUNDER: ${cfg.founderName}`,
        `PRODUCT: ${cfg.productOneLiner}`,
        `PROSPECT: ${t.name} at ${t.company}`,
        `JOB TITLE: ${t.jobTitle}`,
        `JOB POST HOOK (real phrase from the post): ${prep.extra?.jobPostHook ?? NO_HOOK}`,
        `YOUR CLAIM: ${t.yourClaim}`,
      ].join("\n"),
    prospectMeta: (t) => ({
      name: t.name,
      email: t.email,
      company: t.company,
      linkedin_url: t.linkedinUrl ?? null,
      phone: t.phone ?? null,
      source: "hiring-signal",
    }),
    metadata: (t) => ({ jobTitle: t.jobTitle, jobPostUrl: t.jobPostUrl ?? null }),
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
        playName: PLAY_NAME,
        promptName: "breakup-email",
        contextLines: [`PLAY: hiring-signal. Final breakup.`],
      }),
    },
  ],
});
