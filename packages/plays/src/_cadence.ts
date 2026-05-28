import {
  getLedger,
  listInbox,
  loadConfig,
  receiptUrlForId,
  sendEmail,
  sendSms,
  voiceCall,
  type ProspectRecord,
} from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import { signatureDirective } from "./_lib.ts";

export interface CadenceContext {
  prospect: ProspectRecord;
  cfg: ReturnType<typeof loadConfig>;
  metadata: Record<string, unknown>;
}

export type StepPayload =
  | { kind: "email"; subject: string; body: string }
  | { kind: "sms"; message: string; toPhone?: string }
  | {
      kind: "voice";
      objective: string;
      toPhone?: string;
      context?: string;
      maxDurationMinutes?: number;
    };

export interface SequenceStep {
  /** Days after enrollment (step 0 was the original send). step 1 is the first follow-up. */
  dayOffset: number;
  channel: "email" | "sms" | "voice";
  /** When true, an inbound reply at any time stops the cadence. */
  breakOnReply: boolean;
  /** Builder returns null to skip this step gracefully. */
  builder: (ctx: CadenceContext) => Promise<StepPayload | null>;
  /** Optional label for logs. */
  label?: string;
}

export interface Sequence {
  playName: string;
  steps: SequenceStep[];
}

const playSequences = new Map<string, Sequence>();

export function registerSequence(seq: Sequence): void {
  playSequences.set(seq.playName, seq);
}

export function getSequence(playName: string): Sequence | undefined {
  return effectiveSequence(playName);
}

/** The registered (code) sequence, ignoring any founder override. For "reset". */
export function defaultSequence(playName: string): Sequence | undefined {
  return playSequences.get(playName);
}

/**
 * The registered (code) sequence with the founder's per-play timing overrides
 * applied. The code sequence defines the structure (which prompts fire, where
 * the breakup sits); a matching-length `cadenceOverrides[playName]` in config
 * replaces each step's RELATIVE dayOffset. A length mismatch (e.g. after a
 * later structural change) is ignored — the code default wins, never throws.
 * Read fresh each call so a /plays edit takes effect without a restart.
 */
export function effectiveSequence(playName: string): Sequence | undefined {
  const base = playSequences.get(playName);
  if (!base) return undefined;
  const override = loadConfig().cadenceOverrides?.[playName];
  if (!Array.isArray(override) || override.length !== base.steps.length) return base;
  return {
    playName: base.playName,
    steps: base.steps.map((step, i) => ({
      dayOffset: override[i] as number,
      channel: step.channel,
      breakOnReply: step.breakOnReply,
      label: step.label,
      builder: step.builder,
    })),
  };
}

export function enrollInCadence(input: { prospectId: number; playName: string }): void {
  const seq = effectiveSequence(input.playName);
  if (!seq || seq.steps.length === 0) return;
  const next = seq.steps[0];
  if (!next) return;
  const dueAt = new Date(Date.now() + next.dayOffset * 24 * 3600 * 1000).toISOString();
  getLedger().enrollCadence({
    prospectId: input.prospectId,
    playName: input.playName,
    nextDueAt: dueAt,
  });
}

export interface AdvanceResult {
  polled: number;
  repliesDetected: number;
  stepsExecuted: number;
  breakups: number;
  completed: number;
  details: Array<{
    prospectEmail: string | null;
    playName: string;
    action: "step-sent" | "marked-replied" | "breakup" | "completed" | "waiting" | "skipped";
    note?: string;
    receiptIds: number[];
  }>;
}

