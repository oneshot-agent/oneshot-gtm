import { getLedger } from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";

export type Verdict = "green" | "yellow" | "red";
type SignalStatus = "met" | "partial" | "not_met" | "unknown";

export interface ReadinessAnswers {
  seanEllisAboveForty: "yes" | "no" | "not_yet";
  inboundOverOutbound: "yes" | "no" | "trending";
  threeQuestionsPredictClose: "yes" | "no" | "partial";
  weekEightRetentionFlat: "yes" | "no" | "not_yet";
  threeSentencePitch: "yes" | "no" | "partial";
  nrrAboveOneHundred: "yes" | "no" | "unknown";
}

export interface ReadinessResult {
  verdict: Verdict;
  reasoning: string;
  signals: Array<{ name: string; status: SignalStatus; note: string }>;
  nextActionIfRed: string;
  nextActionIfGreen: string;
  raw: string;
}

export async function handoffReadiness(input: ReadinessAnswers): Promise<ReadinessResult> {
  const system = loadPrompt("handoff-readiness");
  const ledger = getLedger();
  const totalSends = ledger.countSends();
  const spendByPlay = ledger.spendByPlay();
  const eventsByPlay = ledger.eventsByPlay();

  const userBlock = [
    `SELF-ASSESSMENT:`,
    `- Sean Ellis 40%+: ${input.seanEllisAboveForty}`,
    `- Inbound > outbound: ${input.inboundOverOutbound}`,
    `- 3 discovery questions predict close: ${input.threeQuestionsPredictClose}`,
    `- Week-8 retention flat: ${input.weekEightRetentionFlat}`,
    `- 3-sentence pitch + customer self-identifies: ${input.threeSentencePitch}`,
    `- NRR > 100%: ${input.nrrAboveOneHundred}`,
    "",
    `LEDGER:`,
    `- Total hand-tracked sends: ${totalSends}`,
    `- Plays run: ${spendByPlay.map((p) => `${p.play_name}=${p.calls}`).join(", ") || "(none)"}`,
    `- Events: ${eventsByPlay.map((e) => `${e.play_name}: sent=${e.sent}/replied=${e.replied}`).join("; ") || "(none)"}`,
  ].join("\n");

  const res = await complete({
    messages: [
      { role: "system", content: system },
      { role: "user", content: userBlock },
    ],
    temperature: 0.3,
    maxTokens: 800,
  });

  return parseHandoffJson<ReadinessResult>(res.content, {
    verdict: "yellow",
    reasoning: "",
    signals: [],
    nextActionIfRed: "",
    nextActionIfGreen: "",
    raw: res.content,
  });
}

export interface TemplatizeInput {
  emails: Array<{
    subject: string;
    body: string;
    recipient?: string;
    outcome?: "replied" | "no_reply";
  }>;
}

export interface TemplatizeResult {
  subjectTemplate: string;
  bodyTemplate: string;
  slotDefinitions: Array<{ slot: string; description: string }>;
  strippedSpecifics: string[];
  doDont: { do: string[]; dont: string[] };
  preflight: PreflightResult;
  raw: string;
}

interface PreflightResult {
  status: "earned" | "not_earned";
  handSends: number;
  threshold: number;
  proceedHint: string;
}

export function templatizePreflight(): PreflightResult {
  const ledger = getLedger();
  const totalSends = ledger.countSends();
  const threshold = 100;
  return {
    status: totalSends >= threshold ? "earned" : "not_earned",
    handSends: totalSends,
    threshold,
    proceedHint:
      totalSends >= threshold
        ? "You've earned this. Templatizing now."
        : `You've logged ${totalSends} hand-written sends. Canon says wait until ${threshold} so the template is grounded in real signal. You can pass --force to proceed anyway.`,
  };
}

