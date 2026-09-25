import { removeLinkedInAccount, forceReconnectLinkedInAccount } from "../linkedin-remove.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  currentWorkspaceName,
  demoMode,
  isDraining,
  getLedger,
  getLinkedInInboxStore,
  getReplyReviewStore,
  humanReplyIds,
  linkedInMatches,
  loadConfig,
  logEvent,
  openLedgerDatabase,
  replyWorkspaces,
  trackSend,
} from "@oneshot-gtm/core";
import {
  generateReplyOptions,
  improveReplyOption,
  lintReplyOptions,
  type ReplyOptionsContext,
} from "@oneshot-gtm/plays";
import {
  REPLY_VARIANTS,
  type ReplyDraftSet,
  type ReplySendState,
  type ReplyThread,
  type ReplyStateRequest,
  type InboxSendReplyRequest,
} from "@oneshot-gtm/shared-types";
import { isLoopbackOrigin, jsonResponse } from "../server.ts";
import { callLinkedIn } from "../linkedin-client.ts";
import {
  startLinkedInBackfill,
  backfillStatus,
  resumeLinkedInBackfills,
} from "../linkedin-backfill.ts";
import { refreshLinkedInInbox } from "../linkedin-sync.ts";
import { collectReplies } from "./replies-view.ts";
import { sendReplyRoute, archiveInboxConversationRoute } from "./inbox.ts";
import { mailboxStateRoute } from "./mailboxes.ts";

function thread(key: unknown): ReplyThread {
  if (typeof key !== "string") throw new Error("Conversation key is required");
  const t = getReplyReviewStore().get(key);
  if (!t || (t.workspace && t.workspace !== currentWorkspaceName()))
    throw new Error("Conversation not found in this workspace");
  if (t.channel === "linkedin") {
    const owner = getLinkedInInboxStore().thread(key)?.owner;
    if (owner?.workspace && owner.workspace !== currentWorkspaceName())
      throw new Error("Conversation has moved to another workspace");
    if ((owner?.prospectId ?? null) !== t.prospectId)
      throw new Error("Conversation assignment changed. Refresh before continuing.");
  }
  return t;
}
function internalRequest(req: Request, body: unknown) {
  return new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(body) });
}
async function payload(req: Request): Promise<Record<string, unknown>> {
  if (demoMode()) throw new Error("Read-only demo");
  if (!isLoopbackOrigin(req.headers.get("origin") ?? "")) throw new Error("Forbidden origin");
  if (!req.headers.get("content-type")?.includes("application/json"))
    throw new Error("JSON is required");
  const b: unknown = await req.json();
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("Invalid request");
  return b as Record<string, unknown>;
}
function failure(req: Request, e: unknown) {
  return jsonResponse(
    {
      error: (e as Error).message,
      requestId: (e as { requestId?: string }).requestId,
      code: (e as { code?: string }).code,
      statusCode: (e as { statusCode?: number }).statusCode,
    },
    (e as Error).message === "Forbidden origin"
      ? 403
      : /changed|new reply|pending|being sent/.test((e as Error).message)
        ? 409
        : 400,
    req,
  );
}

export async function repliesRoute(req: Request) {
  void refreshLinkedInInbox().catch((e) =>
    logEvent("linkedin.capture.failed", { message: (e as Error).message }, "warn"),
  );
  try {
    return jsonResponse(await collectReplies(req), 200, req);
  } catch (e) {
    return failure(req, e);
  }
}

