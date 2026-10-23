import {
  approveCodeAnswer,
  captureCodeQuestion,
  demoMode,
  dismissCodeAnswer,
  getLedger,
  getReplyReviewStore,
  listCodeAnswers,
  loadConfig,
  logEvent,
  type OneShotConfig,
} from "@oneshot-gtm/core";
import { deriveCodeAnswer, sweepCodeAnswers } from "@oneshot-gtm/plays";
import { testSourceRepo } from "@oneshot-gtm/find";
import type { CodeAnswer, ReplyAsk, SourceRepoTestResult } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";
import { mergeSourceRepo, SetupValidationError } from "./setup.ts";

/**
 * Answers from your code. A how-it-works question a prospect asked that the
 * brief does not answer is captured from the reply composer and read against
 * the configured source repo in the background; the founder approves, edits
 * or dismisses the answer here (on /setup, or in the composer card). Nothing
 * reaches a prompt until it is approved.
 */

const READ_ONLY = { error: "The demo is read-only." };
const MAX_ANSWER_CHARS = 2000;

/** Derives running in this process, so one question is never read twice at once. */
const deriving = new Set<string>();

export function sourceRepoConfigured(cfg: Pick<OneShotConfig, "sourceRepo">): boolean {
  return Boolean(cfg.sourceRepo?.url?.trim() || cfg.sourceRepo?.path?.trim());
}

function view(row: CodeAnswer): CodeAnswer {
  return { ...row, deriving: row.deriving || deriving.has(row.id) };
}

function startDerive(ledger: ReturnType<typeof getLedger>, id: string): boolean {
  if (deriving.has(id)) return false;
  deriving.add(id);
  void Promise.resolve()
    .then(() => deriveCodeAnswer(ledger, id))
    .catch((e: unknown) =>
      logEvent("code_answers.derive.failed", { id, message: (e as Error).message }, "warn"),
    )
    .finally(() => deriving.delete(id));
  return true;
}

/**
 * From a fresh reply generation: a mechanism question the brief does not
 * answer, with a repo configured, is captured (or bumped when it was asked
 * before) and read in the background when nothing has read it yet. Returns
 * the captured row's id for the composer card. Never throws: a failure here
 * only means no card, never a failed draft.
 */
export function captureReplyAsk(threadKey: string, ask: ReplyAsk | undefined): string | undefined {
  if (ask?.level !== "mechanism" || ask.briefAnswers || !ask.question) return undefined;
  try {
    if (!sourceRepoConfigured(loadConfig())) return undefined;
    const ledger = getLedger();
    const row = captureCodeQuestion(ledger, { question: ask.question, threadKey });
    if (row.status === "open" && !row.deriving) startDerive(ledger, row.id);
    return row.id;
  } catch (e) {
    logEvent("code_answers.capture.failed", { message: (e as Error).message }, "warn");
    return undefined;
  }
}

/**
 * GET /api/code-answers?threadKey&id — every answer, newest first; with
 * `threadKey`, only the ones that thread asked (its first asker, or the id its
 * saved drafts carry) plus `id` when given.
 */
