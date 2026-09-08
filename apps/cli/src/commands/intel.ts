import {
  adviseOnce,
  generateFirstLine,
  triageEmails,
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

/**
 * Backfill sentiment intent onto persisted human replies that predate the
 * classifier (issue #480) — the ten replies the workspace had before this
 * shipped, and anyone else's pre-existing history. Best-effort per row: a
 * triage failure on one batch is logged and skipped, never aborts the run.
 */
export async function commandIntelBackfillIntent(opts: { limit?: number } = {}): Promise<void> {
  header("intel backfill-intent");
  const ledger = getLedger();
  const rows = ledger.listUntriagedHumanReplies(opts.limit ?? 200);
  if (rows.length === 0) {
    note("Nothing to backfill — every human reply already has an intent.");
    return;
  }
  note(`${rows.length} untriaged human repl${rows.length === 1 ? "y" : "ies"} found.`);

  const BATCH = 25;
  let done = 0;
  let failed = 0;
  let skipped = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    // Same atomic claim the background poll takes (#558/#559): this command
    // runs while the server's scheduler is live, and a row both of them see
    // untriaged must be paid for once. A lost claim means the poll has it.
    const batch = rows.slice(i, i + BATCH).filter((r) => {
      if (ledger.claimInboxReplyForTriage(r.id)) return true;
      skipped++;
      return false;
    });
    if (batch.length === 0) continue;
    try {
      const triaged = await triageEmails(
        batch.map((r) => ({
          id: r.id,
          from: r.from_email,
          subject: r.subject ?? "",
          received_at: r.received_at,
          body: r.body,
        })),
      );
      const byId = new Map(triaged.map((t) => [t.id, t]));
      for (const r of batch) {
        const t = byId.get(r.id);
        if (!t) {
          // Release the claim so a later poll (or re-run) can retry.
          ledger.setInboxReplyIntent(r.id, null, null);
          failed++;
          continue;
        }
        ledger.setInboxReplyIntent(r.id, t.category, t.reasoning || null);
        done++;
      }
    } catch (err) {
      for (const r of batch) ledger.setInboxReplyIntent(r.id, null, null);
      failed += batch.length;
      warn(`batch starting at row ${i} failed: ${(err as Error)?.message ?? "unknown error"}`);
    }
  }
  ok(
    `backfilled ${done} repl${done === 1 ? "y" : "ies"}${failed > 0 ? `, ${failed} failed` : ""}${skipped > 0 ? `, ${skipped} already being triaged` : ""}.`,
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