export async function replyStateRoute(req: Request) {
  try {
    const b = await payload(req);
    let t = thread(b.key);
    if (
      !["archive", "restore", "snooze", "unsnooze"].includes(String(b.action)) ||
      !Array.isArray(b.observedReplyIds) ||
      !b.observedReplyIds.every((id) => typeof id === "string")
    )
      throw new Error("Invalid conversation state request");
    // Re-read durable inbound state before hiding; never trust the browser's snapshot alone.
    await collectReplies(req);
    t = thread(b.key);
    const action = b.action as ReplyStateRequest["action"];
    if (
      (action === "archive" || action === "snooze") &&
      humanReplyIds(t).some((id) => !(b.observedReplyIds as string[]).includes(id))
    )
      throw new Error("A new reply arrived. Refresh before hiding this conversation.");
    if ((action === "archive" || action === "restore") && t.channel === "email") {
      const archived = action === "archive";
      const response = t.mailboxThreadKey
        ? await mailboxStateRoute(
            internalRequest(req, {
              threadKey: t.mailboxThreadKey,
              archived,
              observedReplyIds: b.observedReplyIds,
            }),
          )
        : t.prospectId != null
          ? await archiveInboxConversationRoute(
              internalRequest(req, {
                prospectId: t.prospectId,
                archived,
                observedReplyIds: b.observedReplyIds,
              }),
            )
          : null;
      if (response && !response.ok) return response;
    }
    return jsonResponse(
      getReplyReviewStore().setState(t.key, action, b.observedReplyIds as string[]),
      200,
      req,
    );
  } catch (e) {
    return failure(req, e);
  }
}

export function replyOptionsContext(t: ReplyThread, steer = ""): ReplyOptionsContext {
  const cfg = loadConfig();
  const ledger = getLedger();
  const p = t.prospectId == null ? null : ledger.getProspectById(t.prospectId);
  const outreach = p
    ? ledger
        .listSequenceEventsForProspect(p.id)
        .filter((e) => e.status === "sent")
        .flatMap((e) => {
          try {
            const data = JSON.parse(e.metadata_json ?? "{}");
            return typeof data.body === "string" ? [data.body] : [];
          } catch {
            return [];
          }
        })
    : [];
  const row = p ? ledger.getQueueRowForProspect(p.id) : null;
  let firstTouch: ReplyOptionsContext["firstTouch"] = null;
  if (row?.status === "sent") {
    try {
      const data = JSON.parse(row.payload_json);
      firstTouch = {
        play: row.play_name,
        edge: data.yourEdge ?? "",
        fitReason: data.fitReason ?? "",
      };
    } catch {
      /* Older queue rows lack a structured edge. */
    }
  }
  return {
    channel: t.channel,
    founder: cfg.founderName ?? "",
    founderCalendarUrl:
      (cfg as unknown as { founderCalendarUrl?: string }).founderCalendarUrl ?? "",
    primaryWorkspace: t.workspace ?? currentWorkspaceName(),
    primaryProduct: cfg.productOneLiner ?? "",
    primaryBrief: cfg.productBrief ?? "",
    secondaryProducts: [],
    founderVoice: cfg.founderVoice ?? "",
    learnedPreferences:
      t.channel === "linkedin" && t.workspace
        ? getReplyReviewStore().learning.guidance(t.workspace).instructions
        : [],
    steer,
    prospect: {
      name: p?.name ?? t.name,
      company: p?.company ?? t.company ?? "",
      title: p?.title ?? "",
      profileUrl: t.profileUrl ?? p?.linkedin_url ?? "",
    },
    dossier: p?.dossier_json ?? "",
    priorOutreach: outreach,
    thread: t.messages
      .filter((m) => !m.deleted)
      .map((m) => ({ direction: m.direction, body: m.body || "[attachment]", at: m.at })),
    casualTexture: false,
    icp: p?.icp_verdict ? { verdict: p.icp_verdict, reason: p.icp_verdict_reason ?? "" } : null,
    firstTouch,
    angleJson: p?.angle_json,
  };
}