export function listCodeAnswersRoute(req: Request): Response {
  const url = new URL(req.url);
  const threadKey = url.searchParams.get("threadKey");
  const id = url.searchParams.get("id");
  let answers = listCodeAnswers(getLedger()).map(view);
  if (threadKey || id) {
    const ids = new Set<string>();
    if (id) ids.add(id);
    const saved = threadKey ? getReplyReviewStore().get(threadKey)?.drafts?.codeAnswerId : null;
    if (saved) ids.add(saved);
    answers = answers.filter(
      (a) => ids.has(a.id) || (threadKey != null && a.sourceThreadKey === threadKey),
    );
  }
  return jsonResponse({ answers }, 200, req);
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b: unknown = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function failure(req: Request, e: unknown): Response {
  const message = (e as Error).message || "Request failed";
  const status =
    e instanceof SetupValidationError
      ? 400
      : typeof (e as { status?: unknown }).status === "number"
        ? (e as { status: number }).status
        : /not found|no such|unknown/i.test(message)
          ? 404
          : 409;
  return jsonResponse({ error: message }, status, req);
}

/** POST /api/code-answers/:id/approve, body `{ text? }`: approve as read, or the founder's edit. */
export async function approveCodeAnswerRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  if (demoMode()) return jsonResponse(READ_ONLY, 403, req);
  const b = await body(req);
  if (b.text !== undefined && (typeof b.text !== "string" || !b.text.trim()))
    return jsonResponse({ error: "An edited answer needs text" }, 400, req);
  if (typeof b.text === "string" && b.text.length > MAX_ANSWER_CHARS)
    return jsonResponse(
      { error: `An answer is limited to ${MAX_ANSWER_CHARS} characters` },
      400,
      req,
    );
  try {
    const text = typeof b.text === "string" ? b.text.trim() : undefined;
    const answer = approveCodeAnswer(getLedger(), params["id"] ?? "", text);
    return jsonResponse({ ok: true, answer: view(answer) }, 200, req);
  } catch (e) {
    return failure(req, e);
  }
}

/** POST /api/code-answers/:id/dismiss */
export function dismissCodeAnswerRoute(req: Request, params: Record<string, string>): Response {
  if (demoMode()) return jsonResponse(READ_ONLY, 403, req);
  try {
    const answer = dismissCodeAnswer(getLedger(), params["id"] ?? "");
    return jsonResponse({ ok: true, answer: view(answer) }, 200, req);
  } catch (e) {
    return failure(req, e);
  }
}

/** POST /api/code-answers/:id/derive — read the code again for this question, in the background. */
export function deriveCodeAnswerRoute(req: Request, params: Record<string, string>): Response {
  if (demoMode()) return jsonResponse(READ_ONLY, 403, req);
  if (!sourceRepoConfigured(loadConfig()))
    return jsonResponse({ error: "Connect a source repo on /setup first" }, 409, req);
  const ledger = getLedger();
  const id = params["id"] ?? "";
  const row = listCodeAnswers(ledger).find((a) => a.id === id);
  if (!row) return jsonResponse({ error: "Answer not found" }, 404, req);
  if (!startDerive(ledger, id))
    return jsonResponse({ error: "Already reading your code for this" }, 409, req);
  return jsonResponse({ ok: true, answer: view(row) }, 202, req);
}

/** POST /api/code-answers/sweep — re-check every answer against the repo now. */
export async function sweepCodeAnswersRoute(req: Request): Promise<Response> {
  if (demoMode()) return jsonResponse(READ_ONLY, 403, req);
  if (!sourceRepoConfigured(loadConfig()))
    return jsonResponse({ error: "Connect a source repo on /setup first" }, 409, req);
  try {
    const result = await sweepCodeAnswers(getLedger());
    return jsonResponse({ ok: true, result }, 200, req);
  } catch (e) {
    return failure(req, e);
  }
}

/**
 * POST /api/setup/source-repo/test, body `{ url?, path?, ref? }` (the form's
 * unsaved values) or `{}` for the saved repo: can it be read, at which commit.
 */
export async function testSourceRepoRoute(req: Request): Promise<Response> {
  if (demoMode()) return jsonResponse(READ_ONLY, 403, req);
  try {
    const b = await body(req);
    const repo =
      b.url !== undefined || b.path !== undefined
        ? mergeSourceRepo(b as { url?: string; path?: string; ref?: string }, undefined)
        : loadConfig().sourceRepo;
    if (!repo || !sourceRepoConfigured({ sourceRepo: repo }))
      return jsonResponse(
        { ok: false, error: "Enter a GitHub URL or a local path" } satisfies SourceRepoTestResult,
        200,
        req,
      );
    const result = await testSourceRepo(repo);
    return jsonResponse(result, 200, req);
  } catch (e) {
    // A bad form value or an unreachable repo is the answer to "test", not a failed request.
    return jsonResponse(
      { ok: false, error: (e as Error).message } satisfies SourceRepoTestResult,
      200,
      req,
    );
  }
}