export async function advanceCadence(
  opts: { dryRun: boolean } = { dryRun: false },
): Promise<AdvanceResult> {
  const ledger = getLedger();
  const cfg = loadConfig();
  const result: AdvanceResult = {
    polled: 0,
    repliesDetected: 0,
    stepsExecuted: 0,
    breakups: 0,
    completed: 0,
    details: [],
  };

  // 1. Poll inbox for new replies, mark cadences as replied where we recognize the from-address.
  if (!opts.dryRun) {
    try {
      const inbox = await listInbox({ limit: 50 });
      result.polled = inbox.emails.length;
      for (const e of inbox.emails) {
        const from = normalizeEmail(e.from);
        const prospect = ledger.findProspectByEmail(from);
        if (!prospect) continue;
        const activeForProspect = ledger
          .listAllCadences()
          .filter((c) => c.prospect_id === prospect.id && c.status === "active");
        for (const cad of activeForProspect) {
          ledger.setCadenceStatus({
            prospectId: prospect.id,
            playName: cad.play_name,
            status: "replied",
          });
          result.repliesDetected++;
          result.details.push({
            prospectEmail: from,
            playName: cad.play_name,
            action: "marked-replied",
            note: `inbound: ${e.subject}`,
            receiptIds: [],
          });
        }
      }
    } catch (err) {
      result.details.push({
        prospectEmail: null,
        playName: "(poll)",
        action: "skipped",
        note: `inbox poll failed: ${(err as Error).message}`,
        receiptIds: [],
      });
    }
  }

  // 2. For each active cadence with next_due_at <= now, execute the next step.
  const nowIso = new Date().toISOString();
  const due = ledger.listActiveCadences({ dueByIso: nowIso });

  for (const cad of due) {
    const seq = effectiveSequence(cad.play_name);
    if (!seq) {
      result.details.push({
        prospectEmail: cad.prospect_email,
        playName: cad.play_name,
        action: "skipped",
        note: "no registered sequence",
        receiptIds: [],
      });
      continue;
    }
    const nextIndex = cad.current_step + 1; // current_step starts at 0 (initial send), step 1 is first follow-up
    const stepEntryIndex = nextIndex - 1; // sequence array is 0-indexed for follow-ups
    if (stepEntryIndex < 0 || stepEntryIndex >= seq.steps.length) {
      ledger.setCadenceStatus({
        prospectId: cad.prospect_id,
        playName: cad.play_name,
        status: "completed",
      });
      result.completed++;
      result.details.push({
        prospectEmail: cad.prospect_email,
        playName: cad.play_name,
        action: "completed",
        receiptIds: [],
      });
      continue;
    }
    const step = seq.steps[stepEntryIndex];
    if (!step) continue;

    const prospect = loadProspect(cad.prospect_id);
    if (!prospect) continue;

    const built = await step.builder({
      prospect,
      cfg,
      metadata: {},
    });

    if (!built) {
      // Skip this step; advance to next.
      const next = seq.steps[stepEntryIndex + 1];
      ledger.advanceCadence({
        prospectId: cad.prospect_id,
        playName: cad.play_name,
        newStep: nextIndex,
        nextDueAt: next
          ? new Date(Date.now() + next.dayOffset * 24 * 3600 * 1000).toISOString()
          : null,
      });
      if (!next) {
        ledger.setCadenceStatus({
          prospectId: cad.prospect_id,
          playName: cad.play_name,
          status: "completed",
        });
        result.completed++;
      }
      result.details.push({
        prospectEmail: cad.prospect_email,
        playName: cad.play_name,
        action: "skipped",
        note: step.label ?? `step ${nextIndex} builder returned null`,
        receiptIds: [],
      });
      continue;
    }

    const receiptIds: number[] = [];
    if (!opts.dryRun) {
      const channelOutcome = await dispatchStep({
        playName: cad.play_name,
        prospectId: cad.prospect_id,
        prospectEmail: cad.prospect_email,
        stepIndex: nextIndex,
        step,
        payload: built,
        label: step.label,
      });
      if (channelOutcome.skipReason) {
        result.details.push({
          prospectEmail: cad.prospect_email,
          playName: cad.play_name,
          action: "skipped",
          note: channelOutcome.skipReason,
          receiptIds: [],
        });
        continue;
      }
      receiptIds.push(...channelOutcome.receiptIds);
    }

    const isBreakup =
      stepEntryIndex === seq.steps.length - 1 && step.label?.toLowerCase().includes("breakup");
    if (isBreakup) {
      ledger.setCadenceStatus({
        prospectId: cad.prospect_id,
        playName: cad.play_name,
        status: "breakup",
      });
      result.breakups++;
    } else {
      const next = seq.steps[stepEntryIndex + 1];
      ledger.advanceCadence({
        prospectId: cad.prospect_id,
        playName: cad.play_name,
        newStep: nextIndex,
        nextDueAt: next
          ? new Date(Date.now() + next.dayOffset * 24 * 3600 * 1000).toISOString()
          : null,
      });
      if (!next) {
        ledger.setCadenceStatus({
          prospectId: cad.prospect_id,
          playName: cad.play_name,
          status: "completed",
        });
        result.completed++;
      }
    }

    result.stepsExecuted++;
    result.details.push({
      prospectEmail: cad.prospect_email,
      playName: cad.play_name,
      action: "step-sent",
      note: step.label ?? `step ${nextIndex}`,
      receiptIds,
    });
  }

  return result;
}

