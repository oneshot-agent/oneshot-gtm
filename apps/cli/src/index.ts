#!/usr/bin/env bun
import { Command } from "commander";
import { fail } from "./output.ts";
import { runInit } from "./commands/init.ts";
import {
  configFounder,
  configIcpSet,
  configIcpShow,
  configKeys,
  configLlm,
  configTelemetry,
} from "./commands/config.ts";
import { commandDoctor } from "./commands/doctor.ts";
import {
  commandIntelAdvise,
  commandIntelPersonalize,
  commandIntelTriage,
  commandIntelWeeklyReview,
} from "./commands/intel.ts";
import {
  commandIcpInterviewPrep,
  commandIcpSynthesize,
  commandPmfClassify,
  commandPmfSurvey,
  commandPmfSurveyCollect,
} from "./commands/discover.ts";
import {
  commandHandoffFirstAe,
  commandHandoffReadiness,
  commandHandoffTemplatize,
} from "./commands/handoff.ts";
import {
  commandCadenceAdvance,
  commandCadenceList,
  commandCadenceStop,
} from "./commands/cadence.ts";
import { commandUi } from "./commands/ui.ts";
import {
  commandFindAcceleratorBatch,
  commandFindApprove,
  commandFindDrain,
  commandFindHiringSignal,
  commandFindJobChange,
  commandFindPodcastGuest,
  commandFindPostFunding,
  commandFindQueue,
  commandFindReject,
  commandFindShowHn,
  commandFindWatch,
} from "./commands/find.ts";
import {
  commandMotionAcceleratorBatch,
  commandMotionBreakupRevive,
  commandMotionCompetitorSwitch,
  commandMotionConcierge,
  commandMotionDemoNoShow,
  commandMotionHiringSignal,
  commandMotionJobChange,
  commandMotionPodcastGuest,
  commandMotionPostFunding,
  commandMotionShowHn,
} from "./commands/motion.ts";
import {
  commandMeasureCac,
  commandMeasureOutcome,
  commandMeasureReceipt,
  commandMeasureRocs,
} from "./commands/measure.ts";

const program = new Command();
program
  .name("oneshot-gtm")
  .description("Open-source GTM agent for technical founders. Pay-per-result. Signed receipts.")
  .version("0.1.0");

program.command("init").description("First-run setup wizard").action(runOrFail(runInit));

const config = program.command("config").description("Configure providers and profile");
config.command("llm").description("Pick LLM provider and model").action(runOrFail(configLlm));
config
  .command("founder")
  .description("Set founder name, email, product one-liner")
  .action(runOrFail(configFounder));
config
  .command("keys")
  .description(
    "Set or update API keys (LLM + OneShot wallet) — saved chmod 600 to ~/.oneshot-gtm/.env",
  )
  .action(runOrFail(configKeys));
config
  .command("telemetry <state>")
  .description("Enable or disable opt-out telemetry (on|off)")
  .action(runOrFail((state: string) => configTelemetry(state === "on" ? "on" : "off")));

const configIcp = config
  .command("icp")
  .description("Manage the ICP one-liner used by the find layer's classifier");
configIcp
  .command("set <oneLiner>")
  .description('Save a one-liner ICP statement, e.g. "developers shipping autonomous AI agents..."')
  .action(runOrFail(configIcpSet));
configIcp
  .command("show")
  .description("Print the current ICP one-liner")
  .action(runOrFail(configIcpShow));

program.command("doctor").description("Check setup health").action(runOrFail(commandDoctor));

program
  .command("ui")
  .option(
    "--port <n>",
    "port for the API server (default 3030)",
    (v) => Number.parseInt(v, 10),
    3030,
  )
  .option("--no-browser", "do not auto-open the browser")
  .option("--dev", "use vite dev server (5173) + API server", false)
  .description("Open the local dashboard at http://127.0.0.1:<port>")
  .action(
    runOrFail(async (opts: { port: number; browser: boolean; dev: boolean }) => {
      await commandUi({ port: opts.port, noBrowser: !opts.browser, dev: opts.dev });
    }),
  );

