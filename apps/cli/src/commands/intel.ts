import {
  adviseOnce,
  classifyReplyIntent,
  generateFirstLine,
  triageInbox,
  weeklyReview,
  type LlmMessage,
} from "@oneshot-gtm/intel";
import { getLedger, loadConfig } from "@oneshot-gtm/core";
import { writeFileSync } from "node:fs";
import prompts from "prompts";
import { bail, box, c, header, note, ok, warn } from "../output.ts";

const EXIT_WORDS = new Set(["exit", "quit", "q", ":q", "bye", "done"]);

export async function commandIntelAdvise(opts: { once?: boolean } = {}): Promise<void> {
  header("intel advise — interactive coach");
  note(
    `Grounded in your last 7 days of receipts and the founder-led-sales canon. ${c.dim("(type 'exit' or ctrl-c to leave)")}\n`,
  );

  let history: LlmMessage[] = [];
  let turn = 0;
  let cancelled = false;

  while (true) {
    turn++;
    const { question } = (await prompts(
      {
        type: "text",
        name: "question",
        message: turn === 1 ? "What's on your mind?" : "→",
        validate: (s) => {
          const t = s.trim().toLowerCase();
          if (t.length === 0) return true; // allow empty to exit
          if (EXIT_WORDS.has(t)) return true;
          return s.trim().length >= 3 ? true : "say a bit more";
        },
      },
      {
        onCancel: () => {
          cancelled = true;
          return false;
        },
      },
    )) as { question?: string };

    if (cancelled) {
      process.stdout.write(`\n${c.dim("bye.")}\n`);
      return;
    }

    const q = (question ?? "").trim();
    if (!q || EXIT_WORDS.has(q.toLowerCase())) {
      note(c.dim("bye."));
      return;
    }

    const out = await adviseOnce({ question: q, history });
    history = out.history;
    box(`Recommendation #${turn}`, out.answer);
    if (out.citedPrinciples.length > 0) {
      process.stdout.write(
        `${c.dim("Cited:")} ${out.citedPrinciples.map((p) => c.cyan(`[${p}]`)).join(" ")}\n\n`,
      );
    }

    if (opts.once) return;
  }
}

export async function commandIntelWeeklyReview(opts: {
  out?: string;
  context?: string;
}): Promise<void> {
  header("intel weekly-review");
  const review = await weeklyReview(opts.context);
  if (opts.out) {
    writeFileSync(opts.out, review.markdown);
    ok(`wrote ${c.cyan(opts.out)}`);
  } else {
    process.stdout.write(`\n${review.markdown}\n\n`);
  }
  note(
    `aggregates: $${review.totalSpend.toFixed(2)} spend / ${review.totalCalls} calls / ${review.totalSent} sent / ${review.totalReplied} replied`,
  );
}

export async function commandIntelTriage(opts: {
  sinceDays?: number;
  limit?: number;
}): Promise<void> {
  header("intel triage-replies");
  const sinceIso = opts.sinceDays
    ? new Date(Date.now() - opts.sinceDays * 24 * 3600 * 1000).toISOString()
    : undefined;
  const triaged = await triageInbox({
    ...(sinceIso ? { sinceIso } : {}),
    limit: opts.limit ?? 25,
  });
  if (triaged.length === 0) {
    note("No inbound emails to triage.");
    return;
  }
  for (const t of triaged) {
    process.stdout.write(
      `\n${c.bold(`[${t.category}]`)} ${c.cyan(t.from)} ${c.dim(`→`)} ${t.subject}\n`,
    );
    process.stdout.write(`  ${c.dim("next:")} ${t.nextStep}\n`);
    if (t.reasoning) process.stdout.write(`  ${c.dim("why:")}  ${t.reasoning}\n`);
    if (t.draftedReply) {
      process.stdout.write(`  ${c.dim("draft:")}\n`);
      for (const line of t.draftedReply.split("\n")) {
        process.stdout.write(`    ${line}\n`);
      }
    }
  }
  process.stdout.write("\n");
  ok(`${triaged.length} replies triaged.`);
}

export interface BackfillIntentOptions {
  limit?: number;
  /** Re-label every human reply, not only untriaged ones. */
  reclassify?: boolean;
  /** Only replies received in the last N days. */
  sinceDays?: number;
  /** Classify and print old → new; write nothing. (Each classify call is still paid.) */
  dryRun?: boolean;
  /** Let a re-label replace an existing `unsubscribe`. Off by default: an opt-out is never silently undone. */
  allowUnsubscribeDowngrade?: boolean;
}

/**
 * Label persisted human replies with the workspace's reply classifier (issue
 * #480): by default the ones with no intent yet (history that predates the
 * classifier, or a failed call); with `reclassify`, every human reply, so a
 * new label set or engine can re-label history.
 *
 * Labels only. It never stops a cadence, records a reply, or opts anyone in
 * or out retroactively. A row already labelled `unsubscribe` keeps it unless
 * `allowUnsubscribeDowngrade` is set; the would-be change is printed instead.
 * Best-effort per row: one failure is logged and skipped, never aborts the run.
 */
