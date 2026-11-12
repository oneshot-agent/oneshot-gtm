#!/usr/bin/env bun
import { registerDirectMailCommand } from "./commands/direct-mail.ts";
import {
  commandLinkedInContinueCadences,
  commandLinkedInImportTouched,
  commandLinkedInReconcile,
} from "./commands/linkedin.ts";
import {
  commandLinkedInInvites,
  commandMeasure,
  type LinkedInInvitesOptions,
  type MeasureOptions,
} from "./commands/measure-linkedin.ts";
import { Command, InvalidArgumentError, Option } from "commander";

/** Option parser for counts that must be at least 1; `0` or `abc` is an error, not the default. */
function positiveInt(flag: string): (v: string) => number {
  return (v) => {
    const n = Number.parseInt(v, 10);
    if (!Number.isInteger(n) || n <= 0)
      throw new InvalidArgumentError(`${flag} must be a positive integer`);
    return n;
  };
}
import {
  readPackageVersion,
  reportTelemetryEvent,
  takeMarkedOutcome,
  type TelemetryOutcome,
} from "@oneshot-gtm/core";
import { isSupportedPlay } from "@oneshot-gtm/plays";
import { bail, CommandExit, fail, setJsonMode } from "./output.ts";
import { extractInvocation, type Invocation } from "./dispatch.ts";
import { runInit } from "./commands/init.ts";
import {
  configFounder,
  configKeys,
  configLlm,
  configSlackWebhook,
  configSpendCeiling,
  configLinkedInInvites,
  configLinkedInInviteTimeout,
  configLinkedInInviteExpiry,
  configTelemetry,
  configXEngine,
  configLinkedInSession,
  configVoice,
} from "./commands/config.ts";
import { commandDoctor } from "./commands/doctor.ts";
import {
  commandIntelAdvise,
  commandIntelBackfillIntent,
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
import { commandCadenceAdvance, commandCadenceReclassifyAuto } from "./commands/cadence.ts";
import { commandGmailAuth, commandGmailPlacement } from "./commands/gmail.ts";
import { commandSmartleadConnect } from "./commands/smartlead.ts";
import { commandSendsCheck } from "./commands/sends.ts";
import {
  commandDomainsList,
  commandDomainsQuote,
  commandDomainsBuy,
  commandPaymentsList,
  commandPaymentsResolve,
  commandDomainsPause,
  commandDomainsResume,
  commandIdentitiesAdd,
  commandIdentitiesList,
  commandIdentitiesRemove,
  commandIdentitiesSendVia,
  commandIdentitiesTestSend,
} from "./commands/identities.ts";
import { commandUi } from "./commands/ui.ts";
import {
  commandDemoReset,
  commandDemoSeed,
  commandDemoUi,
  DEFAULT_DEMO_HOME,
} from "./commands/demo.ts";
import {
  commandWorkspaceCreate,
  commandWorkspaceCurrent,
  commandWorkspaceList,
  commandWorkspaceOverlaps,
  commandWorkspacePath,
  commandWorkspaceRemove,
  commandWorkspaceUse,
} from "./commands/workspace.ts";
import { commandEnrichLinkedIn } from "./commands/enrich-linkedin.ts";
import { commandResearchProspects } from "./commands/research-prospects.ts";
import { commandResearchProducts } from "./commands/research-products.ts";
import {
  commandListExcludedOffers,
  commandRejudgeOffers,
  commandRejudgeSequences,
  commandRewriteWeakOffers,
} from "./commands/rejudge-offers.ts";
import { commandResearchQueue } from "./commands/research-queue.ts";
import { commandCloseOffers } from "./commands/close-offers.ts";
import { commandRejudgeGitHub } from "./commands/rejudge-github.ts";
import { commandRederive } from "./commands/rederive.ts";
import { commandSynthesizeAngles } from "./commands/synthesize-angles.ts";
import { commandScoreProspects } from "./commands/score-prospects.ts";
import { commandBackfillFitReason } from "./commands/backfill-fit-reason.ts";
import { commandCompactReceipts } from "./commands/compact-receipts.ts";
import { commandCalibrate } from "./commands/calibrate.ts";
import {
  commandFindCacheStats,
  commandFindDrain,
  commandFindImport,
  commandFindWatch,
} from "./commands/find.ts";
import {
  commandInstallDashboardService,
  commandInstallService,
} from "./commands/install-service.ts";
import { commandMeasureBenchmark } from "./commands/measure.ts";
import {
  commandMotionBreakupRevive,
  commandMotionCompetitorSwitch,
  commandMotionConcierge,
  commandMotionDemoNoShow,
  commandMotionDiscoveryInterview,
  commandMotionFreePilot,
  commandMotionHiringSignal,
  commandMotionPodcastGuest,
  commandMotionPostFunding,
} from "./commands/motion.ts";

// Share the package version with --version and telemetry.
const CLI_VERSION = readPackageVersion(import.meta.url);

const program = new Command();
registerDirectMailCommand(program);
program
  .name("oneshot-gtm")
  .description(
    "Open-source outbound for founders. Local ledger, pay per call, signed receipts.\n" +
      "Use the dashboard (oneshot-gtm ui) for ad-hoc discovery, review and sending.",
  )
  .version(CLI_VERSION)
  // main.ts consumes this before core imports. Declare it here for --help
  // and to tolerate occurrences commander still sees.
  .option("-w, --workspace <name>", "run against a named workspace (see: workspace list)");

program.command("init").description("First-run setup wizard").action(runOrFail(runInit));
program
  .command("doctor")
  .description("Check setup health")
  .option("--json", "output as JSON")
  .action(runOrFail((opts: { json?: boolean }) => commandDoctor(opts)));
program
  .command("compact-receipts")
  .description("Shrink the local data file by trimming details from old receipts")
  .option("--apply", "write the trim; without it the run is a dry run", false)
  .option("--no-vacuum", "trim only; skip shrinking the data file")
  .action(
    runOrFail((opts: { apply: boolean; vacuum: boolean }) => {
      commandCompactReceipts(opts);
    }),
  );
program
  .command("ui")
  .option(
    "--port <n>",
    "port for the API server (default: the workspace's registered port; 3030 for `default`)",
    (v) => Number.parseInt(v, 10),
  )
  .option("--no-browser", "do not auto-open the browser")
  .addOption(
    new Option("--dev", "use vite dev server (5173) + API server").default(false).hideHelp(),
  )
  .option(
    "--install-service",
    "print a launchd plist (macOS) / systemd user unit (Linux) that starts this workspace's dashboard at login; doesn't start it now",
    false,
  )
  .option(
    "--write",
    "with --install-service: write the file to the platform-conventional path instead of stdout",
    false,
  )
  .description("Open the local dashboard at http://127.0.0.1:<port>")
  .action(
    runOrFail(
      async (opts: {
        port?: number;
        browser: boolean;
        dev: boolean;
        installService: boolean;
        write: boolean;
      }) => {
        if (opts.installService) {
          // A service runs the prebuilt dashboard; the vite dev server is a foreground tool.
          if (opts.dev) bail("--dev cannot be used with --install-service");
          return commandInstallDashboardService({
            write: opts.write,
            ...(opts.port != null ? { port: opts.port } : {}),
          });
        }
        if (opts.write) bail("--write only makes sense with --install-service");
        await commandUi({
          ...(opts.port != null ? { port: opts.port } : {}),
          noBrowser: !opts.browser,
          dev: opts.dev,
        });
      },
    ),
  );

// Demo: a fictional, deterministic install in its own home, for screenshots and
// video. Never reads or writes the real ledger.
const demo = program.command("demo").description("Seed and run a self-contained demo install");
demo
  .command("seed")
  .option("--home <dir>", "where to build the demo install", DEFAULT_DEMO_HOME)
  .option("--now <iso>", "anchor every timestamp to this instant (default: now)")
  .option("--force", "overwrite a non-empty directory", false)
  .description("Build a populated demo ledger, config and fixtures")
  .action(
    runOrFail(async (opts: { home: string; now?: string; force: boolean }) => {
      await commandDemoSeed({
        home: opts.home,
        force: opts.force,
        ...(opts.now ? { now: opts.now } : {}),
      });
    }),
  );
demo
  .command("ui")
  .option("--home <dir>", "the demo install to open", DEFAULT_DEMO_HOME)
  .option(
    "--port <n>",
    "port for the API server (default 3030)",
    (v) => Number.parseInt(v, 10),
    3030,
  )
  .option("--no-browser", "do not auto-open the browser")
  .addOption(
    new Option("--dev", "use vite dev server (5173) + API server").default(false).hideHelp(),
  )
  .description("Open the dashboard against the demo install")
  .action(
    runOrFail(async (opts: { home: string; port: number; browser: boolean; dev: boolean }) => {
      await commandDemoUi({
        home: opts.home,
        port: opts.port,
        noBrowser: !opts.browser,
        dev: opts.dev,
      });
    }),
  );
demo
  .command("reset")
  .option("--home <dir>", "the demo install to remove", DEFAULT_DEMO_HOME)
  .description("Delete a seeded demo install")
  .action(
    runOrFail(async (opts: { home: string }) => {
      await commandDemoReset({ home: opts.home });
    }),
  );

// Workspaces: named, fully isolated installs (one product each). Selection
// (--workspace / ONESHOT_GTM_WORKSPACE / registry default) happens in main.ts
// BEFORE core is imported: by the time these actions run the home is fixed.
const workspace = program
  .command("workspace")
  .description("Named isolated installs, one per product you're selling");
workspace
  .command("list")
  .description("Show every workspace, the current and the default")
  .option("--json", "output as JSON")
  .action(runOrFail((opts: { json?: boolean }) => commandWorkspaceList(opts)));
workspace
  .command("create <name>")
  .description("Create an empty workspace (then: --workspace <name> init)")
  .action(runOrFail(commandWorkspaceCreate));
workspace
  .command("use <name>")
  .description("Make a workspace the default for runs without --workspace")
  .action(runOrFail(commandWorkspaceUse));
workspace
  .command("current")
  .description("Print the active workspace name and home")
  .action(runOrFail(commandWorkspaceCurrent));
workspace
  .command("path <name>")
  .description("Print a workspace's home dir (for ONESHOT_GTM_HOME=$(…) scripting)")
  .action(runOrFail(commandWorkspacePath));
workspace
  .command("overlaps")
  .description(
    "List people in a live sequence here and in another workspace, by play pair. Changes nothing",
  )
  .option("--json", "output as JSON")
  .action(runOrFail((opts: { json?: boolean }) => commandWorkspaceOverlaps(opts)));
workspace
  .command("remove <name>")
  .description("Forget a workspace (files are left in place)")
  .action(runOrFail(commandWorkspaceRemove));

const config = program.command("config").description("Configure providers and profile");
config.command("llm").description("Pick LLM provider and model").action(runOrFail(configLlm));
config
  .command("founder")
  .description("Set founder name, email, product one-liner")
  .action(runOrFail(configFounder));
config
  .command("keys")
  .description(
    "Set or update API keys (LLM + OneShot wallet + X/Twitter). Saved to the workspace's .env with chmod 600",
  )
  .action(runOrFail(configKeys));
config
  .command("telemetry <state>")
  .description("Enable or disable opt-out telemetry (on|off)")
  .action(runOrFail((state: string) => configTelemetry(state === "on" ? "on" : "off")));
config
  .command("x-engine [engine]")
  .description("Show or switch the x-reposters data source (xapi or twitterapiio)")
  .action(runOrFail((engine?: string) => configXEngine(engine)));
config
  .command("linkedin-session")
  .description(
    "Connect your LinkedIn session to a OneShot browser profile so person research can read live profiles",
  )
  .option("--login", "log in through a hosted browser even when a cookie is stored")
  .action(runOrFail((opts: { login?: boolean }) => configLinkedInSession(opts)));
config
  .command("slack-webhook [url]")
  .description(
    "Show, set, or clear the Slack incoming-webhook URL for reply/bounce/daily-summary notifications",
  )
  .action(runOrFail((url?: string) => configSlackWebhook(url)));
config
  .command("voice")
  .description(
    "Show, draft (from your own writing), or clear the founder voice card every email draft writes in",
  )
  .option("--from <paths...>", "files or folders of your own posts to draft the card from")
  .option(
    "--messages <paths...>",
    "files or folders of messages you sent to people (fenced blocks or whole files); these outrank posts for register",
  )
  .option("--guide <file>", "a note you wrote about your own style, used as evidence")
  .option("--clear", "remove the card; drafts return to the plain register")
  .option("--yes", "save without confirming (and even when the samples were thin)")
  .action(
    runOrFail(
      (opts: {
        from?: string[];
        messages?: string[];
        guide?: string;
        clear?: boolean;
        yes?: boolean;
      }) => configVoice(opts),
    ),
  );
config
  .command("spend-ceiling [amount]")
  .description(
    "Show or set the install-wide daily USD spend ceiling (halts automated finder/drain runs once reached; 'off' clears it)",
  )
  .action(runOrFail((amount?: string) => configSpendCeiling(amount)));
config
  .command("linkedin-invites [count]")
  .description(
    "Show or set this workspace's share of the LinkedIn account's daily invite cap (whole number per UTC day; 0 pauses invites; 'off' clears it)",
  )
  .action(runOrFail((count?: string) => configLinkedInInvites(count)));
config
  .command("linkedin-invite-timeout [days]")
  .description(
    "Show or set the days an unaccepted LinkedIn invite waits before it is withdrawn (positive integer; 'off' restores the default of 21)",
  )
  .action(runOrFail((days?: string) => configLinkedInInviteTimeout(days)));
config
  .command("linkedin-invite-expiry [days]")
  .description(
    "Show or set the days a due LinkedIn connection request may stay unsent before its cadence ends without it (positive integer; 'off', the default, waits)",
  )
  .action(runOrFail((days?: string) => configLinkedInInviteExpiry(days)));

const linkedin = program.command("linkedin").description("LinkedIn outreach safety");
linkedin
  .command("invites")
  .description(
    "List every LinkedIn invite sent, with the state GTM detects, to compare with LinkedIn. Read-only.",
  )
  .option("--since <date>", "only invites sent on or after this date (YYYY-MM-DD)")
  .option("--status <status>", "pending, accepted or withdrawn")
  .option("--json", "output as JSON")
  .action(runOrFail((opts: LinkedInInvitesOptions) => commandLinkedInInvites(opts)));
linkedin
  .command("import-touched [file]")
  .description(
    "Record profiles already contacted on LinkedIn (CSV or JSON of profile URLs) so no invite goes to them; --from-ledgers copies the invites every workspace has sent. Sends nothing.",
  )
  .option("--source <label>", "label stored with each profile (default: import)")
  .option("--from-ledgers", "copy the invites recorded in every registered workspace's ledger")
  .option("--dry-run", "count what would be imported without writing")
  .option("--verbose", "list the entries that are not LinkedIn profiles")
  .action(
    runOrFail(
      (
        file: string | undefined,
        opts: { source?: string; fromLedgers?: boolean; dryRun?: boolean; verbose?: boolean },
      ) => commandLinkedInImportTouched(file, opts),
    ),
  );
linkedin
  .command("reconcile")
  .description(
    "Record the outcome of LinkedIn sends marked failed while OneShot was still sending them, and free profiles whose invite LinkedIn never sent. Reads OneShot's records; prints only unless --write. Sends nothing.",
  )
  .option("--write", "record the outcomes (default: print what would be recorded)")
  .action(runOrFail((opts: { write?: boolean }) => commandLinkedInReconcile(opts)));
linkedin
  .command("continue-cadences")
  .description(
    "Give email cadences enrolled before linkedinContinuation was on their LinkedIn steps (connection request, first message, close). Counts only unless --write. Sends nothing.",
  )
  .option("--write", "save the steps (default: count only)")
  .option("--verbose", "list every cadence that would continue")
  .action(
    runOrFail((opts: { write?: boolean; verbose?: boolean }) =>
      commandLinkedInContinueCadences(opts),
    ),
  );

const gmail = program
  .command("gmail")
  .description("Gmail / Google Workspace send path (alternate email provider)");
gmail
  .command("auth")
  .description("Authorize Gmail via OAuth and store the refresh token (chmod 600, workspace .env)")
  .action(runOrFail(commandGmailAuth));
gmail
  .command("placement")
  .description(
    "Send one real email between two authorized mailboxes and report inbox vs spam vs tab",
  )
  .option("--from <identityId>", "sending identity (default: first Gmail identity)")
  .option("--to <identityId>", "receiving identity (default: first other Gmail identity)")
  .option("--play <name>", "replay this play's most recent real email as the canary body")
  .option("-y, --yes", "skip the send confirmation")
  .action(runOrFail(commandGmailPlacement));

// Smartlead: bring-your-own cold-email infra. Smartlead hosts and warms the
// mailboxes; we send from them and sync their replies into the dashboard.
const smartlead = program
  .command("smartlead")
  .description("Smartlead-hosted mailboxes: send from them and sync their replies");
smartlead
  .command("connect")
  .description("Store the Smartlead API key and add its mailboxes to the rotation pool")
  .action(runOrFail(commandSmartleadConnect));

// Sends: read-only delivery check against each mailbox's Sent folder.
const sends = program
  .command("sends")
  .description("Check recent sends against their mailbox's Sent folder (read-only)");
sends
  .command("check")
  .description(
    "Count each Smartlead/Gmail send's copies in Sent: expected 1, observed N (duplicates = provider retries)",
  )
  .option("--since <window>", "how far back: 7d, 48h, 90m or a date", "7d")
  .option("--limit <n>", "check at most N sends", (v) => Number.parseInt(v, 10))
  .option("--dry-run", "report only; record nothing")
  .action(
    runOrFail((opts: { since?: string; limit?: number; dryRun?: boolean }) =>
      commandSendsCheck({
        ...(opts.since ? { since: opts.since } : {}),
        ...(opts.limit ? { limit: opts.limit } : {}),
        dryRun: opts.dryRun === true,
      }),
    ),
  );

// Identities: manage the OneShot sender rotation pool (multiple wallet-owned
// domains + multiple mailboxes per domain). Gmail accounts join via `gmail auth`.
const identities = program
  .command("identities")
  .description("Manage OneShot sending identities (domains + mailboxes) in the rotation pool");
identities
  .command("list")
  .description("Show the rotation pool and the wallet's provisioned domain pool")
  .option("--json", "output as JSON")
  .action(runOrFail((opts: { json?: boolean }) => commandIdentitiesList(opts)));
identities
  .command("add")
  .description("Add an OneShot sending identity (wallet-owned domain + mailbox) to the pool")
  .action(runOrFail(commandIdentitiesAdd));
identities
  .command("remove <id>")
  .description("Remove an identity from the pool (e.g. oneshot:sales@acme.com)")
  .action(runOrFail(commandIdentitiesRemove));
identities
  .command("send-via <id> <transport>")
  .description(
    "How a Smartlead mailbox sends: provider (Smartlead API, default) or smtp (its own SMTP, one fixed Message-ID per email)",
  )
  .action(runOrFail(commandIdentitiesSendVia));
identities
  .command("test-send <id>")
  .description(
    "Send one test email through a Smartlead mailbox's own SMTP (keyed, confirmed in Sent)",
  )
  .requiredOption("--to <email>", "recipient (your own test address)")
  .option("--step <label>", "key label; defaults to today, so a second run that day replays")
  .option("--dry-run", "resolve credentials and print the Message-ID without sending", false)
  .action(
    runOrFail((id: string, opts: { to: string; step?: string; dryRun: boolean }) =>
      commandIdentitiesTestSend(id, opts),
    ),
  );

// Domains: manage the wallet's provisioned OneShot sending-domain pool. A domain
// gets paused (by reputation, or account/platform-level) → no sends from it
// until resumed. `doctor` flags a paused domain; these resume/pause it.
const domains = program
  .command("domains")
  .description("Manage the wallet's provisioned OneShot sending-domain pool");
domains
  .command("list")
  .description("Show provisioned domains with pool status, warmth, and daily usage")
  .option("--json", "output as JSON")
  .action(runOrFail((opts: { json?: boolean }) => commandDomainsList(opts)));
domains
  .command("resume <domain>")
  .description("Resume a paused sending domain (e.g. yourcompany-mail.com)")
  .action(runOrFail(commandDomainsResume));
domains
  .command("pause <domain>")
  .description("Pause a sending domain (stop sending from it)")
  .action(runOrFail(commandDomainsPause));

domains
  .command("quote <domain>")
  .description("Review the price and terms for a domain or additional addresses")
  .option(
    "--mode <mode>",
    "relay or mailbox; existing domains keep their mode, new domains default to relay",
  )
  .option("--addresses <localparts>", "1–10 comma-separated local parts", "agent")
  .option("--json", "output as JSON")
  .action(runOrFail(commandDomainsQuote));
domains
  .command("buy <domain>")
  .description("Purchase an explicitly accepted setup quote; never sends email")
  .requiredOption("--quote-id <id>", "exact quote ID reviewed with domains quote")
  .option("--json", "output as JSON")
  .action(runOrFail(commandDomainsBuy));
const payments = program.command("payments").description("Reconcile unresolved OneShot payments");
payments
  .command("list")
  .description("List unresolved payments that need reconciliation")
  .option("--json", "output as JSON")
  .action(runOrFail(commandPaymentsList));
payments
  .command("resolve <hold-key>")
  .description("Release a hold ONLY after checking settlement/credit; permits another attempt")
  .requiredOption("--note <note>", "how the settlement was reconciled")
  .action(runOrFail(commandPaymentsResolve));

// Find: scheduled / cron-able only. Ad-hoc finder runs are in the dashboard.
const find = program
  .command("find")
  .description(
    "Find prospects on a schedule and contact approved prospects. Ad-hoc runs live in the dashboard.",
  );
find
  .command("import")
  .requiredOption("--csv <file>", "CSV file to import")
  .requiredOption("--play <name>", "play to add imported prospects to for review")
  .option(
    "--map <column=field>",
    "override a header mapping (field: email, name, company, title); repeatable",
    (value: string, previous: string[]) => [...previous, value],
    [],
  )
  .option(
    "--dry-run",
    "print mapping and row count without checking fit or importing prospects",
    false,
  )
  .option("--fail-on-empty", "exit 2 when zero rows are imported", false)
  .option("--json", "emit {imported, skipped, errors[]}")
  .description("Import prospects from a CSV, check their fit and skip duplicates")
  .action(
    runOrFail(
      async (opts: {
        csv: string;
        play: string;
        map: string[];
        dryRun: boolean;
        failOnEmpty: boolean;
        json?: boolean;
      }) => {
        setJsonMode(opts.json ?? false);
        if (!isSupportedPlay(opts.play)) bail(`unknown play: ${opts.play}`);
        await commandFindImport(opts);
      },
    ),
  );
find
  .command("watch")
  .option("--once", "run all due triggers once and exit (cron-friendly)", false)
  .option("--quiet", "log summary only, not per-trigger details", false)
  .option("--json", "output as JSON (with --once)")
  .option(
    "--ignore-approval-rate",
    "run due finders even when their trailing approval rate is below threshold",
    false,
  )
  .option(
    "--install-service",
    "print a launchd plist (macOS) / systemd user unit (Linux) that runs this daemon; doesn't start watching",
    false,
  )
  .option(
    "--write",
    "with --install-service: write the file to the platform-conventional path instead of stdout",
    false,
  )
  .option(
    "--fail-on-empty",
    "with --once: exit 2 (not 0) when no new prospects were added for review",
    false,
  )
  .description("Continuously find prospects from your configured sources and add them for review")
  .action(
    runOrFail(
      (opts: {
        once: boolean;
        quiet: boolean;
        installService: boolean;
        write: boolean;
        failOnEmpty: boolean;
        json?: boolean;
        ignoreApprovalRate: boolean;
      }) => {
        if (opts.json && opts.installService) bail("--json cannot be used with --install-service");
        if (opts.installService) return commandInstallService({ write: opts.write });
        if (opts.write) bail("--write only makes sense with --install-service");
        // A daemon run never ends of its own accord, so it has no empty result
        // to report: refuse the combination rather than silently ignore it.
        // Same reasoning for --json: the document is written once, at the end.
        if (opts.failOnEmpty && !opts.once) bail("--fail-on-empty only makes sense with --once");
        if (opts.json && !opts.once) bail("--json only makes sense with --once");
        return commandFindWatch({
          once: opts.once,
          quiet: opts.quiet,
          failOnEmpty: opts.failOnEmpty,
          ignoreApprovalRate: opts.ignoreApprovalRate,
          json: opts.json,
        });
      },
    ),
  );
find
  .command("cache-stats")
  .option("--days <n>", "window in days (default 7)", (v) => Number.parseInt(v, 10), 7)
  .option("--json", "output as JSON")
  .description(
    "Show research reused, spending avoided and purchases by lookup type across all workspaces",
  )
  .action(
    runOrFail((opts: { days: number; json?: boolean }) =>
      commandFindCacheStats({ days: opts.days, ...(opts.json ? { json: true } : {}) }),
    ),
  );
find
  .command("drain <play>")
  .option("--limit <n>", "max approved prospects to contact (default 10)", (v) =>
    Number.parseInt(v, 10),
  )
  .option("--dry-run", "preview outreach; don't actually send", false)
  .option(
    "--fail-on-empty",
    "exit 2 (not 0) when no approved prospects were processed; 1 if any prospect failed",
    false,
  )
  .option("--json", "output as JSON")
  .description("Run outreach for a play on its approved prospects")
  .action(
    runOrFail(
      async (
        play: string,
        opts: {
          limit?: number;
          dryRun: boolean;
          failOnEmpty: boolean;
          json?: boolean;
        },
      ) => {
        await commandFindDrain({
          play,
          dryRun: opts.dryRun,
          failOnEmpty: opts.failOnEmpty,
          ...(opts.limit ? { limit: opts.limit } : {}),
          ...(opts.json ? { json: opts.json } : {}),
        });
      },
    ),
  );

find
  .command("enrich-linkedin")
  // Defaulted, not open-ended: each candidate costs a paid webSearch, so an
  // unflagged run on a large ledger must not quietly bill for thousands.
  .option(
    "--limit <n>",
    "max prospects to search (default 500)",
    (v) => Number.parseInt(v, 10),
    500,
  )
  .option("--play <name>", "only prospects sourced from this play")
  .option("--concurrency <n>", "parallel lookups (default 4)", (v) => Number.parseInt(v, 10))
  .option("--skip-handles", "skip names that don't look like a real person", false)
  .option("--dry-run", "list candidates and estimated cost; search nothing", false)
  .description("Backfill missing LinkedIn URLs onto existing prospects")
  .action(
    runOrFail(
      async (opts: {
        limit?: number;
        play?: string;
        concurrency?: number;
        skipHandles: boolean;
        dryRun: boolean;
      }) => {
        await commandEnrichLinkedIn({
          dryRun: opts.dryRun,
          skipHandles: opts.skipHandles,
          ...(opts.limit ? { limit: opts.limit } : {}),
          ...(opts.play ? { play: opts.play } : {}),
          ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
        });
      },
    ),
  );

find
  .command("research-prospects")
  // Defaulted like enrich-linkedin, and lower: each row is a ~$0.05 / 2-5 min
  // call, so an unflagged run must not quietly bill for hundreds.
  .option(
    "--limit <n>",
    "max prospects to research (default 250)",
    (v) => Number.parseInt(v, 10),
    250,
  )
  .option(
    "--scope <list>",
    "comma-separated: active,replied,unjudged,all (default active,replied,unjudged)",
  )
  .option("--concurrency <n>", "parallel research calls (default 3)", positiveInt("--concurrency"))
  .option("--refresh", "re-research prospects that already have a dossier", false)
  .option(
    "--rebuy",
    "buy fresh research and posts even when previous results are available (bills each one)",
    false,
  )
  .option("--id <n>", "research one prospect by id, ignoring scope and dossier state", (v) =>
    Number.parseInt(v, 10),
  )
  .option("--max-cost-usd <n>", "stop once this much has been billed this run", (v) =>
    Number.parseFloat(v),
  )
  .option("--no-rejudge", "keep the stored ICP verdict; skip reassessing the prospect's fit")
  .option("--no-company", "skip the company lookup for the current employer")
  .option("--no-live", "skip the live LinkedIn profile read")
  .option(
    "--cache-only",
    "update from previously purchased research only; skip prospects without it, nothing is billed",
    false,
  )
  .option("--no-newsfeed", "skip capturing recent posts after the research")
  .option(
    "--newsfeed-only",
    "capture recent posts for rows with a LinkedIn or X profile; no person research",
    false,
  )
  .option("--dry-run", "list candidates and estimated cost; research nothing", false)
  .description("Research existing prospects: current role, company facts and fit with your ICP")
  .action(
    runOrFail(
      async (opts: {
        limit?: number;
        scope?: string;
        concurrency?: number;
        refresh: boolean;
        rebuy: boolean;
        id?: number;
        maxCostUsd?: number;
        rejudge: boolean;
        company: boolean;
        live: boolean;
        cacheOnly?: boolean;
        newsfeed: boolean;
        newsfeedOnly?: boolean;
        dryRun: boolean;
      }) => {
        await commandResearchProspects({
          noNewsfeed: opts.newsfeed === false,
          newsfeedOnly: opts.newsfeedOnly === true,
          dryRun: opts.dryRun,
          refresh: opts.refresh,
          rebuy: opts.rebuy,
          noRejudge: opts.rejudge === false,
          noCompany: opts.company === false,
          noLive: opts.live === false,
          cacheOnly: opts.cacheOnly === true,
          ...(opts.limit ? { limit: opts.limit } : {}),
          ...(opts.scope ? { scope: opts.scope } : {}),
          ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
          ...(Number.isFinite(opts.id) ? { id: opts.id as number } : {}),
          ...(Number.isFinite(opts.maxCostUsd) ? { maxCostUsd: opts.maxCostUsd as number } : {}),
        });
      },
    ),
  );

find
  .command("research-queue")
  .option("--play <name>", "only rows of this play (default: all plays)")
  .option("--status <s>", "pending, approved, or live = both (default live)")
  .option(
    "--id <n>",
    "research one prospect in Queue by id, ignoring play, status and research state",
    (v) => Number.parseInt(v, 10),
  )
  .option("--limit <n>", "max rows to research (default: no limit)", (v) => Number.parseInt(v, 10))
  .option("--concurrency <n>", "parallel research calls (default 3)", positiveInt("--concurrency"))
  .option(
    "--max-cost-usd <n>",
    "stop once this much has been billed this run (default: no cap)",
    (v) => Number.parseFloat(v),
  )
  .option("--refresh", "re-research rows that already carry person research", false)
  .option(
    "--rebuy",
    "buy fresh research and posts even when previous results are available (bills each one)",
    false,
  )
  .option("--no-rejudge", "keep the prospect's ICP verdict; skip reassessing their fit")
  .option("--no-company", "skip the company lookup for the current employer")
  .option("--no-live", "skip the live LinkedIn profile read")
  .option(
    "--cache-only",
    "update from previously purchased research only; skip prospects without it, nothing is billed (with --refresh for rows already researched)",
    false,
  )
  .option("--no-newsfeed", "skip capturing recent posts after the research")
  .option(
    "--newsfeed-only",
    "capture recent posts for rows with a LinkedIn or X profile; no person research",
    false,
  )
  .option("--dry-run", "list candidates and estimated cost; research nothing", false)
  .description(
    "Research pending and approved prospects in Queue: current role from LinkedIn history, company facts and fit with your ICP",
  )
  .action(
    runOrFail(
      async (opts: {
        play?: string;
        status?: string;
        id?: number;
        limit?: number;
        concurrency?: number;
        maxCostUsd?: number;
        refresh: boolean;
        rebuy: boolean;
        rejudge: boolean;
        company: boolean;
        live: boolean;
        cacheOnly?: boolean;
        newsfeed: boolean;
        newsfeedOnly?: boolean;
        dryRun: boolean;
      }) => {
        await commandResearchQueue({
          noNewsfeed: opts.newsfeed === false,
          newsfeedOnly: opts.newsfeedOnly === true,
          dryRun: opts.dryRun,
          refresh: opts.refresh,
          rebuy: opts.rebuy,
          noRejudge: opts.rejudge === false,
          noCompany: opts.company === false,
          noLive: opts.live === false,
          cacheOnly: opts.cacheOnly === true,
          ...(opts.play ? { play: opts.play } : {}),
          ...(opts.status ? { status: opts.status } : {}),
          ...(Number.isFinite(opts.id) ? { id: opts.id as number } : {}),
          ...(Number.isFinite(opts.limit) ? { limit: opts.limit as number } : {}),
          ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
          ...(Number.isFinite(opts.maxCostUsd) ? { maxCostUsd: opts.maxCostUsd as number } : {}),
        });
      },
    ),
  );

find
  .command("rederive")
  .option("--id <n>", "update one prospect in Queue by id", positiveInt("--id"))
  .option("--moved", "every open row moved in from another workspace", false)
  .option("--dry-run", "derive and print; write nothing", false)
  .description(
    "Update the outreach angle, ICP verdict and fit explanation for prospects moved from another workspace to match this workspace (paid; never changes status)",
  )
  .action(
    runOrFail(async (opts: { id?: number; moved: boolean; dryRun: boolean }) => {
      await commandRederive({
        moved: opts.moved,
        dryRun: opts.dryRun,
        ...(opts.id !== undefined ? { id: opts.id } : {}),
      });
    }),
  );

find
  .command("rejudge-github")
  .option("--status <s>", "pending, approved, or live = both (default live)")
  .option("--id <n>", "reassess one github-stars prospect in Queue by id", positiveInt("--id"))
  .option(
    "--limit <n>",
    "max rows to judge, oldest first (default: no limit)",
    positiveInt("--limit"),
  )
  .option("--concurrency <n>", "parallel rows (default 3)", positiveInt("--concurrency"))
  .option(
    "--reject-approved",
    "move approved rows that fail to rejected (default: annotate only)",
    false,
  )
  .option("--refresh", "re-judge rows that already carry a GitHub re-judge", false)
  .option("--verbose", "print every row's verdict", false)
  .option("--dry-run", "judge and print; write nothing", false)
  .description(
    "Reassess pending and approved github-stars prospects using their public GitHub evidence (bio, site, own repos, profile README); no paid research",
  )
  .action(
    runOrFail(
      async (opts: {
        status?: string;
        id?: number;
        limit?: number;
        concurrency?: number;
        rejectApproved: boolean;
        refresh: boolean;
        verbose: boolean;
        dryRun: boolean;
      }) => {
        await commandRejudgeGitHub({
          dryRun: opts.dryRun,
          rejectApproved: opts.rejectApproved,
          refresh: opts.refresh,
          verbose: opts.verbose,
          ...(opts.status ? { status: opts.status } : {}),
          ...(Number.isFinite(opts.id) ? { id: opts.id as number } : {}),
          ...(Number.isFinite(opts.limit) ? { limit: opts.limit as number } : {}),
          ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
        });
      },
    ),
  );

find
  .command("research-products")
  .option(
    "--limit <n>",
    "max combined saved prospects and prospects in Queue",
    (v) => Number.parseInt(v, 10),
    250,
  )
  .option(
    "--scope <list>",
    "comma-separated: active,replied,unjudged,all (default active,replied,unjudged)",
  )
  .option("--concurrency <n>", "parallel research calls (default 3)", positiveInt("--concurrency"))
  .option(
    "--max-cost-usd <n>",
    "stop starting calls after this spend target (one call may cross it)",
    (v) => Number(v),
    5,
  )
  .option("--no-cost-limit", "run the full backfill without a spend ceiling")
  .option("--first-party-only", "skip external research and retain first-party evidence only")
  .option("--refresh", "refresh rows that already have product research", false)
  .option("--no-include-pending", "exclude pending prospects in Queue")
  .option(
    "--include-unsent",
    "include every unsent prospect in Queue (pending and approved), not just pending",
    false,
  )
  .option("--dry-run", "list candidates and estimated coverage; research nothing", false)
  .description(
    "Backfill product-aware dossiers onto live prospects and pending (or, with --include-unsent, all unsent) review rows",
  )
  .action(
    runOrFail(
      async (opts: {
        limit?: number;
        scope?: string;
        concurrency?: number;
        maxCostUsd?: number;
        costLimit: boolean;
        firstPartyOnly: boolean;
        refresh: boolean;
        includePending: boolean;
        includeUnsent: boolean;
        dryRun: boolean;
      }) => {
        await commandResearchProducts({
          dryRun: opts.dryRun,
          refresh: opts.refresh,
          includePending: opts.includePending,
          includeUnsent: opts.includeUnsent,
          externalResearch: !opts.firstPartyOnly,
          ...(opts.costLimit !== false && opts.maxCostUsd != null
            ? { maxCostUsd: opts.maxCostUsd }
            : {}),
          ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
          ...(opts.scope ? { scope: opts.scope } : {}),
          ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
        });
      },
    ),
  );

find
  .command("rejudge-offers")
  .option(
    "--limit <n>",
    "max Queue entries by default; outdated sequences with --sequences; active sequences with --list-excluded; Queue entries and sequences combined with --rewrite-all-weak (default all)",
    positiveInt("--limit"),
  )
  .option("--concurrency <n>", "parallel judge calls (default 3)", positiveInt("--concurrency"))
  .option("--dry-run", "judge and print what would change; write nothing", false)
  .option(
    "--rewrite-all-weak",
    "write new offers (research first when missing) for live rows and sequences whose every offer is weak; spends money",
    false,
  )
  .option(
    "--list-excluded",
    "list active sequences whose offers match your excluded offer types; one paid assessment each, changes nothing",
    false,
  )
  .option(
    "--sequences",
    "bring outdated offers in active sequences up to date: keep or switch to a suitable offer, otherwise write new offers (hold the sequence without an offer if none qualifies); preserve founder-written, approved and already-sent offers and list them. With --dry-run: one paid assessment per sequence, print before/after without saving or writing new offers",
    false,
  )
  .description(
    "Reassess offers for unsent prospects in Queue against your workspace's offer criteria and excluded offer types; writes no new offers unless --rewrite-all-weak or --sequences",
  )
  .action(
    runOrFail(
      async (opts: {
        limit?: number;
        concurrency?: number;
        dryRun: boolean;
        rewriteAllWeak: boolean;
        listExcluded: boolean;
        sequences: boolean;
      }) => {
        const modes = [opts.listExcluded, opts.rewriteAllWeak, opts.sequences].filter(Boolean);
        if (modes.length > 1) {
          throw new Error("--list-excluded, --rewrite-all-weak and --sequences cannot be combined");
        }
        if (opts.listExcluded) {
          await commandListExcludedOffers({
            ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
            ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
          });
          return;
        }
        const run = opts.sequences
          ? commandRejudgeSequences
          : opts.rewriteAllWeak
            ? commandRewriteWeakOffers
            : commandRejudgeOffers;
        await run({
          dryRun: opts.dryRun,
          ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
          ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
        });
      },
    ),
  );

find
  .command("close-offers")
  .option("--limit <n>", "max sequences (default all)", positiveInt("--limit"))
  .option("--concurrency <n>", "parallel sequences (default 3)", positiveInt("--concurrency"))
  .option("--dry-run", "count what would be picked or written; write nothing, call no model", false)
  .description(
    "Choose the offer each emailed sequence's LinkedIn close makes, one its emails did not: a stored offer that passed, else a new one written around those already made (spends money)",
  )
  .action(
    runOrFail(async (opts: { limit?: number; concurrency?: number; dryRun: boolean }) => {
      await commandCloseOffers({
        dryRun: opts.dryRun,
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      });
    }),
  );

find
  .command("synthesize-angles")
  .option(
    "--limit <n>",
    "max prospects to synthesize an angle for (default 250)",
    (v) => Number.parseInt(v, 10),
    250,
  )
  .option(
    "--scope <list>",
    "comma-separated: active,replied,unjudged,all (default active,replied,unjudged)",
  )
  .option("--concurrency <n>", "parallel synthesis calls (default 3)", (v) =>
    Number.parseInt(v, 10),
  )
  .option("--refresh", "re-synthesize prospects that already have an angle", false)
  .option("--cheap", "use free evidence only; make no paid research calls", false)
  .option(
    "--apply",
    "no longer supported; generate proposals without --apply and review them in Queue → Learning",
    false,
  )
  .option("--max-cost-usd <n>", "stop once this much has been billed this run", (v) =>
    Number.parseFloat(v),
  )
  .option("--dry-run", "list candidates and estimated cost; synthesize nothing", false)
  .description(
    "Create outreach angles for prospects using their research, public GitHub activity and reply history, with supporting evidence",
  )
  .action(
    runOrFail(
      async (opts: {
        limit?: number;
        scope?: string;
        concurrency?: number;
        refresh: boolean;
        cheap: boolean;
        maxCostUsd?: number;
        dryRun: boolean;
        apply: boolean;
      }) => {
        await commandSynthesizeAngles({
          dryRun: opts.dryRun,
          refresh: opts.refresh,
          cheap: opts.cheap,
          apply: opts.apply,
          // Always forward the limit, including 0 and NaN. resolveCap validates
          // them; omitting falsy values would remove the paid run's cap.
          limit: opts.limit,
          ...(opts.scope ? { scope: opts.scope } : {}),
          ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
          ...(Number.isFinite(opts.maxCostUsd) ? { maxCostUsd: opts.maxCostUsd as number } : {}),
        });
      },
    ),
  );

find
  .command("score-prospects")
  .option("--scope <play|all>", "score only this play's rows (default all)")
  .option("--limit <n>", "max rows to score this run", (v) => Number.parseInt(v, 10))
  .option("--refresh", "recalculate scores even when they are already up to date", false)
  .option("--dry-run", "report score distributions; write nothing", false)
  .option("--report", "show score ranges and your approval rate for each finder", false)
  .option(
    "--all-statuses",
    "widen from pending/approved to every row (sent/rejected/expired), for evaluation only",
    false,
  )
  .description(
    "Score prospects for evaluation using saved information (free, resumable, no network)",
  )
  .action(
    runOrFail(
      (opts: {
        scope?: string;
        limit?: number;
        refresh: boolean;
        dryRun: boolean;
        report: boolean;
        allStatuses: boolean;
      }) => {
        commandScoreProspects({
          refresh: opts.refresh,
          dryRun: opts.dryRun,
          report: opts.report,
          allStatuses: opts.allStatuses,
          ...(opts.scope ? { scope: opts.scope } : {}),
          ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        });
      },
    ),
  );

find
  .command("backfill-fit-reason")
  .option("--play <name>", "only this play's rows (default: every play)")
  .option("--write", "persist; without it the run is a dry run and writes nothing", false)
  .option("--limit <n>", "max rows to touch this run", (v) => Number.parseInt(v, 10))
  .option(
    "--max-cost <usd>",
    "ceiling on estimated generation spend for this run (default 1.00)",
    (v) => {
      // NaN would compare false against every row's spend and lift the cap
      // for the whole run: refuse the value instead of running uncapped.
      const n = Number(v.trim());
      if (v.trim() === "" || !Number.isFinite(n) || n < 0) {
        throw new InvalidArgumentError("--max-cost must be a number >= 0");
      }
      return n;
    },
  )
  .option("--refresh", "update prospects that already have a fit explanation", false)
  .option("--no-generate", "free sources only")
  .description(
    "Add an ICP-fit explanation to pending and approved prospects in Queue (free sources first; paid generation capped)",
  )
  .action(
    runOrFail(
      async (opts: {
        play?: string;
        write: boolean;
        limit?: number;
        maxCost?: number;
        refresh: boolean;
        generate: boolean;
      }) => {
        await commandBackfillFitReason({
          write: opts.write,
          refresh: opts.refresh,
          generate: opts.generate,
          ...(opts.play ? { play: opts.play } : {}),
          ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
          ...(opts.maxCost !== undefined ? { maxCostUsd: opts.maxCost } : {}),
        });
      },
    ),
  );

find
  .command("calibrate")
  .option("--fit", "calibrate finders that have enough data and save the result", false)
  .description(
    "Calibrate priority scores against recorded outcomes. Runs only when enough outcomes exist.",
  )
  .action(runOrFail((opts: { fit: boolean }) => commandCalibrate({ fit: opts.fit })));

const cadence = program.command("cadence").description("Manage follow-up sequences");
cadence
  .command("advance")
  .option("--dry-run", "preview which steps would fire without sending", false)
  .description("Poll inbound for replies, then execute due follow-up steps for active cadences")
  .action(runOrFail(commandCadenceAdvance));
cadence
  .command("reclassify-auto")
  .option(
    "--since <days>",
    "automatic replies and policy blocks from the last N days (e.g. 14 or 14d)",
    (v: string) => {
      const days = Number(v.replace(/d$/i, ""));
      if (!Number.isFinite(days) || days <= 0)
        throw new Error("--since must be a positive number of days");
      return days;
    },
    14,
  )
  .option(
    "--write",
    "apply the actions (default: print what would be done). A dry run still asks the configured model about replies the rules cannot settle, so it can cost model calls, and --write asks again",
    false,
  )
  .description(
    "Read stored automatic replies again: stop sequences of people who left (adding a named successor for review), hold out-of-office ones until they are back, and stop policy-blocked ones. Never sends. Unclear replies cost one model call each, dry run included.",
  )
  .action(runOrFail(commandCadenceReclassifyAuto));

// These motion plays are CLI-only until their /run pages exist.
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
      await commandMotionPostFunding({
        targetFile: opts.target,
        dryRun: opts.dryRun,
      });
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
  .description("Same-day SMS + email recovery for demo no-shows; a day-3 follow-up is scheduled")
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
  .option("--skip-browser", "skip the browser evidence scrape", false)
  .option("--dry-run", "preview without sending", false)
  .description(
    "Migration-honesty pitch when prospect uses a known competitor (optionally collects public evidence)",
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
  .command("discovery-interview")
  .requiredOption(
    "-t, --target <file>",
    "JSON file: { name, email, company, businessType, topic }[]",
  )
  .option("--dry-run", "draft only, do not send", false)
  .description(
    "Main-street ask: ten minutes on how the owner-operator does this today. No pitch, no link, no price.",
  )
  .action(
    runOrFail(async (opts: { target: string; dryRun: boolean }) => {
      await commandMotionDiscoveryInterview({
        targetFile: opts.target,
        dryRun: opts.dryRun,
      });
    }),
  );
motion
  .command("free-pilot")
  .requiredOption(
    "-t, --target <file>",
    "JSON file: { name, email, company, businessType, yourEdge }[]",
  )
  .option("--dry-run", "draft only, do not send", false)
  .description("Main-street close: set it up free for them, they keep it if it works")
  .action(
    runOrFail(async (opts: { target: string; dryRun: boolean }) => {
      await commandMotionFreePilot({
        targetFile: opts.target,
        dryRun: opts.dryRun,
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
  .description("Build a 5-question PMF survey page and email it to a cohort (paid).")
  .action(runOrFail(commandPmfSurvey));
pmf
  .command("survey-collect")
  .option("-s, --since-days <n>", "collect inbound from the last N days", (v) =>
    Number.parseInt(v, 10),
  )
  .option("-o, --out <path>", "write analysis markdown to this file")
  .description("Collect inbound replies and synthesize a Sean Ellis report")
  .action(runOrFail(commandPmfSurveyCollect));

const measure = program
  .command("measure")
  .description("This workspace's sends by play and LinkedIn funnel; compare with the cohort")
  .option("--json", "output as JSON")
  .option("--since-days <n>", "only invites and sends from the last N days", (v) =>
    Number.parseFloat(v),
  )
  .option("--play <name>", "LinkedIn funnel: only this play")
  .option("--step-kind <kind>", "LinkedIn funnel: first-touch, continuation or friend")
  .action(runOrFail((opts: MeasureOptions) => commandMeasure(opts)));
measure
  .command("benchmark")
  .description("Compare this install with the anonymous telemetry cohort (needs telemetry on)")
  .option("--json", "output as JSON")
  .action(
    runOrFail((_opts: { json?: boolean }, cmd: Command) =>
      // The parent `measure` also declares --json, so commander binds the flag there.
      commandMeasureBenchmark({ json: cmd.optsWithGlobals<{ json?: boolean }>().json }),
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
  .command("backfill-intent")
  .option(
    "-l, --limit <n>",
    "max untriaged human replies to process (default 200)",
    (v: string) => {
      const limit = Number(v);
      if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new Error("--limit must be a non-negative integer");
      }
      return limit;
    },
  )
  .option("--reclassify", "re-label every human reply, not only untriaged ones")
  .option("--since <days>", "only replies from the last N days (e.g. 30 or 30d)", (v: string) => {
    const days = Number(v.replace(/d$/i, ""));
    if (!Number.isFinite(days) || days <= 0)
      throw new Error("--since must be a positive number of days");
    return days;
  })
  .option("--dry-run", "print old → new labels without writing (classify calls are still paid)")
  .option(
    "--allow-unsubscribe-downgrade",
    "let a re-label replace an existing unsubscribe (off by default)",
  )
  .description(
    "Classify intent on older replies that have none. Labels only; never triggers follow-ups or opt-outs.",
  )
  .action(
    runOrFail(
      async (opts: {
        limit?: number;
        reclassify?: boolean;
        since?: number;
        dryRun?: boolean;
        allowUnsubscribeDowngrade?: boolean;
      }) =>
        commandIntelBackfillIntent({
          ...(opts.limit != null ? { limit: opts.limit } : {}),
          ...(opts.reclassify ? { reclassify: true } : {}),
          ...(opts.since != null ? { sinceDays: opts.since } : {}),
          ...(opts.dryRun ? { dryRun: true } : {}),
          ...(opts.allowUnsubscribeDowngrade ? { allowUnsubscribeDowngrade: true } : {}),
        }),
    ),
  );
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

// Make every parent (group) command print help cleanly when invoked without a subcommand,
// instead of commander's default non-zero exit.
attachHelpFallbacks(program);

// Export without parsing argv so documentation checks can inspect the command tree.
export { program };

if (!process.env["ONESHOT_GTM_CLI_NO_PARSE"]) {
  program.parseAsync(process.argv).catch((err) => {
    fail((err as Error).message);
    process.exit(1);
  });
}

function runOrFail<A extends unknown[]>(fn: (...args: A) => void | Promise<void>) {
  return async (...args: A) => {
    const inv = extractInvocation(args);
    const start = performance.now();
    try {
      await fn(...args);
    } catch (err) {
      // A thrown error overrides any outcome marked by the command.
      await sendTelemetry(inv, "error", start);
      // CommandExit already printed its message via bail(); a raw error hasn't.
      if (err instanceof CommandExit) process.exit(err.code);
      fail((err as Error).message);
      process.exit(1);
    }
    // Clean return: honor an explicit marker (e.g. "lint-blocked"), else "ok".
    await sendTelemetry(inv, takeMarkedOutcome() ?? "ok", start);
  };
}

/**
 * Build and transmit the anonymous summary event for one invocation. Gated on
 * the opt-out flag + env kill switch, bounded by reportCommand's own timeout,
 * and fully best-effort. A telemetry failure must never affect the command.
 */
async function sendTelemetry(
  inv: Invocation,
  outcome: TelemetryOutcome,
  startMs: number,
): Promise<void> {
  await reportTelemetryEvent({
    command: inv.command,
    flags: inv.flags,
    outcome,
    durationMs: performance.now() - startMs,
    version: CLI_VERSION,
  });
}

function attachHelpFallbacks(cmd: Command): void {
  for (const sub of cmd.commands) {
    const isGroup = sub.commands.length > 0;
    if (isGroup) {
      if (!(sub as unknown as { _actionHandler?: unknown })._actionHandler) {
        sub.action(() => {
          sub.outputHelp();
        });
      }
      attachHelpFallbacks(sub);
    }
  }
}