const discover = program.command("discover").description("Find your people, prove they want it");
const icp = discover.command("icp").description("ICP discovery loop");
icp
  .command("interview-prep [hypothesis]")
  .option("-o, --out <path>", "write to file instead of stdout")
  .option("-f, --from-file <path>", "read hypothesis from a file (use this for long ones)")
  .option("--stdin", "read hypothesis from stdin (e.g. echo '...' | oneshot-gtm ...)")
  .description(
    "Generate a Mom Test + JTBD interview script. Hypothesis can be an arg, a file, stdin, or interactive prompt.",
  )
  .action(
    runOrFail(
      async (
        hypothesis: string | undefined,
        opts: { out?: string; fromFile?: string; stdin?: boolean },
      ) => {
        await commandIcpInterviewPrep(hypothesis, {
          ...(opts.out ? { out: opts.out } : {}),
          ...(opts.fromFile ? { fromFile: opts.fromFile } : {}),
          ...(opts.stdin ? { stdin: opts.stdin } : {}),
        });
      },
    ),
  );
icp
  .command("synthesize <transcriptDir>")
  .description("Extract JTBD, pain quotes, switch moment, ICP language from interview transcripts")
  .action(runOrFail(commandIcpSynthesize));

const pmf = discover
  .command("pmf")
  .description("Product-market-fit measurement and classification");
pmf
  .command("classify")
  .description("Sequoia Arc + Balfour Four Fits classifier (6 questions, no OneShot calls)")
  .action(runOrFail(commandPmfClassify));
pmf
  .command("survey")
  .requiredOption("-c, --cohort <file>", "file with cohort emails (one per line, or JSON array)")
  .option("--product-name <name>", "product name for the landing page")
  .option("--product-description <text>", "10-200 char description for the landing page")
  .option("--custom-survey-url <url>", "skip OneShot Build and use this URL instead")
  .option("--primary-color <hex>", "brand primary color (e.g. #FF5733)")
  .option("--dry-run", "draft only; do not build site or send", false)
  .description("Deploy a Superhuman 5-question PMF survey via OneShot Build + Email")
  .action(runOrFail(commandPmfSurvey));
pmf
  .command("survey-collect")
  .option("-s, --since-days <n>", "collect inbound from the last N days", (v) =>
    Number.parseInt(v, 10),
  )
  .option("-o, --out <path>", "write analysis markdown to this file")
  .description("Collect inbound replies and synthesize a Sean Ellis report")
  .action(runOrFail(commandPmfSurveyCollect));

const motion = program.command("motion").description("Run a named GTM play");
motion
  .command("show-hn")
  .requiredOption("-t, --target <file>", "JSON file with array of Show HN targets")
  .option("--dry-run", "draft only, do not send", false)
  .description("Founder-to-founder one-touch reply to a Show HN post")
  .action(
    runOrFail(async (opts: { target: string; dryRun: boolean }) => {
      await commandMotionShowHn({ targetFile: opts.target, dryRun: opts.dryRun });
    }),
  );
motion
  .command("job-change")
  .requiredOption("-t, --target <file>", "JSON file with array of job-change targets")
  .option("--dry-run", "draft only, do not send", false)
  .description("Trigger play: prospect started a new role at a target company")
  .action(
    runOrFail(async (opts: { target: string; dryRun: boolean }) => {
      await commandMotionJobChange({ targetFile: opts.target, dryRun: opts.dryRun });
    }),
  );
motion
  .command("post-funding")
  .requiredOption("-t, --target <file>", "JSON file with array of post-funding targets")
  .option("--dry-run", "draft only, do not send", false)
  .description("Trigger play: prospect's company recently raised (send day 3+, not day 0)")
  .action(
    runOrFail(async (opts: { target: string; dryRun: boolean }) => {
      await commandMotionPostFunding({ targetFile: opts.target, dryRun: opts.dryRun });
    }),
  );
