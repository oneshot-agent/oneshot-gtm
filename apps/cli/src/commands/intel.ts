import {
  adviseOnce,
  generateFirstLine,
  triageInbox,
  weeklyReview,
  type LlmMessage,
} from "@oneshot-gtm/intel";
import { loadConfig } from "@oneshot-gtm/core";
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