export function emptyReplyDraft(t: ReplyThread): ReplyDraftSet {
  const body = t.email?.thread?.draftBody ?? "";
  return {
    id: randomUUID(),
    revision: 0,
    contextVersion: t.contextVersion,
    read: "",
    originals: { direct: "", technical: "", warm: "" },
    edits: { direct: body, technical: "", warm: "" },
    moves: {},
    flags: { direct: [], technical: [], warm: [] },
    setFlags: [],
    selected: "direct",
    steer: t.email?.thread?.steer ?? "",
    generated: false,
  };
}
function draftPayload(value: unknown): ReplyDraftSet {
  if (!value || typeof value !== "object") throw new Error("Draft set is required");
  const d = value as ReplyDraftSet;
  if (
    typeof d.id !== "string" ||
    d.id.length > 100 ||
    !Number.isSafeInteger(d.revision) ||
    typeof d.contextVersion !== "string" ||
    typeof d.read !== "string" ||
    d.read.length > 20000 ||
    typeof d.generated !== "boolean" ||
    !d.moves ||
    typeof d.moves !== "object" ||
    !Object.values(d.moves).every((v) => typeof v === "string" && v.length <= 4000) ||
    !REPLY_VARIANTS.includes(d.selected) ||
    typeof d.steer !== "string" ||
    d.steer.length > 4000 ||
    !REPLY_VARIANTS.every(
      (v) =>
        typeof d.edits?.[v] === "string" &&
        d.edits[v].length <= 20000 &&
        typeof d.originals?.[v] === "string" &&
        d.originals[v].length <= 20000,
    )
  )
    throw new Error("Invalid reply draft set");
  return d;
}
export async function replyDraftSaveRoute(req: Request) {
  try {
    const b = await payload(req);
    const t = thread(b.key);
    const d = draftPayload(b.drafts);
    if (b.expectedRevision !== null && !Number.isSafeInteger(b.expectedRevision))
      throw new Error("Draft revision is required");
    const flags = lintReplyOptions(d.edits, d.moves, replyOptionsContext(t, d.steer));
    const saved = getReplyReviewStore().saveDrafts(
      t.key,
      { ...d, flags: flags.perVariant, setFlags: flags.set },
      b.expectedRevision as number | null,
    );
    return jsonResponse(saved, 200, req);
  } catch (e) {
    return failure(req, e);
  }
}
export async function replyGenerateRoute(req: Request) {
  let lease: string | null = null;
  let key = "";
  try {
    const b = await payload(req);
    const t = thread(b.key);
    key = `generate:${t.key}`;
    if (!t.canGenerate)
      throw new Error(t.unavailableReason ?? "This message cannot be drafted automatically");
    if (!b.force && t.drafts?.generated && t.drafts.contextVersion === t.contextVersion)
      return jsonResponse(t.drafts, 200, req);
    lease = getReplyReviewStore().claim(key);
    if (!lease) throw new Error("Reply generation is already pending");
    const steer = typeof b.steer === "string" ? b.steer.slice(0, 4000) : (t.drafts?.steer ?? "");
    const context = replyOptionsContext(t, steer);
    const learningVersion =
      t.channel === "linkedin" && t.workspace
        ? getReplyReviewStore().learning.guidance(t.workspace).version
        : undefined;
    const generated = await generateReplyOptions(context);
    const next: ReplyDraftSet = {
      ...emptyReplyDraft(t),
      id: randomUUID(),
      revision: t.drafts?.revision ?? 0,
      read: generated.read,
      originals: generated.drafts,
      edits: { ...generated.drafts },
      moves: generated.moves,
      flags: generated.flags.perVariant,
      setFlags: generated.flags.set,
      steer,
      generated: true,
      learningVersion,
    };
    getReplyReviewStore().learning.recordGeneration(t, next, context);
    // The browser explicitly accepts a replacement; a generation never mutates existing edits.
    return jsonResponse(next, 200, req);
  } catch (e) {
    return failure(req, e);
  } finally {
    if (lease) getReplyReviewStore().release(key, lease);
  }
}
export async function replyImproveRoute(req: Request) {
  try {
    const b = await payload(req);
    const t = thread(b.key);
    if (t.channel === "linkedin" && !t.workspace)
      throw new Error("Assign a workspace before improving a reply");
    if (
      !REPLY_VARIANTS.includes(b.variant as never) ||
      typeof b.text !== "string" ||
      !b.text.trim() ||
      b.text.length > 20000 ||
      (b.feedback !== undefined && typeof b.feedback !== "string")
    )
      throw new Error("A reply and valid option are required");
    const variant = b.variant as (typeof REPLY_VARIANTS)[number];
    const feedback = String(b.feedback ?? "").slice(0, 4000);
    const text = await improveReplyOption(
      replyOptionsContext(t, t.drafts?.steer),
      b.text,
      t.drafts?.originals[variant] ?? "",
      feedback,
    );
    const improvementId = getReplyReviewStore().learning.recordImprovement(
      t,
      variant,
      b.text,
      text,
      feedback,
    );
    return jsonResponse({ text, improvementId }, 200, req);
  } catch (e) {
    return failure(req, e);
  }
}