async function dispatchStep(input: {
  playName: string;
  prospectId: number;
  prospectEmail: string | null;
  stepIndex: number;
  step: SequenceStep;
  payload: StepPayload;
  label?: string | undefined;
}): Promise<{ receiptIds: number[]; skipReason?: string }> {
  const ledger = getLedger();
  const receiptIds: number[] = [];

  if (input.payload.kind === "email") {
    if (!input.prospectEmail) return { receiptIds, skipReason: "prospect has no email" };
    const send = await sendEmail(
      { to: input.prospectEmail, subject: input.payload.subject, body: input.payload.body },
      { playName: input.playName },
    );
    receiptIds.push(send.receiptId);
    ledger.recordSequenceEvent({
      prospectId: input.prospectId,
      playName: input.playName,
      stepIndex: input.stepIndex,
      channel: "email",
      status: "sent",
      metadata: { subject: input.payload.subject, label: input.label },
    });
    return { receiptIds };
  }

  if (input.payload.kind === "sms") {
    if (!input.payload.toPhone) {
      return { receiptIds, skipReason: "prospect has no phone for SMS" };
    }
    const send = await sendSms(
      { to: input.payload.toPhone, message: input.payload.message },
      { playName: input.playName },
    );
    receiptIds.push(send.receiptId);
    ledger.recordSequenceEvent({
      prospectId: input.prospectId,
      playName: input.playName,
      stepIndex: input.stepIndex,
      channel: "sms",
      status: "sent",
      metadata: { label: input.label },
    });
    return { receiptIds };
  }

  if (input.payload.kind === "voice") {
    if (!input.payload.toPhone) {
      return { receiptIds, skipReason: "prospect has no phone for voice" };
    }
    const call = await voiceCall(
      {
        objective: input.payload.objective,
        to: input.payload.toPhone,
        ...(input.payload.context ? { context: input.payload.context } : {}),
        ...(input.payload.maxDurationMinutes
          ? { maxDurationMinutes: input.payload.maxDurationMinutes }
          : {}),
      },
      { playName: input.playName },
    );
    receiptIds.push(call.receiptId);
    ledger.recordSequenceEvent({
      prospectId: input.prospectId,
      playName: input.playName,
      stepIndex: input.stepIndex,
      channel: "voice",
      status: "sent",
      metadata: { label: input.label, ended_reason: call.result.ended_reason ?? null },
    });
    return { receiptIds };
  }

  return { receiptIds, skipReason: "unknown step payload kind" };
}

function normalizeEmail(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1]! : raw).trim().toLowerCase();
}

function loadProspect(id: number): ProspectRecord | null {
  // Lightweight read; ledger doesn't expose getProspect yet.
  const row = (
    getLedger() as unknown as { db: { query: (s: string) => { get: (id: number) => unknown } } }
  ).db
    .query("SELECT * FROM prospects WHERE id = ?")
    .get(id);
  return (row as ProspectRecord | null) ?? null;
}

export function buildFollowUpEmail(opts: {
  promptName: string;
  contextLines: string[];
}): SequenceStep["builder"] {
  return async (ctx: CadenceContext) => {
    const system = loadPrompt(opts.promptName) + signatureDirective();
    const user = [
      `FOUNDER: ${ctx.cfg.founderName}`,
      `PRODUCT: ${ctx.cfg.productOneLiner}`,
      `PROSPECT: ${ctx.prospect.name ?? "(unknown)"}`,
      `EMAIL: ${ctx.prospect.email ?? ""}`,
      `COMPANY: ${ctx.prospect.company ?? "(unknown)"}`,
      ...opts.contextLines,
    ].join("\n");
    const res = await complete({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.6,
      maxTokens: 500,
    });
    const parsed = tryParseJsonObject<{ subject?: string; body?: string }>(res.content, {});
    if (!parsed.subject || !parsed.body) return null;
    return { kind: "email", subject: parsed.subject.trim(), body: parsed.body.trim() };
  };
}

export function buildSmsStep(opts: {
  promptName: string;
  contextLines: string[];
  toPhone: (ctx: CadenceContext) => string | null;
}): SequenceStep["builder"] {
  return async (ctx: CadenceContext) => {
    const phone = opts.toPhone(ctx);
    if (!phone) return null;
    const system = loadPrompt(opts.promptName);
    const user = [
      `FOUNDER: ${ctx.cfg.founderName}`,
      `PRODUCT: ${ctx.cfg.productOneLiner}`,
      `PROSPECT: ${ctx.prospect.name ?? "(unknown)"}`,
      ...opts.contextLines,
    ].join("\n");
    const res = await complete({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.5,
      maxTokens: 250,
    });
    const parsed = tryParseJsonObject<{ message?: string }>(res.content, {});
    if (!parsed.message) return null;
    return { kind: "sms", message: parsed.message.trim(), toPhone: phone };
  };
}

export function buildVoiceStep(opts: {
  toPhone: (ctx: CadenceContext) => string | null;
  objective: (ctx: CadenceContext) => string;
  context?: (ctx: CadenceContext) => string;
  maxDurationMinutes?: number;
}): SequenceStep["builder"] {
  return async (ctx: CadenceContext) => {
    const phone = opts.toPhone(ctx);
    if (!phone) return null;
    return {
      kind: "voice",
      objective: opts.objective(ctx),
      toPhone: phone,
      ...(opts.context ? { context: opts.context(ctx) } : {}),
      ...(opts.maxDurationMinutes ? { maxDurationMinutes: opts.maxDurationMinutes } : {}),
    };
  };
}

export function receiptUrlsForCadence(receiptIds: number[]): string[] {
  return receiptIds.map(receiptUrlForId);
}
