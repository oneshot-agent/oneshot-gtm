import {
  handoffFirstAe,
  handoffReadiness,
  handoffTemplatize,
  templatizePreflight,
} from "@oneshot-gtm/plays";
import { readFileSync } from "node:fs";
import prompts from "prompts";
import { box, c, fail, header, note, ok, warn } from "../output.ts";

const VERDICT_COLOR: Record<"green" | "yellow" | "red", (s: string) => string> = {
  green: (s) => c.green(s),
  yellow: (s) => c.yellow(s),
  red: (s) => c.red(s),
};

const choices = (label: string, opts: string[]) => ({
  type: "select" as const,
  message: label,
  choices: opts.map((v) => ({ title: v, value: v.replace(/\s+/g, "_") })),
});

export async function commandHandoffReadiness(): Promise<void> {
  header("handoff readiness — six-signal PMF→scale check");
  note("This is a self-assessment. Be honest; the verdict shapes your next quarter.\n");

  const a = (await prompts(
    [
      {
        ...choices("Sean Ellis 40%+ sustained for 2+ months?", ["yes", "no", "not yet"]),
        name: "se",
      },
      {
        ...choices("Inbound > outbound for the first time?", ["yes", "no", "trending"]),
        name: "io",
      },
      {
        ...choices("Same 3 discovery questions predict close?", ["yes", "no", "partial"]),
        name: "dq",
      },
      { ...choices("Week-8 retention curve flat?", ["yes", "no", "not yet"]), name: "ret" },
      {
        ...choices("3-sentence pitch + customer self-identifies?", ["yes", "no", "partial"]),
        name: "pitch",
      },
      { ...choices("NRR > 100%?", ["yes", "no", "unknown"]), name: "nrr" },
    ],
    { onCancel: () => process.exit(0) },
  )) as Record<string, string>;

  const result = await handoffReadiness({
    seanEllisAboveForty: normalize(a["se"] ?? "", ["yes", "no", "not_yet"]) as never,
    inboundOverOutbound: normalize(a["io"] ?? "", ["yes", "no", "trending"]) as never,
    threeQuestionsPredictClose: normalize(a["dq"] ?? "", ["yes", "no", "partial"]) as never,
    weekEightRetentionFlat: normalize(a["ret"] ?? "", ["yes", "no", "not_yet"]) as never,
    threeSentencePitch: normalize(a["pitch"] ?? "", ["yes", "no", "partial"]) as never,
    nrrAboveOneHundred: normalize(a["nrr"] ?? "", ["yes", "no", "unknown"]) as never,
  });

  const color = VERDICT_COLOR[result.verdict] ?? c.dim;
  box(`Verdict: ${color(result.verdict.toUpperCase())}`, result.reasoning);

  if (result.signals.length > 0) {
    process.stdout.write(c.bold("Signals:\n"));
    for (const s of result.signals) {
      const tag =
        s.status === "met"
          ? c.green("met")
          : s.status === "partial"
            ? c.yellow("partial")
            : s.status === "not_met"
              ? c.red("not met")
              : c.dim("unknown");
      process.stdout.write(
        `  ${tag.padEnd(20)} ${s.name}${s.note ? ` ${c.dim("— " + s.note)}` : ""}\n`,
      );
    }
    process.stdout.write("\n");
  }

  if (result.verdict === "red" && result.nextActionIfRed) {
    fail(`Fix this first: ${result.nextActionIfRed}`);
  } else if (result.verdict === "green" && result.nextActionIfGreen) {
    ok(`Ready. Next: ${result.nextActionIfGreen}`);
  }
}