export async function commandIntelBackfillIntent(opts: BackfillIntentOptions = {}): Promise<void> {
  header(
    `intel backfill-intent${opts.reclassify ? " --reclassify" : ""}${opts.dryRun ? " (dry run)" : ""}`,
  );
  const ledger = getLedger();
  const sinceIso =
    opts.sinceDays != null
      ? new Date(Date.now() - opts.sinceDays * 24 * 3600 * 1000).toISOString()
      : undefined;
  const limit = opts.limit ?? 200;
  const rows = opts.reclassify
    ? ledger.listHumanRepliesForReclassify({ ...(sinceIso ? { sinceIso } : {}), limit })
    : ledger.listUntriagedHumanReplies(limit).filter((r) => !sinceIso || r.received_at >= sinceIso);
  if (rows.length === 0) {
    note(
      opts.reclassify
        ? "No human replies in range."
        : "Nothing to backfill — every human reply already has an intent.",
    );
    return;
  }
  note(`${rows.length} human repl${rows.length === 1 ? "y" : "ies"} to label.`);

  let written = 0;
  let unchanged = 0;
  let failed = 0;
  let skipped = 0;
  let keptUnsubscribe = 0;
  let costMicros = 0;
  for (const r of rows) {
    const old = r.intent;
    // An untriaged row takes the same atomic claim the background poll takes
    // (#558/#559), so a row both of them see is paid for once. A row that
    // already has a label is never touched by the poll, so no claim is needed.
    const claimed = !opts.dryRun && old == null;
    if (claimed && !ledger.claimInboxReplyForTriage(r.id)) {
      skipped++;
      continue;
    }
    let labelled: Awaited<ReturnType<typeof classifyReplyIntent>>;
    try {
      labelled = await classifyReplyIntent({
        id: r.id,
        from: r.from_email,
        subject: r.subject ?? "",
        received_at: r.received_at,
        body: r.body,
      });
    } catch (err) {
      if (claimed) ledger.setInboxReplyIntent(r.id, null, null);
      failed++;
      warn(`…${r.id.slice(-8)} failed: ${(err as Error)?.message ?? "unknown error"}`);
      continue;
    }
    costMicros += labelled.costMicros ?? 0;
    const conf = labelled.confidence == null ? "" : ` ${labelled.confidence.toFixed(2)}`;
    const flag = labelled.review ? c.yellow(" check") : "";
    const blocked =
      old === "unsubscribe" && labelled.intent !== "unsubscribe" && !opts.allowUnsubscribeDowngrade;
    process.stdout.write(
      `  …${r.id.slice(-8)}  ${old ?? "(none)"} → ${labelled.intent}${conf}${flag}${
        blocked ? c.yellow("  (kept unsubscribe)") : ""
      }\n`,
    );
    if (blocked) {
      keptUnsubscribe++;
      continue;
    }
    if (old === labelled.intent && opts.reclassify) unchanged++;
    if (opts.dryRun) continue;
    ledger.setInboxReplyIntent(r.id, labelled.intent, labelled.reason || null, {
      confidence: labelled.confidence,
      probabilities: labelled.probabilities,
      classifier: labelled.classifier,
      costMicros: labelled.costMicros,
      review: labelled.review,
    });
    written++;
  }
  const cost = costMicros > 0 ? `, $${(costMicros / 1_000_000).toFixed(4)} classifier cost` : "";
  ok(
    `${opts.dryRun ? "would label" : "labelled"} ${opts.dryRun ? rows.length - failed - skipped - keptUnsubscribe : written} repl${written === 1 ? "y" : "ies"}` +
      (opts.reclassify ? ` (${unchanged} unchanged)` : "") +
      (failed > 0 ? `, ${failed} failed` : "") +
      (skipped > 0 ? `, ${skipped} already being triaged` : "") +
      (keptUnsubscribe > 0
        ? `, ${keptUnsubscribe} kept as unsubscribe (pass --allow-unsubscribe-downgrade to replace)`
        : "") +
      cost +
      ".",
  );
}

export async function commandIntelPersonalize(opts: {
  prospectName: string;
  prospectCompany: string;
  trigger: string;
  dossier?: string;
}): Promise<void> {
  header("intel personalize");
  const cfg = loadConfig();
  if (!cfg.founderName || !cfg.productOneLiner) {
    bail("founder profile incomplete. run: oneshot-gtm config founder");
  }
  const out = await generateFirstLine({
    founderName: cfg.founderName,
    founderProductOneLiner: cfg.productOneLiner,
    prospectName: opts.prospectName,
    prospectCompany: opts.prospectCompany,
    triggerContext: opts.trigger,
    prospectDossier: opts.dossier ?? "(no dossier provided — base only on the trigger)",
  });
  box("first line", out.firstLine);
  if (out.reasoning) note(`reasoning: ${out.reasoning}`);
  if (out.flagged.length > 0) {
    warn(`lint flags: ${out.flagged.join(", ")}`);
  } else {
    ok("clean");
  }
}
