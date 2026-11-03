import {
  currentWorkspaceName,
  getLedger,
  isLinkedInSendPending,
  linkedInFailure,
  linkedInMessageConversationId,
  logEvent,
  parseLinkedInRecovery,
  type LinkedInPendingSend,
} from "@oneshot-gtm/core";
import { LINKEDIN_SEND_PENDING } from "@oneshot-gtm/shared-types";
import {
  recordLinkedInMessageSent,
  settleCadenceAfterLinkedInSend,
  skipCadenceLinkedInSteps,
  type LinkedInCaller,
} from "./_cadence.ts";
import {
  NOT_PENDING_FLAG,
  sendLinkedInInvite,
  type LinkedInFirstTouchRow,
  type SendLinkedInInviteInput,
} from "./_linkedin-first-touch.ts";

/**
 * Pending LinkedIn sends (ledger-linkedin-pending.ts), resolved from
 * OneShot's own records. Only ever records: the recover read and `wait` on
 * the job the send started. A message or invite is never sent from here.
 */

export type LinkedInPendingResolution = "sent" | "failed" | "refused" | "pending";

export interface LinkedInPendingSweepResult {
  /** Pending sends when the sweep began. */
  checked: number;
  sent: number;
  failed: number;
  /** Invites LinkedIn refused (nothing went out): the profile was freed. */
  refused: number;
  /** Still running, or unknown to OneShot: asked again on the next sweep. */
  pending: number;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/**
 * A failure as the send error shows it: `(code: upstream_reason)`, then
 * OneShot's sentence. The code, never a sentence read as one.
 */
function failureText(err: unknown): string {
  const { code, reason, upstream } = linkedInFailure(err);
  const message = (err as { message?: unknown } | null)?.message;
  const tag = code ?? (typeof message === "string" && message ? message : "failed");
  const tagged = upstream && upstream !== tag ? `${tag}: ${upstream}` : tag;
  return `(${tagged})${reason && !tagged.includes(reason) ? `: ${reason}` : ""}`;
}

/** Resolve every pending send. Per-send failures are logged and left pending. */
export async function sweepLinkedInPendingSends(input: {
  linkedIn: LinkedInCaller;
}): Promise<LinkedInPendingSweepResult> {
  const pending = getLedger().linkedInPending.list();
  const out: LinkedInPendingSweepResult = {
    checked: pending.length,
    sent: 0,
    failed: 0,
    refused: 0,
    pending: 0,
  };
  for (const p of pending) {
    let resolution: LinkedInPendingResolution;
    try {
      resolution = await resolveLinkedInPendingSend(p, input.linkedIn);
    } catch (err) {
      logEvent(
        "linkedin.pending_send.resolve_failed",
        { kind: p.kind, message_120: ((err as Error).message ?? "").slice(0, 120) },
        "warn",
      );
      resolution = "pending";
    }
    out[resolution]++;
  }
  if (out.checked > 0) logEvent("linkedin.pending_send_sweep", { ...out });
  return out;
}

/**
 * One pending send. Asks OneShot's recover endpoint (by idempotency key)
 * whether the job finished; a finished one is read with `wait` and recorded
 * the way the send would have recorded it. Unknown to OneShot, or still
 * running: left pending. A reply's job is read with `wait` straight away:
 * its request id is the one the reply answered with.
 */
export async function resolveLinkedInPendingSend(
  p: LinkedInPendingSend,
  linkedIn: LinkedInCaller,
): Promise<LinkedInPendingResolution> {
  const ledger = getLedger();
  const call = (operation: Parameters<LinkedInCaller>[1]) =>
    linkedIn(p.accountWorkspace, operation);
  if (p.kind === "reply") {
    ledger.linkedInPending.markChecked(p.idempotencyKey);
    return resolveMessage(p, call);
  }
  let recovery: ReturnType<typeof parseLinkedInRecovery>;
  try {
    recovery = parseLinkedInRecovery(
      await call({
        kind: "recover",
        endpoint: p.kind === "invite" ? "linkedin/invite" : "linkedin/message",
        idempotencyKey: p.idempotencyKey,
      }),
    );
  } finally {
    ledger.linkedInPending.markChecked(p.idempotencyKey);
  }
  if (recovery.state !== "completed" && recovery.state !== "failed") return "pending";
  const requestId = recovery.requestId ?? p.requestId;
  if (requestId !== p.requestId) ledger.linkedInPending.record({ ...p, requestId });
  return p.kind === "invite"
    ? resolveInvite({ ...p, requestId }, call)
    : resolveMessage({ ...p, requestId }, call);
}

async function resolveMessage(
  p: LinkedInPendingSend,
  call: (operation: Parameters<LinkedInCaller>[1]) => Promise<unknown>,
): Promise<LinkedInPendingResolution> {
  const ledger = getLedger();
  const cadence =
    p.prospectId != null && p.stepIndex != null
      ? { prospectId: p.prospectId, playName: p.playName, stepIndex: p.stepIndex }
      : null;
  let result: unknown;
  try {
    result = await call({ kind: "wait", requestId: p.requestId });
  } catch (err) {
    // Only a failed job is an outcome; anything else is asked again later.
    if ((err as { name?: unknown }).name !== "JobError") return "pending";
    ledger.linkedInPending.clear(p.idempotencyKey);
    // Send again (by hand) goes under a new key.
    ledger.linkedInSendAttempts.noteFailed(p.idempotencyKey, err);
    if (cadence) {
      ledger.recordCadenceSendError({
        prospectId: cadence.prospectId,
        playName: cadence.playName,
        error: `LinkedIn ${p.kind} not sent ${failureText(err)}`,
      });
    }
    return "failed";
  }
  if (cadence) {
    if (!ledger.hasSentSequenceEvent(cadence.prospectId, cadence.playName, cadence.stepIndex)) {
      // A reply went into a conversation the cadence already has.
      const conversationId = p.kind === "message" ? linkedInMessageConversationId(result) : null;
      recordLinkedInMessageSent({
        ...cadence,
        text: str(p.detail["text"]) ?? "",
        label: str(p.detail["label"]),
        opened: conversationId
          ? { conversationId, accountId: p.accountId, workspace: p.accountWorkspace }
          : null,
      });
    }
    ledger.linkedInPending.clear(p.idempotencyKey);
    settleCadenceAfterLinkedInSend({ ...cadence, kind: "message" });
    ledger.clearCadenceSendError({
      prospectId: cadence.prospectId,
      playName: cadence.playName,
      onlyIf: LINKEDIN_SEND_PENDING,
    });
  } else {
    ledger.linkedInPending.clear(p.idempotencyKey);
  }
  logEvent("linkedin.pending_send.resolved", { kind: p.kind, outcome: "sent" });
  return "sent";
}

function inviteRowOf(value: unknown): LinkedInFirstTouchRow | null {
  const r = value as Partial<LinkedInFirstTouchRow> | null;
  if (!r || typeof r !== "object" || typeof r.playName !== "string") return null;
  if (!r.payload || typeof r.payload !== "object") return null;
  return {
    id: typeof r.id === "number" ? r.id : 0,
    playName: r.playName,
    payload: r.payload,
    notes: typeof r.notes === "string" ? r.notes : null,
  };
}

/**
 * A pending invite. It goes back through `sendLinkedInInvite` with
 * `resumeOnly`, which checks the stored job and never invites, so the claim,
 * the invite record and a refusal are settled exactly as on the send.
 */
async function resolveInvite(
  p: LinkedInPendingSend,
  call: (operation: Parameters<LinkedInCaller>[1]) => Promise<unknown>,
): Promise<LinkedInPendingResolution> {
  const ledger = getLedger();
  const row = inviteRowOf(p.detail["row"]);
  const note = str(p.detail["note"]);
  if (!row || !note) return "pending";
  const c = p.detail["continuation"] as { prospectId?: unknown; stepIndex?: unknown } | undefined;
  const continuation =
    c && typeof c.prospectId === "number" && typeof c.stepIndex === "number"
      ? { prospectId: c.prospectId, stepIndex: c.stepIndex }
      : undefined;
  const friend = p.detail["friend"] === true;
  const input: SendLinkedInInviteInput = {
    row,
    note,
    sender: { accountId: p.accountId, workspace: p.accountWorkspace, call },
    workspace: currentWorkspaceName(),
    ...(continuation ? { continuation } : {}),
    ...(friend ? { friend: true } : {}),
    ...(typeof p.detail["evidenceClause"] === "boolean"
      ? { evidenceClause: p.detail["evidenceClause"] }
      : {}),
  };
  const cadence = continuation && !friend ? continuation : null;
  let out: Awaited<ReturnType<typeof sendLinkedInInvite>>;
  try {
    out = await sendLinkedInInvite({ ...input, resumeOnly: true });
  } catch (err) {
    if (isLinkedInSendPending(err)) return "pending";
    if (cadence) {
      ledger.recordCadenceSendError({
        prospectId: cadence.prospectId,
        playName: row.playName,
        error: `LinkedIn invite not sent ${failureText(err)}`,
      });
    }
    return "failed";
  }
  if (out.sent) {
    if (cadence) {
      settleCadenceAfterLinkedInSend({
        prospectId: cadence.prospectId,
        playName: row.playName,
        stepIndex: cadence.stepIndex,
        kind: "invite",
      });
      ledger.clearCadenceSendError({
        prospectId: cadence.prospectId,
        playName: row.playName,
        onlyIf: LINKEDIN_SEND_PENDING,
      });
    } else if (!continuation && row.id > 0) {
      ledger.setQueueProspectId(row.id, out.prospectId);
      ledger.setQueueStatus({ id: row.id, status: "sent", decidedBy: "human" });
      try {
        ledger.closeQueueDraftVersion(row.id, "sent");
      } catch {
        // older ledgers without draft versions
      }
    }
    logEvent("linkedin.pending_send.resolved", { kind: "invite", outcome: "sent" });
    return "sent";
  }
  if (out.guard === "linkedin-invite-refused") {
    const flag = out.flags[0] ?? "linkedin-invite-refused";
    if (cadence) {
      skipCadenceLinkedInSteps({
        prospectId: cadence.prospectId,
        playName: row.playName,
        reason: flag,
      });
    } else if (!continuation && row.id > 0) {
      holdQueueRow(row.id, out.flags);
    }
    logEvent("linkedin.pending_send.resolved", { kind: "invite", outcome: "refused" });
    return "refused";
  }
  if (out.flags.includes(NOT_PENDING_FLAG)) return "pending";
  if (cadence) {
    ledger.recordCadenceSendError({
      prospectId: cadence.prospectId,
      playName: row.playName,
      error: `LinkedIn invite not sent (${out.flags.join(", ")})`,
    });
  }
  return "failed";
}

/**
 * A queue row whose invite LinkedIn refused: back to pending with the reason
 * on its draft, as when the guard refuses a send.
 */
export function holdQueueRow(id: number, flags: string[]): void {
  const ledger = getLedger();
  const row = ledger.getQueueRow(id);
  if (!row || row.status === "sent") return;
  let draft: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.last_draft_json ?? "{}");
    if (parsed && typeof parsed === "object") draft = parsed as Record<string, unknown>;
  } catch {
    // no stored draft: the flag still lands
  }
  ledger.setQueueDraft({
    id,
    draft: {
      ...draft,
      subject: typeof draft["subject"] === "string" ? draft["subject"] : "LinkedIn invite",
      body: typeof draft["body"] === "string" ? draft["body"] : "",
      flags,
      sent: false,
      receiptIds: Array.isArray(draft["receiptIds"]) ? (draft["receiptIds"] as number[]) : [],
      dryRun: false,
    },
    sentBy: "human",
  });
  ledger.setQueueStatus({ id, status: "pending", decidedBy: "human" });
}
