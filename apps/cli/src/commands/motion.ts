import {
  receiptUrls,
  runBreakupRevive,
  runCompetitorSwitch,
  runConcierge,
  runDemoNoShow,
  runHiringSignal,
  runPodcastGuest,
  runPostFunding,
  verifyAndFilterTargets,
  type CompetitorSwitchTarget,
  type ConciergeTarget,
  type DemoNoShowTarget,
  type HiringSignalTarget,
  type PodcastGuestTarget,
  type PostFundingTarget,
} from "@oneshot-gtm/plays";
import { markTelemetryOutcome } from "@oneshot-gtm/core";
import { readFileSync } from "node:fs";
import { box, c, fail, header, note, ok, warn } from "../output.ts";

/**
 * Verify all target emails upfront so undeliverable rows are dropped
 * before drafting cost is spent. Skipped on dryRun. Returns the filtered
 * target list — caller hands it to the play.
 */
async function preVerify<T>(
  targets: T[],
  getEmail: (t: T) => string | null | undefined,
  opts: { playName: string; dryRun: boolean },
): Promise<T[]> {
  const r = await verifyAndFilterTargets(targets, getEmail, opts);
  if (r.dropped.length > 0) {
    warn(
      `dropped ${r.dropped.length} of ${targets.length} target(s) — undeliverable email:\n  ${r.dropped
        .map((d) => `${d.email || "(missing)"} — ${d.reason}`)
        .join("\n  ")}`,
    );
  }
  if (r.costUsd > 0) {
    note(`verify spend: $${r.costUsd.toFixed(3)} (${r.receiptIds.length} verify call(s))\n`);
  }
  return r.verified;
}

interface DraftedView {
  label: string;
  subject: string;
  body: string;
  flags: string[];
  receiptIds: number[];
  sent: boolean;
}