motion
  .command("accelerator-batch")
  .requiredOption("-t, --target <file>", "JSON file with array of cohort targets")
  .requiredOption(
    "--sender-cohort <cohort>",
    "your accelerator/cohort tag (e.g. yc-w23, od-2024, spc-23)",
  )
  .option("--offer <text>", "free-for-cohort offer text to include if applicable")
  .option("--dry-run", "draft only, do not send", false)
  .description("Founder-to-founder outreach to current/adjacent accelerator batch")
  .action(
    runOrFail(
      async (opts: { target: string; senderCohort: string; offer?: string; dryRun: boolean }) => {
        await commandMotionAcceleratorBatch({
          targetFile: opts.target,
          senderCohort: opts.senderCohort,
          ...(opts.offer ? { freeForCohortOffer: opts.offer } : {}),
          dryRun: opts.dryRun,
        });
      },
    ),
  );
motion
  .command("concierge")
  .requiredOption(
    "-t, --target <file>",
    "JSON file: { name, email, phone, signupContext?, callWindow? }[]",
  )
  .option("--skip-prep", "skip the pre-call email", false)
  .option("--skip-summary", "skip the post-call summary email", false)
  .option("--dry-run", "preview without calling or sending", false)
  .description("Autonomous voice onboarding for new signups (with optional pre/post emails)")
  .action(
    runOrFail(
      async (opts: {
        target: string;
        skipPrep: boolean;
        skipSummary: boolean;
        dryRun: boolean;
      }) => {
        await commandMotionConcierge({
          targetFile: opts.target,
          dryRun: opts.dryRun,
          skipPrep: opts.skipPrep,
          skipSummary: opts.skipSummary,
        });
      },
    ),
  );
motion
  .command("demo-no-show")
  .requiredOption(
    "-t, --target <file>",
    "JSON file: { name, email, phone?, company, missedAt, rescheduleLink, whatTheyWanted? }[]",
  )
  .option("--skip-sms", "skip the same-day SMS even if phone is present", false)
  .option("--dry-run", "preview without sending", false)
  .description(
    "Same-day SMS + email recovery for demo no-shows; cadence engine handles day-3 follow-up",
  )
  .action(
    runOrFail(async (opts: { target: string; skipSms: boolean; dryRun: boolean }) => {
      await commandMotionDemoNoShow({
        targetFile: opts.target,
        dryRun: opts.dryRun,
        skipSms: opts.skipSms,
      });
    }),
  );
motion
  .command("competitor-switch")
  .requiredOption(
    "-t, --target <file>",
    "JSON file: { name, email, company, competitor, evidenceUrl?, evidenceText?, yourEdge }[]",
  )
  .option("--skip-browser", "skip the browser-automation evidence scrape", false)
  .option("--dry-run", "preview without sending", false)
  .description(
    "Migration-honesty pitch when prospect uses a known competitor (with optional G2/BuiltWith scrape)",
  )
  .action(
    runOrFail(async (opts: { target: string; skipBrowser: boolean; dryRun: boolean }) => {
      await commandMotionCompetitorSwitch({
        targetFile: opts.target,
        dryRun: opts.dryRun,
        skipBrowser: opts.skipBrowser,
      });
    }),
  );
motion
  .command("hiring-signal")
  .requiredOption(
    "-t, --target <file>",
    "JSON file: { name, email, company, jobTitle, jobPostUrl?, yourClaim }[]",
  )
  .option("--skip-scrape", "skip the web-search/read of the job post", false)
  .option("--dry-run", "preview without sending", false)
  .description(
    "Trigger play: prospect's company hiring for a role your product compresses ramp time on",
  )
  .action(
    runOrFail(async (opts: { target: string; skipScrape: boolean; dryRun: boolean }) => {
      await commandMotionHiringSignal({
        targetFile: opts.target,
        dryRun: opts.dryRun,
        skipScrape: opts.skipScrape,
      });
    }),
  );
motion
  .command("podcast-guest")
  .requiredOption(
    "-t, --target <file>",
    "JSON file: { name, email, company, podcast, episodeTitle, hookQuote, bridge? }[]",
  )
  .option("--skip-search", "skip the web-search dossier enrichment", false)
  .option("--dry-run", "preview without sending", false)
  .description("Reference a SPECIFIC quote from a recent podcast appearance; one-touch")
  .action(
    runOrFail(async (opts: { target: string; skipSearch: boolean; dryRun: boolean }) => {
      await commandMotionPodcastGuest({
        targetFile: opts.target,
        dryRun: opts.dryRun,
        skipSearch: opts.skipSearch,
      });
    }),
  );
