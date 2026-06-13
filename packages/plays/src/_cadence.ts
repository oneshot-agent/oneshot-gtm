import {
  getLedger,
  hasAnySendCapacity,
  isSendDeferred,
  listInbox,
  loadConfig,
  parallelMap,
  receiptUrlForId,
  sendEmail,
  sendSms,
  trackSend,
  voiceCall,
  type ProspectRecord,
} from "@oneshot-gtm/core";
import { complete, loadPrompt, tryParseJsonObject } from "@oneshot-gtm/intel";
import {
  firstNameFrom,
  humanizeDraft,
  lintEmail,
  signatureDirective,
  socialProofBlock,
} from "./_lib.ts";

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

interface SequenceStep {
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

/**
 * "Does this label name a breakup step?" — single source of truth for the
 * label-substring check. Used by isBreakupStepAt for the cadence-final
 * semantic check AND by /plays for per-step rendering where each row is
 * already a step.
 */
export function isBreakupLabel(label: string | null | undefined): boolean {
  return Boolean(label && label.toLowerCase().includes("breakup"));
}

/**
 * Centralized breakup-step detection for cadence-progress semantics. A
 * step is "the breakup" iff (a) it sits at the END of the sequence and
 * (b) its label is a breakup label. Both clauses matter: the
 * breakup-email PROMPT is also used as accelerator-batch's only
 * follow-up — at index 0 — and that one isn't semantically a breakup
 * for cadence UX purposes (no value follow-up preceded it).
 */
export function isBreakupStepAt(seq: Sequence, stepEntryIndex: number): boolean {
  if (stepEntryIndex !== seq.steps.length - 1) return false;
  return isBreakupLabel(seq.steps[stepEntryIndex]?.label);
}

export interface NextStepInfo {
  /** Label of the next step (e.g. "value follow-up", "breakup"). */
  label: string | null;
  /** True when the next step is the final breakup. */
  isBreakup: boolean;
  /** 1-based index of the next step within the follow-up steps array. */
  nextStepNumber: number;
}

/**
 * Number of follow-up steps registered for this play (excludes day-0).
 * Always returns the registered total regardless of current_step — the UI
 * uses `playFollowupCount + 1` for the StepProgress dot count which should
 * be stable for completed cadences too.
 */
export function playFollowupCount(playName: string): number {
  return effectiveSequence(playName)?.steps.length ?? 0;
}

/**
 * Given a play + the cadence's current_step, describe the NEXT step
 * scheduled to fire. Returns null when the cadence is at or past the
 * last step (no more steps to send). Source of truth for both the
 * server's CadenceView and the /cadences UI — avoids hardcoded
 * play→step-count Records in the web layer.
 */
export function nextStepInfo(playName: string, currentStep: number): NextStepInfo | null {
  const seq = effectiveSequence(playName);
  if (!seq) return null;
  const nextIndex = currentStep + 1;
  const stepEntryIndex = nextIndex - 1;
  if (stepEntryIndex < 0 || stepEntryIndex >= seq.steps.length) return null;
  const step = seq.steps[stepEntryIndex];
  return {
    label: step?.label ?? null,
    isBreakup: isBreakupStepAt(seq, stepEntryIndex),
    nextStepNumber: nextIndex,
  };
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

export interface ReplyPollResult {
  /** Inbox emails examined. */
  polled: number;
  /** Active cadences flipped to `replied` this poll. */
  repliesDetected: number;
  details: Array<{ prospectEmail: string; playName: string; subject: string }>;
}

/**
 * Poll the inbox and mark any active cadence `replied` when an inbound email's
 * from-address matches its prospect. Read-only except for the status flip — it
 * never drafts or sends, so it's safe to run on a background timer (the server
 * scheduler) as well as inside `advanceCadence`. Without a background caller,
 * replies are only noticed when the founder manually advances/sends a cadence,
 * so a reply can sit unrecognized for days and the sequence keeps emailing.
 */
export async function pollInboxReplies(): Promise<ReplyPollResult> {
  const ledger = getLedger();
  const out: ReplyPollResult = { polled: 0, repliesDetected: 0, details: [] };
  const inbox = await listInbox({ limit: 50 });
  out.polled = inbox.emails.length;
  for (const e of inbox.emails) {
    const from = normalizeEmail(e.from);
    const prospect = ledger.findProspectByEmail(from);
    if (!prospect) continue;
    // Index seek per matched sender, not a full-table scan per inbox email.
    // recordCadenceReply atomically flips control state + records the analytics
    // event; it decides per-status (active flips & counts, already-replied just
    // backfills the event idempotently, terminal states are left alone).
    for (const cad of ledger.listCadencesForProspect(prospect.id)) {
      const { newlyReplied } = ledger.recordCadenceReply({
        prospectId: prospect.id,
        playName: cad.play_name,
      });
      if (newlyReplied) {
        out.repliesDetected++;
        out.details.push({ prospectEmail: from, playName: cad.play_name, subject: e.subject });
      }
    }
  }
  return out;
}

export async function advanceCadence(
  opts: { dryRun: boolean } = { dryRun: false },
): Promise<AdvanceResult> {
  const ledger = getLedger();
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
      const poll = await pollInboxReplies();
      result.polled = poll.polled;
      result.repliesDetected = poll.repliesDetected;
      for (const d of poll.details) {
        result.details.push({
          prospectEmail: d.prospectEmail,
          playName: d.playName,
          action: "marked-replied",
          note: `inbound: ${d.subject}`,
          receiptIds: [],
        });
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
  // Parallelized (concurrency 3): each step is an LLM draft + send (~5-90s), and
  // `due` rows are distinct (prospect, play) pairs, so there's no shared-write
  // contention. Results are collected in input order before counting.
  const nowIso = new Date().toISOString();
  const due = ledger.listActiveCadences({ dueByIso: nowIso });

  // Capacity gate BEFORE drafting: when every sender identity is at its daily
  // cap, a step would burn an LLM draft and then fail the send anyway. Steps
  // stay due; tomorrow's poll picks them up with fresh capacity.
  if (!opts.dryRun && due.length > 0 && !hasAnySendCapacity()) {
    for (const cad of due) {
      result.details.push({
        prospectEmail: cad.prospect_email,
        playName: cad.play_name,
        action: "skipped",
        note: "deferred: daily send caps reached",
        receiptIds: [],
      });
    }
    return result;
  }

  const outs = await parallelMap(due, 3, async (cad): Promise<RunCadenceStepResult> => {
    try {
      return await runCadenceStepForProspect({
        prospectId: cad.prospect_id,
        playName: cad.play_name,
        dryRun: opts.dryRun,
      });
    } catch (err) {
      // Deferral mid-pass (caps filled while this batch ran): the step simply
      // stays due. Anything else propagates — parallelMap rejects the whole
      // pass, matching pre-rotation behavior for unexpected errors.
      if (isSendDeferred(err)) {
        return {
          action: "skipped",
          payload: null,
          receiptIds: [],
          note: "deferred: daily send caps reached",
        };
      }
      throw err;
    }
  });

  for (let i = 0; i < due.length; i++) {
    const cad = due[i]!;
    const out = outs[i]!;
    result.details.push({
      prospectEmail: cad.prospect_email,
      playName: cad.play_name,
      action: out.action,
      ...(out.note ? { note: out.note } : {}),
      receiptIds: out.receiptIds,
    });
    if (out.action === "step-sent") result.stepsExecuted++;
    else if (out.action === "breakup") result.breakups++;
    else if (out.action === "completed") result.completed++;
  }

  return result;
}

export interface RunCadenceStepOptions {
  prospectId: number;
  playName: string;
  dryRun: boolean;
  /** Skip the step's builder and send this verbatim (mirrors /queue's
      send-this-one — used by the /cadences UI after a Preview round-trip). */
  persistedPayload?: StepPayload;
}

export interface RunCadenceStepResult {
  action: AdvanceResult["details"][number]["action"];
  payload: StepPayload | null;
  receiptIds: number[];
  note?: string;
}

/**
 * Per-prospect cadence step runner. Single source of truth for both the
 * batch `advanceCadence` (CLI) and the per-row /cadences UI (preview + send).
 * Caller decides dryRun (no send) or persistedPayload (send a previously
 * built draft verbatim). On a successful send, advances `current_step`
 * to `nextIndex` and sets `next_due_at` to the next step's offset; clears
 * any persisted preview draft via ledger.advanceCadence.
 */
export async function runCadenceStepForProspect(
  opts: RunCadenceStepOptions,
): Promise<RunCadenceStepResult> {
  const ledger = getLedger();
  const cfg = loadConfig();
  const cadence = ledger.getCadence(opts.prospectId, opts.playName);
  if (!cadence) {
    return { action: "skipped", payload: null, receiptIds: [], note: "no cadence" };
  }
  if (cadence.status !== "active") {
    return {
      action: "skipped",
      payload: null,
      receiptIds: [],
      note: `cadence is ${cadence.status}`,
    };
  }
  const seq = effectiveSequence(opts.playName);
  if (!seq) {
    return { action: "skipped", payload: null, receiptIds: [], note: "no registered sequence" };
  }
  const nextIndex = cadence.current_step + 1;
  const stepEntryIndex = nextIndex - 1;
  if (stepEntryIndex < 0 || stepEntryIndex >= seq.steps.length) {
    ledger.setCadenceStatus({
      prospectId: opts.prospectId,
      playName: opts.playName,
      status: "completed",
    });
    return { action: "completed", payload: null, receiptIds: [] };
  }
  const step = seq.steps[stepEntryIndex];
  if (!step) return { action: "skipped", payload: null, receiptIds: [] };

  const prospect = loadProspect(opts.prospectId);
  if (!prospect) {
    return { action: "skipped", payload: null, receiptIds: [], note: "prospect not found" };
  }

  const built: StepPayload | null = opts.persistedPayload
    ? opts.persistedPayload
    : await step.builder({ prospect, cfg, metadata: {} });

  if (!built) {
    const next = seq.steps[stepEntryIndex + 1];
    ledger.advanceCadence({
      prospectId: opts.prospectId,
      playName: opts.playName,
      newStep: nextIndex,
      nextDueAt: next
        ? new Date(Date.now() + next.dayOffset * 24 * 3600 * 1000).toISOString()
        : null,
    });
    if (!next) {
      ledger.setCadenceStatus({
        prospectId: opts.prospectId,
        playName: opts.playName,
        status: "completed",
      });
      return {
        action: "completed",
        payload: null,
        receiptIds: [],
        note: step.label ?? `step ${nextIndex} builder returned null`,
      };
    }
    return {
      action: "skipped",
      payload: null,
      receiptIds: [],
      note: step.label ?? `step ${nextIndex} builder returned null`,
    };
  }

  const receiptIds: number[] = [];
  if (!opts.dryRun) {
    const channelOutcome = await dispatchStep({
      playName: opts.playName,
      prospectId: opts.prospectId,
      prospectEmail: cadence.prospect_email,
      stepIndex: nextIndex,
      step,
      payload: built,
      ...(step.label !== undefined ? { label: step.label } : {}),
    });
    if (channelOutcome.skipReason) {
      return {
        action: "skipped",
        payload: built,
        receiptIds: [],
        note: channelOutcome.skipReason,
      };
    }
    receiptIds.push(...channelOutcome.receiptIds);
  }

  if (isBreakupStepAt(seq, stepEntryIndex)) {
    ledger.setCadenceStatus({
      prospectId: opts.prospectId,
      playName: opts.playName,
      status: "breakup",
    });
    return {
      action: "breakup",
      payload: built,
      receiptIds,
      note: step.label ?? `step ${nextIndex}`,
    };
  }
  const next = seq.steps[stepEntryIndex + 1];
  ledger.advanceCadence({
    prospectId: opts.prospectId,
    playName: opts.playName,
    newStep: nextIndex,
    nextDueAt: next ? new Date(Date.now() + next.dayOffset * 24 * 3600 * 1000).toISOString() : null,
  });
  if (!next) {
    ledger.setCadenceStatus({
      prospectId: opts.prospectId,
      playName: opts.playName,
      status: "completed",
    });
  }
  return {
    action: "step-sent",
    payload: built,
    receiptIds,
    note: step.label ?? `step ${nextIndex}`,
  };
}

export interface CadenceStepPreview {
  subject: string;
  body: string;
  flags: string[];
  payload: StepPayload;
  draftedAt: string;
  stepLabel: string | null;
  isBreakup: boolean;
}

/**
 * Build the next step's draft and persist it via setCadenceDraft. Never
 * sends. Mirrors the /queue regenerate route — the founder reviews on
 * /cadences, then clicks Send next which calls sendCadenceStep.
 */
export async function previewCadenceStep(input: {
  prospectId: number;
  playName: string;
}): Promise<CadenceStepPreview> {
  const ledger = getLedger();
  const cfg = loadConfig();
  const cadence = ledger.getCadence(input.prospectId, input.playName);
  if (!cadence) throw new Error("no cadence for that prospect+play");
  if (cadence.status !== "active") {
    throw new Error(`cadence is ${cadence.status}, can only preview an active cadence`);
  }
  const seq = effectiveSequence(input.playName);
  if (!seq) throw new Error(`no registered sequence for play '${input.playName}'`);
  const nextIndex = cadence.current_step + 1;
  const stepEntryIndex = nextIndex - 1;
  if (stepEntryIndex < 0 || stepEntryIndex >= seq.steps.length) {
    throw new Error("no next step (cadence is at or past the last step)");
  }
  const step = seq.steps[stepEntryIndex];
  if (!step) throw new Error("step undefined");
  const prospect = loadProspect(input.prospectId);
  if (!prospect) throw new Error("prospect not found");
  const built = await step.builder({ prospect, cfg, metadata: {} });
  if (!built) throw new Error("builder returned null — nothing to preview");

  const subject = built.kind === "email" ? built.subject : "(non-email step)";
  const body =
    built.kind === "email"
      ? built.body
      : built.kind === "sms"
        ? built.message
        : built.kind === "voice"
          ? built.objective
          : "";
  const flags = built.kind === "email" ? lintEmail(subject, body, 100) : [];
  ledger.setCadenceDraft({
    prospectId: input.prospectId,
    playName: input.playName,
    draft: { subject, body, flags, payload: built },
  });
  const draft = ledger.getCadenceDraft({
    prospectId: input.prospectId,
    playName: input.playName,
  });
  const draftedAt = draft?.draftedAt ?? new Date().toISOString();
  return {
    subject,
    body,
    flags,
    payload: built,
    draftedAt,
    stepLabel: step.label ?? null,
    isBreakup: isBreakupStepAt(seq, stepEntryIndex),
  };
}

/**
 * Send a previously-previewed cadence step verbatim. Reads the persisted
 * draft (or 409s if none), dispatches it through runCadenceStepForProspect,
 * and advances the cadence. The advance clears the persisted draft so a
 * subsequent Preview rebuilds against the new current_step.
 */
export async function sendCadenceStep(input: {
  prospectId: number;
  playName: string;
}): Promise<RunCadenceStepResult> {
  const ledger = getLedger();
  const draft = ledger.getCadenceDraft(input);
  if (!draft) throw new Error("no persisted preview — click Preview first");
  return runCadenceStepForProspect({
    prospectId: input.prospectId,
    playName: input.playName,
    dryRun: false,
    persistedPayload: draft.payload as StepPayload,
  });
}

export interface BatchItem {
  prospectId: number;
  playName: string;
}

interface BatchPreviewResult {
  prospectId: number;
  playName: string;
  ok: boolean;
  preview?: CadenceStepPreview;
  error?: string;
}

export interface BatchSendResult {
  prospectId: number;
  playName: string;
  ok: boolean;
  action?: RunCadenceStepResult["action"];
  receiptIds?: number[];
  error?: string;
}

/**
 * Parallel preview of a list of cadence rows (concurrency 3). Each
 * per-prospect failure is captured in the result array — the batch never
 * throws. `parallelMap` preserves input order so the returned array matches
 * `items` 1:1. Concurrency mirrors `runEmailPlay` + `advanceCadence`; the
 * founder is waiting at the UI, so 3× speedup on a 10-row preview drops
 * wall-clock from ~100s to ~35s.
 */
export async function previewCadenceStepBatch(items: BatchItem[]): Promise<BatchPreviewResult[]> {
  return parallelMap(items, 3, async (item) => {
    try {
      const preview = await previewCadenceStep(item);
      return { prospectId: item.prospectId, playName: item.playName, ok: true, preview };
    } catch (err) {
      return {
        prospectId: item.prospectId,
        playName: item.playName,
        ok: false,
        error: ((err as Error)?.message ?? "preview failed").slice(0, 120),
      };
    }
  });
}

/**
 * Serial send of a list of previewed cadence rows. Each per-prospect failure
 * is captured; the batch never throws. Used by `POST /api/cadences/send-batch`
 * as a background promise — caller returns 202 immediately and the UI sees
 * progress via subsequent `/api/cadences` refetches (the existing
 * `advanceCadence` clears `next_step_draft_json` as each row completes).
 *
 * Sends stay serial (unlike previewCadenceStepBatch) for two reasons: the
 * `onItemSettled` callback drives the in-flight UI badge per row (parallel
 * would batch-flash all rows at once), and parallel SMTP to the same
 * domain risks soft-bounces.
 */
export async function sendCadenceStepBatch(
  items: BatchItem[],
  /** Fires after each item resolves (ok OR error) — lets the API layer
   *  track per-row in-flight state without splitting the iteration. */
  onItemSettled?: (item: BatchItem, result: BatchSendResult) => void,
): Promise<BatchSendResult[]> {
  const out: BatchSendResult[] = [];
  for (const item of items) {
    let result: BatchSendResult;
    try {
      const r = await sendCadenceStep(item);
      result = {
        prospectId: item.prospectId,
        playName: item.playName,
        ok: true,
        action: r.action,
        receiptIds: r.receiptIds,
      };
    } catch (err) {
      result = {
        prospectId: item.prospectId,
        playName: item.playName,
        ok: false,
        error: ((err as Error)?.message ?? "send failed").slice(0, 120),
      };
    }
    out.push(result);
    onItemSettled?.(item, result);
  }
  return out;
}

function dispatchStep(
  input: Parameters<typeof dispatchStepImpl>[0],
): ReturnType<typeof dispatchStepImpl> {
  // Count the whole dispatch as one in-flight send so a graceful shutdown
  // drains it (SDK call + its sequence_events write) before the process exits.
  return trackSend(() => dispatchStepImpl(input));
}

async function dispatchStepImpl(input: {
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

  // Per-step audit envelope: same shape across all channels so receipts can
  // be grouped/filtered by (prospectId, stepIndex, label) on the OneShot side.
  const cadenceAudit = {
    source: "cadence" as const,
    prospectId: input.prospectId,
    prospectEmail: input.prospectEmail,
    stepIndex: input.stepIndex,
    label: input.label ?? null,
  };
  const labelTail = input.label ? ` ${input.label}` : "";

  if (input.payload.kind === "email") {
    if (!input.prospectEmail) return { receiptIds, skipReason: "prospect has no email" };
    const send = await sendEmail(
      { to: input.prospectEmail, subject: input.payload.subject, body: input.payload.body },
      {
        playName: input.playName,
        memo: `${input.playName} step ${input.stepIndex}${labelTail} → ${input.prospectEmail}`,
        decisionContext: { ...cadenceAudit, subject: input.payload.subject },
      },
    );
    receiptIds.push(send.receiptId);
    ledger.recordSequenceEvent({
      prospectId: input.prospectId,
      playName: input.playName,
      stepIndex: input.stepIndex,
      channel: "email",
      status: "sent",
      metadata: {
        subject: input.payload.subject,
        body: input.payload.body,
        label: input.label,
      },
    });
    return { receiptIds };
  }

  if (input.payload.kind === "sms") {
    if (!input.payload.toPhone) {
      return { receiptIds, skipReason: "prospect has no phone for SMS" };
    }
    const send = await sendSms(
      { to: input.payload.toPhone, message: input.payload.message },
      {
        playName: input.playName,
        memo: `${input.playName} step ${input.stepIndex}${labelTail} SMS → ${input.payload.toPhone}`,
        decisionContext: { ...cadenceAudit, toPhone: input.payload.toPhone },
      },
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
      {
        playName: input.playName,
        memo: `${input.playName} step ${input.stepIndex}${labelTail} voice → ${input.payload.toPhone}`,
        decisionContext: {
          ...cadenceAudit,
          toPhone: input.payload.toPhone,
          objective: input.payload.objective.slice(0, 120),
        },
      },
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
  return getLedger().getProspectById(id);
}

export function buildFollowUpEmail(opts: {
  playName: string;
  promptName: string;
  contextLines: string[];
}): SequenceStep["builder"] {
  return async (ctx: CadenceContext) => {
    const system = loadPrompt(opts.promptName) + signatureDirective();
    const priorBlock = buildPriorEmailsBlock(ctx.prospect.id, opts.playName);
    const proofBlock = socialProofBlock();
    // Optional first-name field: prompt rule lets the LLM occasionally open
    // with "Hey {firstName},". Absent when name is null / (unknown) / handle.
    const firstName = firstNameFrom(ctx.prospect.name);
    const user = [
      `FOUNDER: ${ctx.cfg.founderName}`,
      `PRODUCT: ${ctx.cfg.productOneLiner}`,
      `PROSPECT: ${ctx.prospect.name ?? "(unknown)"}`,
      `EMAIL: ${ctx.prospect.email ?? ""}`,
      `COMPANY: ${ctx.prospect.company ?? "(unknown)"}`,
      ...opts.contextLines,
      ...(priorBlock ? ["", priorBlock] : []),
      ...(proofBlock ? ["", proofBlock] : []),
      ...(firstName ? ["", `PROSPECT_FIRST_NAME: ${firstName}`] : []),
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
    // Apply the deterministic autofixer (em-dash → ", ", curly quotes → ASCII,
    // emoji strip, etc.) — same humanization the initial-send plays get via
    // draftEmailFromPrompt. Without this, cadence follow-ups ship em-dashes
    // raw even though lintEmail flags them.
    const cleaned = humanizeDraft({
      subject: parsed.subject.trim(),
      body: parsed.body.trim(),
    });
    return { kind: "email", subject: cleaned.subject, body: cleaned.body };
  };
}

export interface PriorStepRow {
  stepIndex: number;
  /** "initial send" for step 0; the registered step label for 1+; "follow-up" if missing. */
  label: string;
  subject: string;
  /** Null for legacy pre-v8 rows whose metadata_json didn't include the body. */
  body: string | null;
  /** sequence_events.created_at (UTC ISO). */
  sentAt: string;
  status: "sent" | "delivered" | "replied";
}

/**
 * Parse a prospect's prior sends for a given play into clean per-step rows.
 * Source of truth shared by the LLM PRIOR-EMAILS injection (which filters
 * legacy rows) and the /api/cadences view (which surfaces them with a
 * "body not captured" placeholder).
 */
export function getPriorStepsForProspect(prospectId: number, playName: string): PriorStepRow[] {
  if (!prospectId) return [];
  let rows: Array<{
    step_index: number;
    metadata_json: string | null;
    status: string;
    created_at: string;
  }>;
  try {
    rows = getLedger().listSequenceEventsForProspectPlay(prospectId, playName) as Array<{
      step_index: number;
      metadata_json: string | null;
      status: string;
      created_at: string;
    }>;
  } catch {
    return [];
  }
  return rows.map(rowToPriorStep);
}

function rowToPriorStep(r: {
  step_index: number;
  metadata_json: string | null;
  status: string;
  created_at: string;
}): PriorStepRow {
  const meta = tryParseJsonObject<{ subject?: string; body?: string; label?: string }>(
    r.metadata_json ?? "",
    {},
  );
  return {
    stepIndex: r.step_index,
    label: meta.label ?? (r.step_index === 0 ? "initial send" : "follow-up"),
    subject: meta.subject ?? "(no subject)",
    body: meta.body ?? null,
    sentAt: r.created_at,
    status: (r.status as PriorStepRow["status"]) ?? "sent",
  };
}

/**
 * Bulk variant of getPriorStepsForProspect: one SQL round-trip for many
 * (prospect_id, play_name) pairs. Returns a Map keyed by
 * `${prospectId}|${playName}` so /api/cadences's toView can index in O(1)
 * instead of issuing one query per row. Pairs the founder hasn't sent for
 * are absent from the map (callers should default to []).
 */
export function getPriorStepsBulk(
  pairs: ReadonlyArray<{ prospectId: number; playName: string }>,
): Map<string, PriorStepRow[]> {
  if (pairs.length === 0) return new Map();
  let bulk: Map<
    string,
    Array<{
      step_index: number;
      metadata_json: string | null;
      status: string;
      created_at: string;
    }>
  >;
  try {
    bulk = getLedger().listSequenceEventsForCadences(pairs) as Map<
      string,
      Array<{
        step_index: number;
        metadata_json: string | null;
        status: string;
        created_at: string;
      }>
    >;
  } catch {
    return new Map();
  }
  const out = new Map<string, PriorStepRow[]>();
  for (const [key, rows] of bulk) {
    out.set(key, rows.map(rowToPriorStep));
  }
  return out;
}

function buildPriorEmailsBlock(prospectId: number, playName: string): string | null {
  const prior = getPriorStepsForProspect(prospectId, playName).filter(
    (r): r is PriorStepRow & { body: string } => r.body !== null && r.body.length > 0,
  );
  if (prior.length === 0) return null;
  const lines = [
    "PRIOR EMAILS (your previous touches to this prospect on this play; do not repeat their angles, hooks, openers, or closes):",
  ];
  for (const row of prior) {
    lines.push(`--- step ${row.stepIndex} (${row.label}) ---`);
    lines.push(`Subject: ${row.subject}`);
    lines.push(row.body);
  }
  return lines.join("\n");
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