function printDrafts(drafts: DraftedView[], dryRun: boolean): void {
  for (const d of drafts) {
    box(d.label, `${c.bold("Subject:")} ${d.subject}\n\n${d.body}`);
    if (d.flags.length > 0) {
      warn(`Lint flags: ${d.flags.join(", ")}`);
    }
    if (d.receiptIds.length > 0) {
      const urls = receiptUrls(d.receiptIds);
      ok(`Receipts: ${urls.map((u) => c.dim(u)).join(" ")}`);
    }
    if (d.sent) ok(c.green("Sent."));
    else if (dryRun) note("(dry-run, not sent)");
    else if (d.flags.length > 0) {
      // The send was withheld by the anti-slop linter — not an error, but
      // distinct from a clean "ok". Surface it as its own telemetry outcome.
      markTelemetryOutcome("lint-blocked");
      fail("Not sent — fix lint flags or rerun.");
    }
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export async function commandMotionPostFunding(opts: {
  targetFile: string;
  dryRun: boolean;
}): Promise<void> {
  header(`motion post-funding ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const raw = readJson<PostFundingTarget[]>(opts.targetFile);
  note(`${raw.length} target(s) loaded from ${c.cyan(opts.targetFile)}\n`);
  const targets = await preVerify(raw, (t) => t.email, {
    playName: "post-funding",
    dryRun: opts.dryRun,
  });
  const result = await runPostFunding({ dryRun: opts.dryRun, targets });
  printDrafts(
    result.drafted.map((d) => ({
      label: `${d.target.name} — ${d.target.company} ${d.target.round}`,
      subject: d.subject,
      body: d.body,
      flags: d.flags,
      receiptIds: d.receiptIds,
      sent: d.sent,
    })),
    opts.dryRun,
  );
}

export async function commandMotionConcierge(opts: {
  targetFile: string;
  dryRun: boolean;
  skipPrep: boolean;
  skipSummary: boolean;
}): Promise<void> {
  header(`motion concierge ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const targets = readJson<ConciergeTarget[]>(opts.targetFile);
  note(`${targets.length} customer(s) loaded from ${c.cyan(opts.targetFile)}\n`);
  const result = await runConcierge({
    dryRun: opts.dryRun,
    targets,
    skipPrepEmail: opts.skipPrep,
    skipSummaryEmail: opts.skipSummary,
  });
  for (const o of result.outcomes) {
    box(`${o.target.name} (${o.target.email})`, "");
    if (o.prepEmail) {
      process.stdout.write(
        `${c.bold("prep email:")}\n  ${c.dim("subject:")} ${o.prepEmail.subject}\n  ${o.prepEmail.body.replaceAll("\n", "\n  ")}\n`,
      );
      if (o.prepEmail.flags.length) warn(`  flags: ${o.prepEmail.flags.join(", ")}`);
      else if (o.prepEmail.sent) ok("  sent");
    }
    if (o.voice) {
      process.stdout.write(
        `${c.bold("voice call:")} status=${o.voice.status} duration=${o.voice.duration_seconds ?? "?"}s\n`,
      );
      if (o.voice.summary) process.stdout.write(`  ${c.dim("summary:")} ${o.voice.summary}\n`);
    }
    if (o.summaryEmail) {
      process.stdout.write(
        `${c.bold("summary email:")}\n  ${c.dim("subject:")} ${o.summaryEmail.subject}\n  ${o.summaryEmail.body.replaceAll("\n", "\n  ")}\n`,
      );
      if (o.summaryEmail.flags.length) warn(`  flags: ${o.summaryEmail.flags.join(", ")}`);
      else if (o.summaryEmail.sent) ok("  sent");
    }
    if (o.receiptIds.length)
      ok(
        `receipts: ${receiptUrls(o.receiptIds)
          .map((u) => c.dim(u))
          .join(" ")}`,
      );
  }
}

export async function commandMotionDemoNoShow(opts: {
  targetFile: string;
  dryRun: boolean;
  skipSms: boolean;
}): Promise<void> {
  header(`motion demo-no-show ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const raw = readJson<DemoNoShowTarget[]>(opts.targetFile);
  note(`${raw.length} no-show(s) loaded from ${c.cyan(opts.targetFile)}\n`);
  const targets = await preVerify(raw, (t) => t.email, {
    playName: "demo-no-show",
    dryRun: opts.dryRun,
  });
  const result = await runDemoNoShow({ dryRun: opts.dryRun, targets, skipSms: opts.skipSms });
  for (const o of result.outcomes) {
    box(`${o.target.name} — ${o.target.company} (missed ${o.target.missedAt})`, "");
    if (o.sms) {
      process.stdout.write(`${c.bold("sms:")} ${o.sms.message}\n`);
      if (o.sms.sent) ok("  sent");
    }
    process.stdout.write(`${c.bold("email subject:")} ${o.email.subject}\n${o.email.body}\n`);
    if (o.email.flags.length) warn(`flags: ${o.email.flags.join(", ")}`);
    if (o.email.sent) ok("email sent");
    if (o.receiptIds.length)
      ok(
        `receipts: ${receiptUrls(o.receiptIds)
          .map((u) => c.dim(u))
          .join(" ")}`,
      );
  }
}

export async function commandMotionCompetitorSwitch(opts: {
  targetFile: string;
  dryRun: boolean;
  skipBrowser: boolean;
}): Promise<void> {
  header(`motion competitor-switch ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const raw = readJson<CompetitorSwitchTarget[]>(opts.targetFile);
  note(`${raw.length} target(s) loaded from ${c.cyan(opts.targetFile)}\n`);
  const targets = await preVerify(raw, (t) => t.email, {
    playName: "competitor-switch",
    dryRun: opts.dryRun,
  });
  const result = await runCompetitorSwitch({
    dryRun: opts.dryRun,
    targets,
    skipBrowserScrape: opts.skipBrowser,
  });
  printDrafts(
    result.drafted.map((d) => ({
      label: `${d.target.name} — ${d.target.company} (vs ${d.target.competitor})`,
      subject: d.subject,
      body: d.body,
      flags: d.flags,
      receiptIds: d.receiptIds,
      sent: d.sent,
    })),
    opts.dryRun,
  );
}

export async function commandMotionHiringSignal(opts: {
  targetFile: string;
  dryRun: boolean;
  skipScrape: boolean;
}): Promise<void> {
  header(`motion hiring-signal ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const raw = readJson<HiringSignalTarget[]>(opts.targetFile);
  note(`${raw.length} target(s) loaded from ${c.cyan(opts.targetFile)}\n`);
  const targets = await preVerify(raw, (t) => t.email, {
    playName: "hiring-signal",
    dryRun: opts.dryRun,
  });
  const result = await runHiringSignal({
    dryRun: opts.dryRun,
    targets,
    skipScrape: opts.skipScrape,
  });
  for (const d of result.drafted) {
    box(
      `${d.target.name} — ${d.target.company} (${d.target.jobTitle})`,
      `${c.bold("Subject:")} ${d.subject}\n\n${d.body}\n\n${c.dim("Hook:")} ${d.jobPostHook.slice(0, 200)}`,
    );
    if (d.flags.length) warn(`flags: ${d.flags.join(", ")}`);
    if (d.receiptIds.length)
      ok(
        `receipts: ${receiptUrls(d.receiptIds)
          .map((u) => c.dim(u))
          .join(" ")}`,
      );
    if (d.sent) ok("sent");
  }
}

export async function commandMotionPodcastGuest(opts: {
  targetFile: string;
  dryRun: boolean;
  skipSearch: boolean;
}): Promise<void> {
  header(`motion podcast-guest ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const raw = readJson<PodcastGuestTarget[]>(opts.targetFile);
  note(`${raw.length} guest(s) loaded from ${c.cyan(opts.targetFile)}\n`);
  const targets = await preVerify(raw, (t) => t.email, {
    playName: "podcast-guest",
    dryRun: opts.dryRun,
  });
  const result = await runPodcastGuest({
    dryRun: opts.dryRun,
    targets,
    skipSearch: opts.skipSearch,
  });
  printDrafts(
    result.drafted.map((d) => ({
      label: `${d.target.name} — ${d.target.podcast}`,
      subject: d.subject,
      body: d.body,
      flags: d.flags,
      receiptIds: d.receiptIds,
      sent: d.sent,
    })),
    opts.dryRun,
  );
}

export async function commandMotionBreakupRevive(opts: {
  dryRun: boolean;
  minDays?: number;
  maxDays?: number;
  limit?: number;
  valueDrop?: string;
}): Promise<void> {
  header(`motion breakup-revive ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  const result = await runBreakupRevive({
    dryRun: opts.dryRun,
    ...(opts.minDays != null ? { minDays: opts.minDays } : {}),
    ...(opts.maxDays != null ? { maxDays: opts.maxDays } : {}),
    ...(opts.limit != null ? { limit: opts.limit } : {}),
    ...(opts.valueDrop ? { valueDrop: opts.valueDrop } : {}),
  });
  if (result.drafted.length === 0) {
    note("No cold prospects in the requested window. Run a play first to populate the ledger.");
    return;
  }
  for (const d of result.drafted) {
    box(
      `${d.prospectName ?? "(unknown)"} — ${d.prospectEmail ?? "(no email)"} (${d.daysCold} days cold)`,
      `${c.bold("Subject:")} ${d.subject}\n\n${d.body}`,
    );
    if (d.flags.length) warn(`flags: ${d.flags.join(", ")}`);
    if (d.receiptIds.length)
      ok(
        `receipts: ${receiptUrls(d.receiptIds)
          .map((u) => c.dim(u))
          .join(" ")}`,
      );
    if (d.sent) ok("sent");
  }
}