motion
  .command("breakup-revive")
  .option("--min-days <n>", "min days since last activity (default 60)", (v) =>
    Number.parseInt(v, 10),
  )
  .option("--max-days <n>", "max days since last activity (default 90)", (v) =>
    Number.parseInt(v, 10),
  )
  .option("--limit <n>", "hard cap on prospects to revive (default 25)", (v) =>
    Number.parseInt(v, 10),
  )
  .option("--value-drop <text>", "optional value drop to lead with (e.g. a new feature, benchmark)")
  .option("--dry-run", "preview without sending", false)
  .description("Pattern-interrupt revive for cold leads in the ledger (60-90 days quiet)")
  .action(
    runOrFail(
      async (opts: {
        minDays?: number;
        maxDays?: number;
        limit?: number;
        valueDrop?: string;
        dryRun: boolean;
      }) => {
        await commandMotionBreakupRevive({
          dryRun: opts.dryRun,
          ...(opts.minDays != null ? { minDays: opts.minDays } : {}),
          ...(opts.maxDays != null ? { maxDays: opts.maxDays } : {}),
          ...(opts.limit != null ? { limit: opts.limit } : {}),
          ...(opts.valueDrop ? { valueDrop: opts.valueDrop } : {}),
        });
      },
    ),
  );

const intel = program.command("intel").description("LLM-powered intelligence layer");
intel
  .command("advise")
  .option("--once", "ask one question and exit (for scripting); default loops until exit", false)
  .description(
    "Interactive founder coach (loops with conversation memory; exit with 'exit' or ctrl-c)",
  )
  .action(runOrFail(async (opts: { once: boolean }) => commandIntelAdvise({ once: opts.once })));
intel
  .command("weekly-review")
  .option("-o, --out <path>", "write to file instead of stdout")
  .option("-c, --context <text>", "extra free-text context to include")
  .description("Generate a paste-able Monday narrative review")
  .action(runOrFail(commandIntelWeeklyReview));
intel
  .command("triage-replies")
  .option("-s, --since-days <n>", "only triage replies from the last N days", (v) =>
    Number.parseInt(v, 10),
  )
  .option("-l, --limit <n>", "max replies to process", (v) => Number.parseInt(v, 10))
  .description("Classify and draft responses for inbound replies")
  .action(runOrFail(commandIntelTriage));
intel
  .command("personalize")
  .requiredOption("--prospect-name <name>", "prospect's first or full name")
  .requiredOption("--prospect-company <company>", "prospect's company")
  .requiredOption("--trigger <text>", "trigger context (Show HN post, funding, podcast, etc.)")
  .option("--dossier <text>", "free-text dossier to ground the opener")
  .description("Generate one anti-slop founder-to-founder opener for a single prospect")
  .action(runOrFail(commandIntelPersonalize));

const handoff = program.command("handoff").description("PMF→scale graduation gates");
handoff
  .command("readiness")
  .description("Six-signal scorecard: are you ready to systematize?")
  .action(runOrFail(commandHandoffReadiness));
handoff
  .command("templatize")
  .requiredOption("-i, --input <file>", "JSON file: array of {subject, body, outcome?}")
  .option("--force", "skip the 100-hand-sends pre-flight gate", false)
  .description(
    "Extract a reusable template from your top-converting hand-written emails (soft-gated)",
  )
  .action(runOrFail(commandHandoffTemplatize));
handoff
  .command("first-ae")
  .description("Five-gate hire-readiness check from the Lemkin/Blond/Kazanjy canon")
  .action(runOrFail(commandHandoffFirstAe));

const cadence = program
  .command("cadence")
  .description("Multi-touch sequence engine for in-flight prospects");
cadence
  .command("advance")
  .option("--dry-run", "preview which steps would fire without sending", false)
  .description("Poll inbound for replies, then execute due follow-up steps for active cadences")
  .action(runOrFail(commandCadenceAdvance));
