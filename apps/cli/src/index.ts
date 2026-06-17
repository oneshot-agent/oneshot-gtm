#!/usr/bin/env bun
import { Command } from "commander";
import { fail } from "./output.ts";
import { runInit } from "./commands/init.ts";
import { configFounder, configKeys, configLlm, configTelemetry } from "./commands/config.ts";
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
import { commandCadenceAdvance } from "./commands/cadence.ts";
import { commandGmailAuth } from "./commands/gmail.ts";
import {
  commandIdentitiesAdd,
  commandIdentitiesList,
  commandIdentitiesRemove,
} from "./commands/identities.ts";
import { commandUi } from "./commands/ui.ts";
import { commandFindDrain, commandFindWatch } from "./commands/find.ts";
import {
  commandMotionBreakupRevive,
  commandMotionCompetitorSwitch,
  commandMotionConcierge,
  commandMotionDemoNoShow,
  commandMotionHiringSignal,
  commandMotionPodcastGuest,
  commandMotionPostFunding,
} from "./commands/motion.ts";

const program = new Command();
program
  .name("oneshot-gtm")
  .description(
    "Open-source GTM agent for technical founders. Pay-per-result. Signed receipts.\n" +
      "The CLI is a thin headless layer; ad-hoc target discovery + review + send happens in the dashboard (oneshot-gtm ui).",
  )
  .version("0.1.0");

// Bootstrap + launcher

program.command("init").description("First-run setup wizard").action(runOrFail(runInit));
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

// Config (founder profile + LLM + secrets only; ICP lives in the dashboard)
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

// Gmail send path: OAuth consent flow for the alternate (non-OneShot) provider.
const gmail = program
  .command("gmail")
  .description("Gmail / Google Workspace send path (alternate email provider)");
gmail
  .command("auth")
  .description(
    "Authorize Gmail via OAuth and store the refresh token (chmod 600 ~/.oneshot-gtm/.env)",
  )
  .action(runOrFail(commandGmailAuth));

// Identities: manage the OneShot sender rotation pool (multiple wallet-owned
// domains + multiple mailboxes per domain). Gmail accounts join via `gmail auth`.
const identities = program
  .command("identities")
  .description("Manage OneShot sending identities (domains + mailboxes) in the rotation pool");
identities
  .command("list")
  .description("Show the rotation pool and the wallet's provisioned domain pool")
  .action(runOrFail(commandIdentitiesList));
identities
  .command("add")
  .description("Add an OneShot sending identity (wallet-owned domain + mailbox) to the pool")
  .action(runOrFail(commandIdentitiesAdd));
identities
  .command("remove <id>")
  .description("Remove an identity from the pool (e.g. oneshot:sales@acme.com)")
  .action(runOrFail(commandIdentitiesRemove));

// Find: scheduled / cron-able only. Ad-hoc finder runs are in the dashboard.
const find = program
  .command("find")
  .description("Scheduled discovery (daemon + drain). Ad-hoc runs live in the dashboard.");
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

// Cadence: cron-able advance. List/stop are in the dashboard.
const cadence = program
  .command("cadence")
  .description("Multi-touch sequence engine for in-flight prospects");
cadence
  .command("advance")
  .option("--dry-run", "preview which steps would fire without sending", false)
  .description("Poll inbound for replies, then execute due follow-up steps for active cadences")
  .action(runOrFail(commandCadenceAdvance));

// Motion plays without a /run page yet (CLI is the only path). Drop as
//    UI lands. show-hn / job-change / accelerator-batch already live in /run.
const motion = program
  .command("motion")
  .description("Run a named GTM play (CLI-only plays; the rest live in /run)");
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

// Discover: ICP discovery + PMF survey workflows (no UI yet)
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
  .description("Sequoia Arc + Balfour Four Fits classifier (6 questions, no agent calls)")
  .action(runOrFail(commandPmfClassify));
pmf
  .command("survey")
  .requiredOption("-c, --cohort <file>", "file with cohort emails (one per line, or JSON array)")
  .option("--product-name <name>", "product name for the landing page")
  .option("--product-description <text>", "10-200 char description for the landing page")
  .option("--custom-survey-url <url>", "skip the SDK Build step and use this URL instead")
  .option("--primary-color <hex>", "brand primary color (e.g. #FF5733)")
  .option("--dry-run", "draft only; do not build site or send", false)
  .description("Deploy a Superhuman 5-question PMF survey via SDK Build + Email")
  .action(runOrFail(commandPmfSurvey));
pmf
  .command("survey-collect")
  .option("-s, --since-days <n>", "collect inbound from the last N days", (v) =>
    Number.parseInt(v, 10),
  )
  .option("-o, --out <path>", "write analysis markdown to this file")
  .description("Collect inbound replies and synthesize a Sean Ellis report")
  .action(runOrFail(commandPmfSurveyCollect));

// Intel: interactive coaching + reply triage + personalize (no UI yet)
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

// Handoff: PMF→scale gates (no UI yet)
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
      if (!(sub as unknown as { _actionHandler?: unknown })._actionHandler) {
        sub.action(() => {
          sub.outputHelp();
        });
      }
      attachHelpFallbacks(sub);
    }
  }
}