function knownFailure(e: unknown) {
  const error = e as { name?: string; statusCode?: number; code?: string };
  return (
    (error.name === "JobError" && error.code !== "send_unverified") ||
    (typeof error.statusCode === "number" &&
      [400, 401, 403, 404, 422, 429].includes(error.statusCode))
  );
}
async function sendLinkedIn(t: ReplyThread, send: ReplySendState): Promise<ReplySendState> {
  const store = getReplyReviewStore();
  const a = getLinkedInInboxStore().account(t.accountKey!);
  if (!a) throw new Error("LinkedIn account not found");
  try {
    const result = send.requestId
      ? await callLinkedIn<Record<string, unknown>>(a.workspace, {
          kind: "wait",
          requestId: send.requestId,
        })
      : await callLinkedIn<Record<string, unknown>>(a.workspace, {
          kind: "reply",
          accountId: a.account.id,
          conversationId: t.conversationId!,
          text: send.body,
          idempotencyKey: send.id,
        });
    const requestId = typeof result.request_id === "string" ? result.request_id : send.requestId;
    const next: ReplySendState =
      result.status === "sent"
        ? {
            ...send,
            requestId,
            status: "sent",
            error: undefined,
            sentAt: typeof result.sent_at === "string" ? result.sent_at : new Date().toISOString(),
          }
        : { ...send, requestId, status: "pending", error: undefined };
    store.updateSend(t.key, next);
    if (next.status === "sent") void refreshLinkedInInbox(true).catch(() => {});
    return next;
  } catch (e) {
    const err = e as Error & { requestId?: string; jobId?: string };
    const next: ReplySendState = {
      ...send,
      requestId: err.requestId ?? err.jobId ?? send.requestId,
      status: knownFailure(e) ? "failed" : "uncertain",
      error: err.message,
    };
    store.updateSend(t.key, next);
    return next;
  }
}
export async function replySendRoute(req: Request) {
  try {
    if (isDraining()) throw new Error("Server restarting — retry in a moment");
    const b = await payload(req);
    const t = thread(b.key);
    const review = getReplyReviewStore();
    if (b.check === true) {
      if (!t.send) throw new Error("No send to check");
      if (t.channel === "linkedin" && ["pending", "uncertain"].includes(t.send.status)) {
        const token = review.claim(`send:${t.key}`, 60_000);
        if (!token) return jsonResponse(t.send, 200, req);
        try {
          return jsonResponse(await sendLinkedIn(t, t.send), 200, req);
        } finally {
          review.release(`send:${t.key}`, token);
        }
      }
      if (t.channel === "email" && ["pending", "uncertain"].includes(t.send.status)) {
        // The existing mailbox poll reconciles ambiguous SMTP sends against Sent.
        const attempt = getLedger().mailboxes.attempt(t.send.id);
        if (attempt && ["sent", "failed"].includes(attempt.status)) {
          const next: ReplySendState = {
            ...t.send,
            status: attempt.status as "sent" | "failed",
            error: attempt.error ?? undefined,
            sentAt: attempt.status === "sent" ? attempt.message.at : undefined,
          };
          review.updateSend(t.key, next);
          return jsonResponse(next, 200, req);
        }
      }
      return jsonResponse(t.send, 200, req);
    }
    if (!t.canSend || !t.drafts) throw new Error("This conversation is not ready to send");
    if (t.channel === "linkedin") {
      const store = getLinkedInInboxStore();
      const account = store.account(t.accountKey!);
      const current = store.thread(t.key);
      if (
        account?.previousAccountIds?.length &&
        (current?.sourceAccountId !== account.account.id ||
          current?.conversation.id !== t.conversationId)
      )
        throw new Error(
          "LinkedIn connection changed. Refresh and review the conversation before sending.",
        );
    }
    if (typeof b.sendId !== "string" || !/^[a-zA-Z0-9-]{16,100}$/.test(b.sendId))
      throw new Error("A send ID is required");
    if (t.send?.id === b.sendId) return jsonResponse(t.send, 200, req);
    const body = t.drafts.edits[t.drafts.selected].trim();
    if (!body || (t.channel === "linkedin" && body.length > 4000))
      throw new Error("Enter a reply within the channel's length limit");
    const send = review.beginSend(
      t.key,
      {
        id: b.sendId,
        status: "pending",
        body,
        variant: t.drafts.selected,
        generationId: t.drafts.id,
      },
      Number(b.revision),
    );
    if (t.channel === "linkedin")
      return jsonResponse(await trackSend(() => sendLinkedIn(t, send)), 200, req);
    const r = t.email!;
    const request: InboxSendReplyRequest = {
      to: r.fromEmail,
      subject: r.subject || "Re:",
      body,
      identityId: r.sourceIdentityId!,
      threadKey: r.threadId ?? r.id,
      threadId: r.threadId,
      inReplyTo: r.messageId,
      replyToEmailId: r.sourceProvider === "oneshot" ? r.id : null,
      ...(r.sourceProvider === "smartlead" ? { inboundEmailId: r.id, sendRequestId: send.id } : {}),
    };
    const response = await sendReplyRoute(internalRequest(req, request));
    const result = (await response.json()) as { sent?: boolean; error?: string };
    const attempt =
      r.sourceProvider === "smartlead" ? getLedger().mailboxes.attempt(send.id) : null;
    const confirmed = response.ok && result.sent;
    const failed =
      attempt?.status === "failed" ||
      /was not sent|cannot be sent|required|does not match/.test(result.error ?? "");
    const next: ReplySendState = {
      ...send,
      status: confirmed ? "sent" : failed ? "failed" : "uncertain",
      error: result.error,
      sentAt: confirmed ? new Date().toISOString() : undefined,
    };
    review.updateSend(t.key, next);
    return jsonResponse(next, 200, req);
  } catch (e) {
    return failure(req, e);
  }
}