cadence
  .command("list")
  .option("--all", "include completed/replied/breakup cadences (default: active only)", false)
  .description("List in-flight cadences with their current step and next-due time")
  .action(runOrFail(async (opts: { all: boolean }) => commandCadenceList(opts)));
cadence
  .command("stop <email>")
  .option("--play <name>", "stop only this play for the prospect (default: stop all)")
  .description("Manually stop a cadence for a prospect")
  .action(
    runOrFail(async (email: string, opts: { play?: string }) =>
      commandCadenceStop({ email, ...(opts.play ? { play: opts.play } : {}) }),
    ),
  );

const find = program
  .command("find")
  .description("Discover targets, ICP-filter, enrich, dedupe, queue for review");
find
  .command("show-hn")
  .option("--since-days <n>", "look back this many days (default 1)", (v) => Number.parseInt(v, 10))
  .option("--limit <n>", "max rows to enqueue (default 25)", (v) => Number.parseInt(v, 10))
  .option("--max-cost <usd>", "halt mid-run when this much OneShot $ is spent", (v) =>
    Number.parseFloat(v),
  )
  .option("--dry-run", "skip enrichment + enqueue; just count what would be found", false)
  .description("Pull recent Show HN posts, ICP-filter, enrich founder contact, enqueue")
  .action(
    runOrFail((opts: { sinceDays?: number; limit?: number; maxCost?: number; dryRun: boolean }) =>
      commandFindShowHn(opts),
    ),
  );
find
  .command("post-funding")
  .option(
    "-s, --source-urls <file>",
    "file with one TC/Crunchbase/blog URL per line (skip when using --auto)",
  )
  .option("--auto", "auto-discover URLs via webSearch using ICP-derived industry hint", false)
  .option(
    "--auto-industry <text>",
    "industry hint for --auto search (defaults to keywords from saved ICP)",
  )
  .option("--auto-rounds <list>", 'comma-separated rounds for --auto (default "Seed,Series A")')
  .option("--auto-since-days <n>", "look back this many days in --auto (default 7)", (v) =>
    Number.parseInt(v, 10),
  )
  .option("--limit <n>", "max URLs to process (default 25)", (v) => Number.parseInt(v, 10))
  .option("--max-cost <usd>", "halt mid-run when this much OneShot $ is spent", (v) =>
    Number.parseFloat(v),
  )
  .option("--dry-run", "skip enrichment + enqueue; just count what would be processed", false)
  .description("Read funding announcement URLs, extract structure, enrich founder contact, enqueue")
  .action(
    runOrFail(
      (opts: {
        sourceUrls?: string;
        auto: boolean;
        autoIndustry?: string;
        autoRounds?: string;
        autoSinceDays?: number;
        limit?: number;
        maxCost?: number;
        dryRun: boolean;
      }) => commandFindPostFunding(opts),
    ),
  );
find
  .command("accelerator-batch")
  .requiredOption(
    "-c, --cohort <cohort>",
    "cohort tag (yc-w26, yc-s26, yc-w25, yc-s25, od-current, spc-current, antler-current, techstars-current)",
  )
  .option(
    "--index-url <url>",
    "override the program index URL (use any portfolio / launch page)",
  )
  .option("--limit <n>", "max companies to process (default 25)", (v) => Number.parseInt(v, 10))
  .option("--max-cost <usd>", "halt mid-run when this much OneShot $ is spent", (v) =>
    Number.parseFloat(v),
  )
  .option("--dry-run", "skip enrichment + enqueue; just count what would be processed", false)
  .description("Pull a cohort/portfolio index page, extract companies, enrich + enqueue")
  .action(
    runOrFail(
      (opts: {
        cohort: string;
        indexUrl?: string;
        limit?: number;
        maxCost?: number;
        dryRun: boolean;
      }) => commandFindAcceleratorBatch(opts),
    ),
  );
