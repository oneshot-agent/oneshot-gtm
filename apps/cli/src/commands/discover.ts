import {
  analyzePmfSurvey,
  collectInboundResponses,
  deployPmfSurvey,
  generateInterviewPrep,
  pmfClassify,
  synthesizeFromDir,
} from "@oneshot-gtm/plays";
import { readFileSync, writeFileSync } from "node:fs";
import prompts from "prompts";
import { bail, box, c, header, note, ok, warn } from "../output.ts";

export async function commandIcpInterviewPrep(
  hypothesisArg: string | undefined,
  opts: { out?: string; fromFile?: string; stdin?: boolean } = {},
): Promise<void> {
  header(`discover icp interview-prep`);
  const hypothesis = await resolveHypothesis(hypothesisArg, opts);
  if (!hypothesis) {
    bail(
      "no hypothesis given. Pass it as an arg, with --from-file <path>, --stdin, or run with no args for an interactive prompt.",
    );
  }
  note(`Hypothesis: ${c.cyan(truncate(hypothesis, 120))}\n`);
  const md = await generateInterviewPrep(hypothesis);
  if (opts.out) {
    writeFileSync(opts.out, md);
    ok(`Wrote ${c.cyan(opts.out)}`);
  } else {
    process.stdout.write(md + "\n");
  }
}

async function resolveHypothesis(
  arg: string | undefined,
  opts: { fromFile?: string; stdin?: boolean },
): Promise<string | null> {
  if (arg && arg.trim().length > 0) return arg.trim();
  if (opts.fromFile) {
    return readFileSync(opts.fromFile, "utf8").trim();
  }
  if (opts.stdin || !process.stdin.isTTY) {
    const buf = await Bun.stdin.text();
    if (buf.trim().length > 0) return buf.trim();
  }
  // Interactive fallback — multi-line OK; press Enter on a blank line to submit.
  const a = (await prompts(
    {
      type: "text",
      name: "v",
      message: "Hypothesis (one or two sentences)",
      validate: (s) => (s.trim().length >= 20 ? true : "give a fuller hypothesis (20+ chars)"),
    },
    { onCancel: () => process.exit(0) },
  )) as { v?: string };
  return (a.v ?? "").trim() || null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trim() + "…";
}

export async function commandPmfClassify(): Promise<void> {
  header("discover pmf classify");
  note(
    "Classifies your startup against Sequoia Arc + Balfour Four Fits. 6 questions, no agent calls.\n",
  );

  const answers = await prompts(
    [
      { type: "text", name: "buyer", message: "Who is the buyer? (role, company size, industry)" },
      { type: "text", name: "painInTheirWords", message: "What is the pain — IN THEIR WORDS?" },
      {
        type: "select",
        name: "urgency",
        message: "How urgently do they need a fix?",
        choices: [
          { title: "right now (bleeding)", value: "right_now" },
          { title: "soon (this quarter)", value: "soon" },
          { title: "eventual (someday)", value: "eventual" },
          { title: "would be nice", value: "would_be_nice" },
        ],
      },
      {
        type: "text",
        name: "workaround",
        message: "What do they do today instead? (workaround, competitor, nothing)",
      },
      { type: "text", name: "salesCycle", message: "Sales cycle so far (days/weeks/months)?" },
      {
        type: "text",
        name: "firstDollarAmount",
        message: "Typical first-dollar amount from a new customer?",
      },
    ],
    { onCancel: () => process.exit(0) },
  );

  if (!answers["buyer"] || !answers["painInTheirWords"]) {
    bail("required answers missing.");
  }

  const result = await pmfClassify({
    buyer: answers["buyer"] as string,
    painInTheirWords: answers["painInTheirWords"] as string,
    urgency: (answers["urgency"] as string) ?? "",
    workaround: (answers["workaround"] as string) ?? "",
    salesCycle: (answers["salesCycle"] as string) ?? "",
    firstDollarAmount: (answers["firstDollarAmount"] as string) ?? "",
  });

  box("Sequoia Arc", `${c.bold(result.sequoiaArc)} — ${result.sequoiaReasoning}`);

  process.stdout.write(c.bold("Four Fits:\n"));
  for (const [name, status] of Object.entries(result.fourFits)) {
    const tag =
      status === "fit" ? c.green(status) : status === "misfit" ? c.red(status) : c.dim(status);
    process.stdout.write(`  ${name.padEnd(10)} ${tag}\n`);
  }
  process.stdout.write(`  ${c.dim(result.fourFitsReasoning)}\n\n`);

  box("Recommended motion", result.recommendedMotion);

  if (result.nextActions.length > 0) {
    process.stdout.write(c.bold("Next actions:\n"));
    result.nextActions.forEach((a, i) => process.stdout.write(`  ${i + 1}. ${a}\n`));
    process.stdout.write("\n");
  }
}