export async function handoffTemplatize(input: TemplatizeInput): Promise<TemplatizeResult> {
  const system = loadPrompt("handoff-templatize");
  const userBlock = [
    `SOURCE EMAILS (${input.emails.length}):`,
    ...input.emails.map((e, i) => {
      return [
        `--- email #${i + 1} (outcome: ${e.outcome ?? "unknown"}) ---`,
        `Subject: ${e.subject}`,
        `Body:\n${e.body}`,
      ].join("\n");
    }),
  ].join("\n\n");

  const res = await complete({
    messages: [
      { role: "system", content: system },
      { role: "user", content: userBlock },
    ],
    temperature: 0.4,
    maxTokens: 1500,
  });

  const parsed = tryParseJsonObject<Record<string, unknown>>(res.content, {});

  const doDont = (parsed["do_dont"] as { do?: string[]; dont?: string[] } | undefined) ?? {};
  const slotDefs = parsed["slot_definitions"];

  return {
    subjectTemplate: String(parsed["subject_template"] ?? ""),
    bodyTemplate: String(parsed["body_template"] ?? ""),
    slotDefinitions: Array.isArray(slotDefs)
      ? slotDefs.flatMap((s): Array<{ slot: string; description: string }> => {
          if (!s || typeof s !== "object") return [];
          const r = s as Record<string, unknown>;
          return [{ slot: String(r["slot"] ?? ""), description: String(r["description"] ?? "") }];
        })
      : [],
    strippedSpecifics: asStringArray(parsed["stripped_specifics"]),
    doDont: { do: asStringArray(doDont.do), dont: asStringArray(doDont.dont) },
    preflight: templatizePreflight(),
    raw: res.content,
  };
}

export interface FirstAeAnswers {
  founderClosedTenPlus: "yes" | "no";
  repeatableMotion: "yes" | "no" | "partial";
  pmfSignals: "yes" | "no" | "partial";
  arrAboveOneM: "yes" | "no";
  pipelineExceedsBandwidth: "yes" | "no";
  approxArr: string;
}

export interface FirstAeResult {
  verdict: Verdict;
  headline: string;
  gateStatus: Array<{ gate: string; status: SignalStatus; note: string }>;
  theSpecificBlocker: string;
  lemkinLemma: string;
  raw: string;
}

export async function handoffFirstAe(input: FirstAeAnswers): Promise<FirstAeResult> {
  const system = loadPrompt("handoff-first-ae");
  const userBlock = [
    `SELF-ASSESSMENT:`,
    `1. Founder has closed 10+ deals: ${input.founderClosedTenPlus}`,
    `2. Repeatable motion (3 questions predict close >70%): ${input.repeatableMotion}`,
    `3. PMF signals met (Sean Ellis 40+, retention flat, NRR >100%): ${input.pmfSignals}`,
    `4. ARR ~$1M-$2M+: ${input.arrAboveOneM} (~${input.approxArr})`,
    `5. Pipeline exceeds founder bandwidth: ${input.pipelineExceedsBandwidth}`,
  ].join("\n");

  const res = await complete({
    messages: [
      { role: "system", content: system },
      { role: "user", content: userBlock },
    ],
    temperature: 0.3,
    maxTokens: 800,
  });

  return parseHandoffJson<FirstAeResult>(res.content, {
    verdict: "red",
    headline: "",
    gateStatus: [],
    theSpecificBlocker: "",
    lemkinLemma: "",
    raw: res.content,
  });
}

function parseHandoffJson<T extends { raw: string }>(content: string, fallback: T): T {
  const parsed = tryParseJsonObject<Record<string, unknown>>(content, {});
  // Map snake_case JSON keys to camelCase result keys for both shapes.
  const obj: Record<string, unknown> = {
    verdict: parsed["verdict"],
    reasoning: parsed["reasoning"],
    signals: parsed["signals"],
    nextActionIfRed: parsed["next_action_if_red"],
    nextActionIfGreen: parsed["next_action_if_green"],
    headline: parsed["headline"],
    gateStatus: parsed["gate_status"],
    theSpecificBlocker: parsed["the_specific_blocker"],
    lemkinLemma: parsed["lemkin_lemma"],
    raw: content,
  };
  return { ...fallback, ...stripUndefined(obj) } as T;
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}