find
  .command("job-change")
  .option("--personas <list>", "comma-separated personas (default: VP Eng,Head of Growth,...)")
  .option("--companies <list>", "optional comma-separated company filter")
  .option("--since-days <n>", "look back this many days (default 14)", (v) => Number.parseInt(v, 10))
  .option("--limit <n>", "max candidates to process (default 25)", (v) => Number.parseInt(v, 10))
  .option("--max-cost <usd>", "halt mid-run when this much OneShot $ is spent", (v) =>
    Number.parseFloat(v),
  )
  .option("--dry-run", "skip enrichment + enqueue; just count what would be processed", false)
  .description("Search for recent job-change announcements, ICP-filter, enrich + enqueue")
  .action(
    runOrFail(
      (opts: {
        personas?: string;
        companies?: string;
        sinceDays?: number;
        limit?: number;
        maxCost?: number;
        dryRun: boolean;
      }) => commandFindJobChange(opts),
    ),
  );
find
  .command("hiring-signal")
  .option("--roles <list>", "comma-separated job titles to scan for")
  .option("--companies <list>", "optional comma-separated company filter")
  .option("--your-claim <text>", "one-line claim about ramp-time compression for that role")
  .option("--since-days <n>", "look back this many days (default 14)", (v) => Number.parseInt(v, 10))
  .option("--limit <n>", "max postings to process (default 25)", (v) => Number.parseInt(v, 10))
  .option("--max-cost <usd>", "halt mid-run when this much OneShot $ is spent", (v) =>
    Number.parseFloat(v),
  )
  .option("--dry-run", "skip enrichment + enqueue; just count what would be processed", false)
  .description("Search ATS sites (Greenhouse/Lever/Workable/Ashby) for hiring signals, enqueue")
  .action(
    runOrFail(
      (opts: {
        roles?: string;
        companies?: string;
        yourClaim?: string;
        sinceDays?: number;
        limit?: number;
        maxCost?: number;
        dryRun: boolean;
      }) => commandFindHiringSignal(opts),
    ),
  );
find
  .command("podcast-guest")
  .option("--podcasts <list>", "comma-separated podcast names")
  .option("--since-days <n>", "look back this many days (default 21)", (v) => Number.parseInt(v, 10))
  .option("--skip-read", "skip the per-episode webRead step (cheaper, less accurate)", false)
  .option("--limit <n>", "max episodes to process (default 25)", (v) => Number.parseInt(v, 10))
  .option("--max-cost <usd>", "halt mid-run when this much OneShot $ is spent", (v) =>
    Number.parseFloat(v),
  )
  .option("--dry-run", "skip enrichment + enqueue; just count what would be processed", false)
  .description("Discover recent podcast guests via webSearch, enrich + enqueue")
  .action(
    runOrFail(
      (opts: {
        podcasts?: string;
        sinceDays?: number;
        skipRead: boolean;
        limit?: number;
        maxCost?: number;
        dryRun: boolean;
      }) => commandFindPodcastGuest(opts),
    ),
  );
find
  .command("queue")
  .option("--play <name>", "filter by play name")
  .option("--status <status>", "filter by status (pending|approved|rejected|sent|expired)")
  .option("--limit <n>", "rows to show (default 50)", (v) => Number.parseInt(v, 10))
  .description("List target_queue rows for review")
  .action(
    runOrFail(async (opts: { play?: string; status?: string; limit?: number }) => {
      commandFindQueue({
        ...(opts.play ? { play: opts.play } : {}),
        ...(opts.status ? { status: opts.status as never } : {}),
        ...(opts.limit ? { limit: opts.limit } : {}),
      });
    }),
  );
find
  .command("approve [id]")
  .option("--all", "approve every pending row (optionally scoped by --play)", false)
  .option("--play <name>", "scope --all to this play")
  .description("Mark a queue row (or all pending) as approved")
  .action(
    runOrFail(async (id: string | undefined, opts: { all: boolean; play?: string }) => {
      commandFindApprove({
        ...(id ? { id } : {}),
        all: opts.all,
        ...(opts.play ? { play: opts.play } : {}),
      });
    }),
  );
find
  .command("reject <id>")
  .option("--reason <text>", "reason note (logged for future ICP-filter learning)")
  .description("Mark a queue row as rejected")
  .action(
    runOrFail(async (id: string, opts: { reason?: string }) => {
      commandFindReject({ id, ...(opts.reason ? { reason: opts.reason } : {}) });
    }),
  );