export async function commandPmfSurvey(opts: {
  cohortFile?: string;
  productName?: string;
  productDescription?: string;
  customSurveyUrl?: string;
  primaryColor?: string;
  dryRun: boolean;
}): Promise<void> {
  header(`discover pmf survey ${opts.dryRun ? c.dim("(dry-run)") : ""}`);
  if (!opts.cohortFile) {
    bail("--cohort <file> is required (text file with one email per line, or JSON array)");
  }
  const productName = opts.productName ?? (await askText("Product name (for the landing page)"));
  const productDescription =
    opts.productDescription ?? (await askText("Short product description (10-200 chars)"));
  const cohortEmails = readCohortFile(opts.cohortFile);
  note(`${cohortEmails.length} cohort emails loaded.\n`);

  const result = await deployPmfSurvey({
    cohortEmails,
    productName,
    productDescription,
    ...(opts.customSurveyUrl ? { customSurveyUrl: opts.customSurveyUrl } : {}),
    ...(opts.primaryColor ? { primaryColor: opts.primaryColor } : {}),
    dryRun: opts.dryRun,
  });

  if (result.surveyUrl) ok(`Survey URL: ${c.cyan(result.surveyUrl)}`);
  else note("No landing page (will collect responses via reply)");

  for (const e of result.emailsDrafted) {
    box(e.to, `${c.bold("Subject:")} ${e.subject}\n\n${e.body}`);
    if (e.flags.length > 0) warn(`flags: ${e.flags.join(", ")}`);
    if (e.sent) ok("sent");
    else if (opts.dryRun) note("(dry-run)");
  }
  ok(`Total receipts: ${result.totalReceiptIds.length}`);
}

export async function commandPmfSurveyCollect(opts: {
  sinceDays?: number;
  out?: string;
}): Promise<void> {
  header("discover pmf survey-collect");
  const sinceIso = opts.sinceDays
    ? new Date(Date.now() - opts.sinceDays * 24 * 3600 * 1000).toISOString()
    : undefined;
  const responses = await collectInboundResponses(sinceIso ? { sinceIso } : {});
  if (responses.length === 0) {
    note("No inbound responses found.");
    return;
  }
  ok(`Collected ${responses.length} responses.`);
  const analysis = await analyzePmfSurvey(responses);
  process.stdout.write(
    `\nSean Ellis score: ${c.bold(`${analysis.veryDisappointedPercent}%`)} very disappointed\n\n`,
  );
  if (opts.out) {
    writeFileSync(opts.out, analysis.markdown);
    ok(`wrote ${c.cyan(opts.out)}`);
  } else {
    process.stdout.write(analysis.markdown + "\n");
  }
}

function readCohortFile(path: string): string[] {
  const raw = readFileSync(path, "utf8").trim();
  if (raw.startsWith("[")) {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) throw new Error("cohort JSON must be an array of emails");
    return arr.filter((s): s is string => typeof s === "string" && s.includes("@"));
  }
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.includes("@") && !s.startsWith("#"));
}

async function askText(message: string): Promise<string> {
  const a = (await prompts(
    {
      type: "text",
      name: "v",
      message,
      validate: (s) => (s.trim().length > 0 ? true : "required"),
    },
    { onCancel: () => process.exit(0) },
  )) as { v?: string };
  return a.v ?? "";
}

export async function commandIcpSynthesize(transcriptDir: string): Promise<void> {
  header(`discover icp synthesize`);
  const out = await synthesizeFromDir(transcriptDir);
  process.stdout.write(`Files read: ${c.cyan(String(out.filesRead))}\n\n`);

  if (out.switchMoment) {
    box("Switch moment", out.switchMoment);
  }

  if (out.jtbd.length > 0) {
    process.stdout.write(c.bold("Jobs To Be Done:\n"));
    for (const j of out.jtbd) process.stdout.write(`  • ${j}\n`);
    process.stdout.write("\n");
  }

  if (out.painQuotes.length > 0) {
    process.stdout.write(c.bold("Pain quotes:\n"));
    for (const q of out.painQuotes) process.stdout.write(`  ${c.dim('"')}${q}${c.dim('"')}\n`);
    process.stdout.write("\n");
  }

  if (out.icpLanguage.length > 0) {
    process.stdout.write(c.bold("ICP language to steal:\n"));
    for (const p of out.icpLanguage) process.stdout.write(`  • ${p}\n`);
    process.stdout.write("\n");
  }
}
