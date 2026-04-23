import { buildSite, getLedger, listInbox, loadConfig, sendEmail } from "@oneshot-gtm/core";
import { complete, loadPrompt } from "@oneshot-gtm/intel";
import { draftEmailFromPrompt, lintEmail } from "./_lib.ts";

const PLAY_NAME = "pmf-survey";

export interface PmfSurveyDeployInput {
  cohortEmails: string[];
  productName: string;
  productDescription: string;
  primaryColor?: string;
  /** Skip the OneShot Build step and use a fallback URL (or none, in which case the survey is inline in the email). */
  customSurveyUrl?: string;
  dryRun: boolean;
}

export interface PmfSurveyDeployResult {
  surveyUrl: string | null;
  builtSite: boolean;
  emailsDrafted: Array<{
    to: string;
    subject: string;
    body: string;
    flags: string[];
    sent: boolean;
    receiptIds: number[];
  }>;
  totalReceiptIds: number[];
}

const SURVEY_QUESTIONS = [
  "How would you feel if you could no longer use {productName}? (very disappointed / somewhat disappointed / not disappointed / N/A)",
  "What type of people do you think would most benefit from {productName}?",
  "What is the main benefit you receive from {productName}?",
  "How can we improve {productName} for you?",
  "Have you recommended {productName} to anyone? (yes/no — and if yes, who?)",
];

function questionsFor(productName: string): string[] {
  return SURVEY_QUESTIONS.map((q) => q.replaceAll("{productName}", productName));
}

export async function deployPmfSurvey(input: PmfSurveyDeployInput): Promise<PmfSurveyDeployResult> {
  const cfg = loadConfig();
  if (!cfg.founderName || !cfg.productOneLiner) {
    throw new Error("founder profile incomplete. Run: oneshot-gtm config founder");
  }

  const totalReceiptIds: number[] = [];
  let surveyUrl: string | null = input.customSurveyUrl ?? null;
  let builtSite = false;

  if (!surveyUrl && !input.dryRun) {
    const built = await buildSite(
      {
        name: `${input.productName} — PMF survey`,
        description: `A 5-question Superhuman PMF survey for ${input.productName} users. Takes 90 seconds. Responses help shape the product.`,
        type: "funnel",
        sections: ["hero", "five-question-form", "thank-you"],
        leadCaptureEmail: cfg.founderEmail ?? undefined,
        ...(input.primaryColor ? { primaryColor: input.primaryColor } : {}),
        tone: "minimal",
      },
      { playName: PLAY_NAME },
    );
    totalReceiptIds.push(built.receiptId);
    builtSite = true;
    surveyUrl = built.result.production_url ?? built.result.preview_url ?? null;
  }

  const emailsDrafted: PmfSurveyDeployResult["emailsDrafted"] = [];
  for (const userEmail of input.cohortEmails) {
    const draft = await draftEmailFromPrompt({
      promptName: "pmf-survey-email",
      inputBlock: [
        `FOUNDER: ${cfg.founderName}`,
        `PRODUCT: ${cfg.productOneLiner}`,
        `USER EMAIL: ${userEmail}`,
        `SURVEY URL: ${surveyUrl ?? "(no landing page; questions will be inline below)"}`,
      ].join("\n"),
    });

    let body = draft.body;
    if (!surveyUrl) {
      body += `\n\n---\n\n${questionsFor(input.productName)
        .map((q, i) => `${i + 1}. ${q}`)
        .join("\n")}\n\nReply directly to this email.`;
    }

    const flags = lintEmail(draft.subject, body, 200);
    let sent = false;
    const receiptIds: number[] = [];

    if (!input.dryRun && flags.length === 0) {
      const send = await sendEmail(
        { to: userEmail, subject: draft.subject, body },
        { playName: PLAY_NAME },
      );
      receiptIds.push(send.receiptId);
      totalReceiptIds.push(send.receiptId);
      const ledger = getLedger();
      const prospectId = ledger.upsertProspect({ email: userEmail, source: "pmf-survey-cohort" });
      ledger.recordSequenceEvent({
        prospectId,
        playName: PLAY_NAME,
        stepIndex: 0,
        channel: "email",
        status: "sent",
        metadata: { surveyUrl, builtSite, subject: draft.subject },
      });
      sent = true;
    }

    emailsDrafted.push({
      to: userEmail,
      subject: draft.subject,
      body,
      flags,
      sent,
      receiptIds,
    });
  }

  return { surveyUrl, builtSite, emailsDrafted, totalReceiptIds };
}

export interface PmfSurveyResponse {
  email: string;
  q1Disappointment?: "very" | "somewhat" | "not" | "n/a";
  q2WhoBenefits?: string;
  q3MainBenefit?: string;
  q4Improvements?: string;
  q5Recommended?: string;
  raw?: string;
}

export interface PmfSurveyAnalysis {
  markdown: string;
  veryDisappointedPercent: number;
  responseCount: number;
}

export async function analyzePmfSurvey(responses: PmfSurveyResponse[]): Promise<PmfSurveyAnalysis> {
  const system = loadPrompt("pmf-survey-synthesize");
  const counts = {
    very: 0,
    somewhat: 0,
    not: 0,
    na: 0,
  };
  for (const r of responses) {
    if (r.q1Disappointment === "very") counts.very++;
    else if (r.q1Disappointment === "somewhat") counts.somewhat++;
    else if (r.q1Disappointment === "not") counts.not++;
    else counts.na++;
  }
  const eligible = counts.very + counts.somewhat + counts.not;
  const pct = eligible > 0 ? (counts.very / eligible) * 100 : 0;

  const res = await complete({
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(responses, null, 2) },
    ],
    temperature: 0.3,
    maxTokens: 1500,
  });

  return {
    markdown: res.content.trim(),
    veryDisappointedPercent: Number(pct.toFixed(1)),
    responseCount: responses.length,
  };
}

export async function collectInboundResponses(opts?: {
  sinceIso?: string;
}): Promise<PmfSurveyResponse[]> {
  const inbox = await listInbox({
    ...(opts?.sinceIso ? { since: opts.sinceIso } : {}),
    limit: 100,
  });
  // Naive parsing: try to extract q1 disappointment level from reply text.
  const responses: PmfSurveyResponse[] = [];
  for (const e of inbox.emails) {
    const body = (e.body ?? "").slice(0, 4000);
    const lower = body.toLowerCase();
    let q1: PmfSurveyResponse["q1Disappointment"] | undefined;
    if (/\bvery disappointed\b/.test(lower)) q1 = "very";
    else if (/\bsomewhat disappointed\b/.test(lower)) q1 = "somewhat";
    else if (/\bnot disappointed\b/.test(lower)) q1 = "not";
    else if (/\bn\/a\b|\bnot applicable\b/.test(lower)) q1 = "n/a";
    responses.push({
      email: e.from,
      ...(q1 ? { q1Disappointment: q1 } : {}),
      raw: body,
    });
  }
  return responses;
}
