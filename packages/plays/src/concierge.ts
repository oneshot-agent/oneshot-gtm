import {
  getLedger,
  loadConfig,
  receiptUrlForId,
  sendEmail,
  voiceCall,
  type VoiceCallResult,
} from "@oneshot-gtm/core";
import { complete, loadPrompt } from "@oneshot-gtm/intel";
import { lintEmail } from "./_lib.ts";

const PLAY_NAME = "concierge";

export interface ConciergeTarget {
  name: string;
  email: string;
  phone: string;
  signupContext?: string;
  callWindow?: string;
}

export interface ConciergeRunOptions {
  dryRun: boolean;
  targets: ConciergeTarget[];
  /** Skip the pre-call email (default: send it). */
  skipPrepEmail?: boolean;
  /** Skip the post-call summary email (default: send it). */
  skipSummaryEmail?: boolean;
  /** Max minutes for the voice call (default 8). */
  maxDurationMinutes?: number;
}

export interface ConciergeRunResult {
  outcomes: Array<{
    target: ConciergeTarget;
    prepEmail: { subject: string; body: string; sent: boolean; flags: string[] } | null;
    voice: VoiceCallResult | null;
    summaryEmail: { subject: string; body: string; sent: boolean; flags: string[] } | null;
    receiptIds: number[];
  }>;
}

export async function runConcierge(opts: ConciergeRunOptions): Promise<ConciergeRunResult> {
  const cfg = loadConfig();
  if (!cfg.founderName || !cfg.productOneLiner) {
    throw new Error("founder profile incomplete. Run: oneshot-gtm config founder");
  }
  const outcomes: ConciergeRunResult["outcomes"] = [];

  for (const t of opts.targets) {
    const receiptIds: number[] = [];
    const window = t.callWindow ?? "in the next 30 minutes";

    // 1. Pre-call email (optional)
    let prepEmail: ConciergeRunResult["outcomes"][number]["prepEmail"] = null;
    if (!opts.skipPrepEmail) {
      const draft = await draftWithPrompt({
        promptName: "concierge-prep-email",
        inputBlock: [
          `FOUNDER: ${cfg.founderName}`,
          `PRODUCT: ${cfg.productOneLiner}`,
          `CUSTOMER: ${t.name}`,
          `CONTEXT: ${t.signupContext ?? "(new signup)"}`,
          `CALL WINDOW: ${window}`,
        ].join("\n"),
      });
      const flags = lintEmail(draft.subject, draft.body, 80);
      let sent = false;
      if (!opts.dryRun && flags.length === 0) {
        const send = await sendEmail(
          { to: t.email, subject: draft.subject, body: draft.body },
          { playName: PLAY_NAME },
        );
        receiptIds.push(send.receiptId);
        sent = true;
      }
      prepEmail = { ...draft, sent, flags };
    }

    // 2. Voice call
    let voice: VoiceCallResult | null = null;
    if (!opts.dryRun) {
      const objective = [
        `Introduce yourself as the OneShot agent for ${cfg.founderName}, calling on behalf of ${cfg.productOneLiner}.`,
        `Confirm the customer (${t.name}) is who you're talking to.`,
        `Ask: "What's the one thing you're trying to get out of ${cfg.productOneLiner.split(/[.,]/)[0]} this week?"`,
        `Listen and probe for the SPECIFIC use case and the ONE blocker stopping them from getting value.`,
        `If they have a clear blocker, offer to have ${cfg.founderName} follow up by email today.`,
        `Keep it under 5 minutes. End with a clear next step.`,
      ].join(" ");
      const context = [
        `Signup context: ${t.signupContext ?? "new signup"}.`,
        `This is an autonomous onboarding call running on OneShot voice infra.`,
        `Be direct and helpful. Not salesy.`,
      ].join(" ");
      const call = await voiceCall(
        {
          objective,
          to: t.phone,
          context,
          maxDurationMinutes: opts.maxDurationMinutes ?? 8,
          callerPersona: `${cfg.founderName}'s onboarding agent`,
        },
        { playName: PLAY_NAME },
      );
      receiptIds.push(call.receiptId);
      voice = call.result;

      const ledger = getLedger();
      const prospectId = ledger.upsertProspect({
        name: t.name,
        email: t.email,
        company: null,
        source: "concierge",
        ...({ phone: t.phone } as Record<string, unknown>),
      });
      ledger.recordSequenceEvent({
        prospectId,
        playName: PLAY_NAME,
        stepIndex: 0,
        channel: "voice",
        status: "sent",
        metadata: {
          summary: voice.summary ?? null,
          ended_reason: voice.ended_reason ?? null,
          duration_seconds: voice.duration_seconds ?? null,
        },
      });
    }

    // 3. Post-call summary email
    let summaryEmail: ConciergeRunResult["outcomes"][number]["summaryEmail"] = null;
    if (!opts.skipSummaryEmail && voice) {
      const draft = await draftWithPrompt({
        promptName: "concierge-summary-email",
        inputBlock: [
          `FOUNDER: ${cfg.founderName}`,
          `PRODUCT: ${cfg.productOneLiner}`,
          `CUSTOMER: ${t.name}`,
          `CALL SUMMARY: ${voice.summary ?? "(no summary returned)"}`,
          `STRUCTURED DATA: ${JSON.stringify(voice.structured_data ?? {})}`,
          `ENDED REASON: ${voice.ended_reason ?? "unknown"}`,
        ].join("\n"),
      });
      const flags = lintEmail(draft.subject, draft.body, 100);
      let sent = false;
      if (!opts.dryRun && flags.length === 0) {
        const send = await sendEmail(
          { to: t.email, subject: draft.subject, body: draft.body },
          { playName: PLAY_NAME },
        );
        receiptIds.push(send.receiptId);
        sent = true;
      }
      summaryEmail = { ...draft, sent, flags };
    }

    outcomes.push({ target: t, prepEmail, voice, summaryEmail, receiptIds });
  }

  return { outcomes };
}

async function draftWithPrompt(opts: { promptName: string; inputBlock: string }): Promise<{
  subject: string;
  body: string;
}> {
  const system = loadPrompt(opts.promptName);
  const res = await complete({
    messages: [
      { role: "system", content: system },
      { role: "user", content: opts.inputBlock },
    ],
    temperature: 0.5,
    maxTokens: 400,
  });
  const fenced = res.content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : res.content;
  let parsed: { subject?: string; body?: string } = {};
  try {
    parsed = JSON.parse((candidate ?? "").trim());
  } catch {
    const start = (candidate ?? "").indexOf("{");
    const end = (candidate ?? "").lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse((candidate ?? "").slice(start, end + 1));
      } catch {
        parsed = {};
      }
    }
  }
  return { subject: (parsed.subject ?? "").trim(), body: (parsed.body ?? "").trim() };
}

export function conciergeReceiptUrls(receiptIds: number[]): string[] {
  return receiptIds.map(receiptUrlForId);
}