export async function commandHandoffTemplatize(opts: {
  input: string;
  force: boolean;
}): Promise<void> {
  header("handoff templatize");
  const pre = templatizePreflight();
  if (pre.status === "not_earned" && !opts.force) {
    warn(pre.proceedHint);
    const { proceed } = (await prompts(
      {
        type: "confirm",
        name: "proceed",
        message: "Continue anyway?",
        initial: false,
      },
      { onCancel: () => process.exit(0) },
    )) as { proceed?: boolean };
    if (!proceed) {
      note("Aborted. Run more hand-written sends, then re-run.");
      return;
    }
  } else if (pre.status === "earned") {
    ok(pre.proceedHint);
  }

  const raw = readFileSync(opts.input, "utf8");
  const emails = JSON.parse(raw) as Array<{
    subject: string;
    body: string;
    recipient?: string;
    outcome?: "replied" | "no_reply";
  }>;
  if (!Array.isArray(emails) || emails.length === 0) {
    fail("input file must be a JSON array of {subject, body, outcome?} objects");
    process.exit(1);
  }
  note(
    `Extracting from ${emails.length} sent emails (${emails.filter((e) => e.outcome === "replied").length} replied)\n`,
  );

  const result = await handoffTemplatize({ emails });
  box("subject template", result.subjectTemplate);
  box("body template", result.bodyTemplate);

  if (result.slotDefinitions.length > 0) {
    process.stdout.write(c.bold("Slots:\n"));
    for (const s of result.slotDefinitions) {
      process.stdout.write(`  ${c.cyan(`{${s.slot}}`)} — ${s.description}\n`);
    }
    process.stdout.write("\n");
  }

  if (result.doDont.do.length > 0 || result.doDont.dont.length > 0) {
    box(
      "do / don't",
      [
        ...result.doDont.do.map((d) => `${c.green("do")}    ${d}`),
        ...result.doDont.dont.map((d) => `${c.red("don't")} ${d}`),
      ].join("\n"),
    );
  }
}

export async function commandHandoffFirstAe(): Promise<void> {
  header("handoff first-ae — should you hire your first AE?");
  note("Five gates from the Lemkin / Blond / Kazanjy canon. Be honest.\n");

  const a = (await prompts(
    [
      {
        ...choices("Have you (founder) personally closed 10+ deals?", ["yes", "no"]),
        name: "closed",
      },
      {
        ...choices("Repeatable motion (3 questions predict close >70%)?", ["yes", "no", "partial"]),
        name: "rep",
      },
      {
        ...choices("PMF signals met? (Sean Ellis 40+, retention, NRR)", ["yes", "no", "partial"]),
        name: "pmf",
      },
      { ...choices("ARR ~$1M-$2M with founder selling?", ["yes", "no"]), name: "arr" },
      { type: "text", name: "approxArr", message: "Approximate ARR (e.g. $850k)" },
      {
        ...choices("Pipeline exceeds founder bandwidth (turning down meetings)?", ["yes", "no"]),
        name: "bw",
      },
    ],
    { onCancel: () => process.exit(0) },
  )) as Record<string, string>;

  const result = await handoffFirstAe({
    founderClosedTenPlus: normalize(a["closed"] ?? "", ["yes", "no"]) as never,
    repeatableMotion: normalize(a["rep"] ?? "", ["yes", "no", "partial"]) as never,
    pmfSignals: normalize(a["pmf"] ?? "", ["yes", "no", "partial"]) as never,
    arrAboveOneM: normalize(a["arr"] ?? "", ["yes", "no"]) as never,
    pipelineExceedsBandwidth: normalize(a["bw"] ?? "", ["yes", "no"]) as never,
    approxArr: a["approxArr"] ?? "",
  });

  const color = VERDICT_COLOR[result.verdict] ?? c.dim;
  box(`Verdict: ${color(result.verdict.toUpperCase())}`, result.headline);

  if (result.gateStatus.length > 0) {
    process.stdout.write(c.bold("Gates:\n"));
    for (const g of result.gateStatus) {
      const tag =
        g.status === "met"
          ? c.green("met")
          : g.status === "partial"
            ? c.yellow("partial")
            : g.status === "not_met"
              ? c.red("not met")
              : c.dim("unknown");
      process.stdout.write(
        `  ${tag.padEnd(20)} ${g.gate}${g.note ? ` ${c.dim("— " + g.note)}` : ""}\n`,
      );
    }
    process.stdout.write("\n");
  }

  if (result.verdict !== "green" && result.theSpecificBlocker) {
    fail(`Blocker: ${result.theSpecificBlocker}`);
  }
  if (result.lemkinLemma) note(`${c.dim("→")} ${result.lemkinLemma}`);
}

function normalize(input: string, allowed: string[]): string {
  const v = input.toLowerCase();
  return allowed.find((a) => v.startsWith(a)) ?? allowed[allowed.length - 1] ?? input;
}