export async function repliesLinkedInRoute(req: Request) {
  try {
    const b = await payload(req);
    const workspace = currentWorkspaceName();
    const a =
      typeof b.accountKey === "string" ? getLinkedInInboxStore().account(b.accountKey) : null;
    if (
      [
        "remove",
        "force-reconnect",
        "reconnect",
        "upgrade",
        "sync",
        "backfill",
        "backfill-status",
      ].includes(String(b.action)) &&
      !a
    ) {
      throw new Error("LinkedIn account not found. Refresh Replies and try again.");
    }
    if (b.action === "force-reconnect" && a)
      return jsonResponse(await forceReconnectLinkedInAccount(a.key), 200, req);
    if (b.action === "remove" && a)
      return jsonResponse(await removeLinkedInAccount(a.key), 200, req);
    if (a?.removedAt)
      throw new Error("This LinkedIn account has been removed. Connect an account to continue.");
    if (b.action === "refresh") {
      await refreshLinkedInInbox(true);
      return jsonResponse({ ok: true }, 200, req);
    }
    if (b.action === "connect")
      return jsonResponse(await callLinkedIn(workspace, { kind: "connect" }), 200, req);
    if (b.action === "upgrade" && a?.permissionUpgradeError)
      throw new Error(a.permissionUpgradeError);
    if ((b.action === "reconnect" || b.action === "upgrade") && a)
      return jsonResponse(
        await callLinkedIn(a.workspace, {
          kind: "connect",
          accountId: a.account.id,
          upgrade: b.action === "upgrade",
        }),
        200,
        req,
      );
    if (b.action === "connection" && typeof b.intentId === "string") {
      const result = await callLinkedIn<{ status: string; failure_reason?: string }>(
        a?.workspace ?? workspace,
        {
          kind: "connection",
          intentId: b.intentId,
        },
      );
      if (result.status === "failed" && result.failure_reason === "duplicate_member" && a) {
        getLinkedInInboxStore().saveAccount({
          ...a,
          permissionUpgradeError:
            "OneShot rejected the permission upgrade because this member is already connected. Adding permissions requires replacing the upstream connection or a OneShot grant-upgrade API change. Local history and assignments are preserved.",
        });
      }
      if (result.status === "completed") await refreshLinkedInInbox(true);
      return jsonResponse(result, 200, req);
    }
    if (b.action === "backfill-status" && a) return jsonResponse(backfillStatus(a.key), 200, req);
    if ((b.action === "sync" || b.action === "backfill") && a) {
      const job = startLinkedInBackfill(a.key);
      void resumeLinkedInBackfills().catch(() => {});
      return jsonResponse(job, 202, req);
    }
    throw new Error("Unknown LinkedIn action. Reload the dashboard and try again.");
  } catch (e) {
    return failure(req, e);
  }
}
export async function replyAssignRoute(req: Request) {
  try {
    const b = await payload(req);
    const t = thread(b.key);
    if (t.send && ["pending", "uncertain"].includes(t.send.status))
      throw new Error("A reply is still being sent. Wait before changing assignment.");
    if (
      t.channel !== "linkedin" ||
      typeof b.workspace !== "string" ||
      !Number.isSafeInteger(b.prospectId)
    )
      throw new Error("Choose a workspace and prospect");
    const w = replyWorkspaces().find((w) => w.name === b.workspace);
    if (!w) throw new Error("Workspace not found");
    const db = openLedgerDatabase(join(w.home, "ledger.sqlite"), { readonly: true });
    try {
      if (!db.query("SELECT 1 FROM prospects WHERE id=?").get(b.prospectId as number))
        throw new Error("Prospect not found");
    } finally {
      db.close();
    }
    const store = getLinkedInInboxStore();
    store.assign(t.key, { workspace: b.workspace, prospectId: b.prospectId as number });
    store.deliver(store.thread(t.key)!, linkedInMatches());
    return jsonResponse({ ok: true }, 200, req);
  } catch (e) {
    return failure(req, e);
  }
}
export async function replyProspectsRoute(req: Request) {
  if (demoMode()) return jsonResponse({ prospects: [] }, 200, req);
  const q = new URL(req.url).searchParams.get("q") ?? "";
  const prospects: Array<{ workspace: string; id: number; name: string; email: string | null }> =
    [];
  for (const w of replyWorkspaces()) {
    const db = openLedgerDatabase(join(w.home, "ledger.sqlite"), { readonly: true });
    try {
      prospects.push(
        ...db
          .query<{ id: number; name: string; email: string | null }, [string, string]>(
            "SELECT id,COALESCE(name,email,'Prospect ' || id) name,email FROM prospects WHERE name LIKE ? OR email LIKE ? ORDER BY name LIMIT 100",
          )
          .all(`%${q}%`, `%${q}%`)
          .map((p) => ({ id: p.id, name: p.name, email: p.email, workspace: w.name })),
      );
    } finally {
      db.close();
    }
  }
  return jsonResponse({ prospects }, 200, req);
}

export async function replyLearningRoute(req: Request) {
  try {
    if (demoMode())
      return jsonResponse(
        {
          enabled: false,
          version: 0,
          pending: false,
          imported: false,
          lastRefreshedAt: null,
          error: null,
          preferences: [],
        },
        200,
        req,
      );
    const learning = getReplyReviewStore().learning;
    const workspace = currentWorkspaceName();
    if (req.method === "POST") {
      const b = await payload(req);
      if (
        typeof b.enabled !== "boolean" ||
        (b.preferenceId !== undefined && (typeof b.preferenceId !== "string" || !b.preferenceId))
      )
        throw new Error("A learning setting is required");
      learning.setEnabled(workspace, b.enabled, b.preferenceId as string | undefined);
    }
    return jsonResponse(learning.status(workspace), 200, req);
  } catch (e) {
    return failure(req, e);
  }
}