find
  .command("drain <play>")
  .option("--limit <n>", "max approved rows to drain (default 10)", (v) => Number.parseInt(v, 10))
  .option("--sender-cohort <tag>", "REQUIRED for accelerator-batch (your cohort tag)")
  .option("--offer <text>", "free-for-cohort offer text (accelerator-batch only)")
  .option("--dry-run", "preview drain; don't actually send", false)
  .description("Pull approved rows for a play and run the existing motion play on them")
  .action(
    runOrFail(
      async (
        play: string,
        opts: { limit?: number; senderCohort?: string; offer?: string; dryRun: boolean },
      ) => {
        await commandFindDrain({
          play,
          dryRun: opts.dryRun,
          ...(opts.limit ? { limit: opts.limit } : {}),
          ...(opts.senderCohort ? { senderCohort: opts.senderCohort } : {}),
          ...(opts.offer ? { offer: opts.offer } : {}),
        });
      },
    ),
  );
find
  .command("watch")
  .option("--once", "run all due triggers once and exit (cron-friendly)", false)
  .option("--quiet", "log summary only, not per-trigger details", false)
  .description("Daemon: continuously poll registered triggers and enqueue new candidates")
  .action(
    runOrFail((opts: { once: boolean; quiet: boolean }) =>
      commandFindWatch({ once: opts.once, quiet: opts.quiet }),
    ),
  );

const measure = program.command("measure").description("Read receipts, CAC, RoCS");
measure
  .command("receipt <id>")
  .description("Fetch and print a signed receipt by id")
  .action(runOrFail(commandMeasureReceipt));
measure
  .command("cac")
  .option("-s, --since-days <n>", "only count receipts from last N days", (v) =>
    Number.parseInt(v, 10),
  )
  .description("Per-play CAC, $/send and $/reply, derived from signed receipts")
  .action(runOrFail((opts: { sinceDays?: number }) => commandMeasureCac(opts)));
measure
  .command("rocs")
  .option("-s, --since-days <n>", "only count receipts/outcomes from last N days", (v) =>
    Number.parseInt(v, 10),
  )
  .description("Return on Cognitive Spend: per-play $/meeting, $/SQL, $/won")
  .action(runOrFail((opts: { sinceDays?: number }) => commandMeasureRocs(opts)));
measure
  .command("outcome <email> <outcome>")
  .option("--play <name>", "tag the outcome to a specific play (default: unattributed)")
  .option("--amount <usd>", "deal amount in USD (for deal_won)", (v) => Number.parseFloat(v))
  .option("--notes <text>", "free-form notes")
  .description("Log a deal outcome (meeting_booked|sql_qualified|deal_won|deal_lost|ghosted)")
  .action(
    runOrFail(
      async (
        email: string,
        outcome: string,
        opts: { play?: string; amount?: number; notes?: string },
      ) => {
        commandMeasureOutcome({
          email,
          outcome,
          ...(opts.play ? { play: opts.play } : {}),
          ...(opts.amount != null ? { amount: opts.amount } : {}),
          ...(opts.notes ? { notes: opts.notes } : {}),
        });
      },
    ),
  );

// Make every parent (group) command print help cleanly when invoked without a subcommand,
// instead of commander's default non-zero exit.
attachHelpFallbacks(program);

program.parseAsync(process.argv).catch((err) => {
  fail((err as Error).message);
  process.exit(1);
});

function runOrFail<A extends unknown[]>(fn: (...args: A) => void | Promise<void>) {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      fail((err as Error).message);
      process.exit(1);
    }
  };
}

function attachHelpFallbacks(cmd: Command): void {
  for (const sub of cmd.commands) {
    const isGroup = sub.commands.length > 0;
    if (isGroup) {
      // If the user invokes the group with no subcommand, show help and exit 0.
      // Skip if an explicit .action was already set.
      // commander stores the action handler on `_actionHandler`; if missing, attach ours.
      if (!(sub as unknown as { _actionHandler?: unknown })._actionHandler) {
        sub.action(() => {
          sub.outputHelp();
        });
      }
      attachHelpFallbacks(sub);
    }
  }
}
