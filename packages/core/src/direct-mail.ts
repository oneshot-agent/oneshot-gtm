import { randomUUID } from "node:crypto";
import type {
  MailPreviewInput,
  MailQuote,
  MailOrder,
  PostalAddress,
  MailSendInput,
} from "@oneshot-agent/sdk";
import { getAgent, cadenceGoalId } from "./oneshot.ts";
import { getLedger } from "./ledger.ts";
export type {
  MailPreviewInput,
  MailQuote,
  MailOrder,
  PostalAddress,
  MailSendInput,
} from "@oneshot-agent/sdk";
export interface DirectMailDraft {
  id: string;
  revision?: number;
  prospectId: number;
  playName: string;
  enrollment: string;
  stepIndex: number;
  input: MailPreviewInput;
  quote: MailQuote;
  approvalId?: string;
  sendKey: string;
  sendInput?: MailSendInput;
  cancelRequested?: boolean;
  refreshedAt?: string;
  canceled?: boolean;
  started?: boolean;
  order?: MailOrder;
  receiptId?: number;
}
function activeDraft(id: string) {
  const draft = getLedger().getDirectMail(id);
  if (!draft) throw new Error("Mailpiece not found");
  return draft;
}
export async function uploadMailArtwork(
  data: Uint8Array,
  mime: "application/pdf" | "image/png" | "image/jpeg",
) {
  return (await getAgent()).physicalMail.uploadArtwork(data, mime);
}
export async function previewDirectMail(
  prospectId: number,
  playName: string,
  input: MailPreviewInput,
) {
  const ledger = getLedger();
  const cadence = ledger.getCadence(prospectId, playName);
  if (!cadence || cadence.status !== "active") throw new Error("An active cadence is required");
  const previous = ledger.findDirectMail(
    prospectId,
    playName,
    cadence.enrolled_at,
    cadence.current_step + 1,
  );
  if (previous?.started)
    throw new Error("Recover the existing order before changing this mailpiece");
  const quote = await (await getAgent()).physicalMail.preview(input);
  const draft: DirectMailDraft = {
    id: previous?.id ?? randomUUID(),
    prospectId,
    playName,
    revision: previous?.revision,
    enrollment: cadence.enrolled_at,
    stepIndex: cadence.current_step + 1,
    input: quote.input,
    quote,
    sendKey: randomUUID(),
  };
  ledger.saveDirectMail(draft);
  ledger.setCadenceDraft({
    prospectId,
    playName,
    draft: {
      subject: "Direct mail",
      body: "Review the print proof and price in Direct mail",
      flags: [],
      payload: { kind: "direct_mail", draftId: draft.id },
    },
  });
  ledger.setMailAddresses(prospectId, quote.input.to, quote.input.from);
  return draft;
}
export async function refreshDirectMail(id: string) {
  const draft = activeDraft(id);
  const mail = (await getAgent()).physicalMail;
  if (draft.started) {
    draft.order = draft.order
      ? await mail.getOrder(draft.order.order_id)
      : await mail.recover(draft.sendKey);
    if (
      draft.cancelRequested &&
      !draft.order.cancellation_requested &&
      !["canceled", "failed"].includes(draft.order.order_status)
    ) {
      draft.order = await mail.cancel(draft.order.order_id);
    }
    recordPaidOrder(draft);
  } else draft.quote = await mail.getQuote(draft.quote.quote_id);
  draft.refreshedAt = new Date().toISOString();
  getLedger().saveDirectMail(draft);
  return draft;
}
export async function approveDirectMail(
  id: string,
  approval: { input_hash: string; total_usdc: string; approved: true },
) {
  const draft = activeDraft(id);
  if (draft.started || draft.canceled || draft.cancelRequested)
    throw new Error("Mailpiece already submitted or canceled");
  if (
    approval.approved !== true ||
    approval.input_hash !== draft.quote.input_hash ||
    approval.total_usdc !== draft.quote.total_usdc
  )
    throw new Error("Review the current proof and price first");
  const result = await (
    await getAgent()
  ).physicalMail.approve({ quote_id: draft.quote.quote_id, ...approval });
  draft.approvalId = result.approval_id;
  getLedger().saveDirectMail(draft);
  return draft;
}
function recordPaidOrder(draft: DirectMailDraft) {
  if (!draft.order || draft.order.payment_status !== "settled") return;
  draft.receiptId = getLedger().recordMailReceipt(draft.order.receipt_id, {
    playName: draft.playName,
    callType: "direct_mail.order",
    costUsd: Number(draft.order.total_usdc),
    signedReceipt: draft.order.signed_receipt,
    oneshotRequestId: draft.order.receipt_id,
    decisionContext: {
      goalId: cadenceGoalId(
        draft.playName,
        getLedger().getProspectById(draft.prospectId)?.email ?? `pid:${draft.prospectId}`,
      ),
      prospectId: draft.prospectId,
      stepIndex: draft.stepIndex,
    },
  });
}
export async function sendDirectMail(id: string) {
  const ledger = getLedger();
  const draft = activeDraft(id);
  const mail = (await getAgent()).physicalMail;
  // Recover already-started submissions even after a reply; never send a new request in that case.
  if (draft.started) {
    try {
      return await refreshDirectMail(id);
    } catch (e) {
      if (!(e instanceof Error) || (e as { statusCode?: number }).statusCode !== 404) throw e;
    }
  }
  const cadence = ledger.getCadence(draft.prospectId, draft.playName);
  const prospect = ledger.getProspectById(draft.prospectId);
  if (
    !cadence ||
    cadence.status !== "active" ||
    cadence.enrolled_at !== draft.enrollment ||
    cadence.current_step + 1 !== draft.stepIndex ||
    cadence.replied_at ||
    (prospect?.email &&
      (ledger.suppressionFor(prospect.email) || ledger.contactSuppressionFor(prospect.email)))
  )
    throw new Error("Cadence stopped, replied, or recipient suppressed");
  if (draft.canceled || draft.cancelRequested)
    throw new Error("Mailpiece canceled or cancellation requested");
  if (!draft.approvalId || !draft.quote.total_usdc)
    throw new Error("Individual mailpiece approval required");
  // Freeze the entire SDK payload, including audit context, before the first network attempt.
  // A changed prospect record must not change the request hash on a retry.
  if (draft.started && !draft.sendInput)
    throw new Error(
      "Cannot retry a legacy mailpiece without its original payload; recover the existing order",
    );
  draft.sendInput ??= {
    quote_id: draft.quote.quote_id,
    approval_id: draft.approvalId,
    idempotencyKey: draft.sendKey,
    maxCost: Number(draft.quote.total_usdc),
    memo: `${draft.playName} step ${draft.stepIndex} physical mail`,
    decisionContext: {
      goalId: cadenceGoalId(draft.playName, prospect?.email ?? `pid:${draft.prospectId}`),
      prospectId: draft.prospectId,
      stepIndex: draft.stepIndex,
    },
  };
  draft.started = true;
  ledger.saveDirectMail(draft);
  draft.order = await mail.send(draft.sendInput);
  recordPaidOrder(draft);
  ledger.saveDirectMail(draft);
  return draft;
}
export async function cancelDirectMail(id: string) {
  const draft = activeDraft(id);
  if (!draft.started) {
    draft.approvalId = undefined;
    draft.canceled = true;
    getLedger().saveDirectMail(draft);
    return draft;
  }
  // Persist intent before recovery: a timeout must not lose a user's cancellation request.
  draft.cancelRequested = true;
  getLedger().saveDirectMail(draft);
  try {
    return await refreshDirectMail(id);
  } catch (error) {
    if ((error as { statusCode?: number })?.statusCode === 404 && !draft.order) return draft;
    throw error;
  }
}

/** Non-spending scheduler sweep. Fulfillment never creates another paid receipt. */
export async function refreshPendingDirectMail() {
  // Canceled/failed paid orders can still await an asynchronous refund; keep refreshing
  // until refunded_at confirms it so the local financial status cannot become stale.
  const drafts = getLedger()
    .listDirectMail()
    .filter(
      (d) =>
        d.started && !d.order?.refunded_at && d.order?.fulfillment_status !== "returned_to_sender",
    );
  const results = await Promise.allSettled(
    drafts
      .sort((a, b) => (a.refreshedAt ?? "").localeCompare(b.refreshedAt ?? ""))
      .slice(0, 50)
      .map((d) => refreshDirectMail(d.id)),
  );
  return {
    refreshed: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length,
  };
}
