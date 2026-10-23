import {
  demoMode,
  getLedger,
  loadConfig,
  logEvent,
  NEAR_DUPLICATE_QUESTION,
  normalizeQuestion,
  questionSimilarity,
} from "@oneshot-gtm/core";
import {
  approveCodeAnswer,
  captureCodeQuestion,
  codeAnswersEnabled,
  codeAnswersForThread,
  deriveCodeAnswer,
  dismissCodeAnswer,
  listCodeAnswers,
  sweepCodeAnswers,
  testSourceRepo,
} from "@oneshot-gtm/find";
import type { CodeAnswer, ReplyAsk, SourceRepoTestResult } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";
import { mergeSourceRepo } from "./setup.ts";

/**
 * Answers from your code. A how-it-works question a prospect asked that the
 * brief does not answer is captured from the reply composer and read against
 * the connected source repo in the background; the founder approves, edits
 * or dismisses the answer here (on /setup, or in the composer card). Nothing
 * reaches a prompt until it is approved.
 */

const READ_ONLY = { error: "The demo is read-only." };
const NO_REPO = { error: "Connect a source repo on /setup first." };
/** The store's own limit on an approved answer. */
const MAX_ANSWER_CHARS = 1200;
/** Who decided, as the ledger records it for the founder's own decisions. */
const DECIDED_BY = "human";

/**
 * Derives this process has started and not finished. The store's lease
 * marks a row `deriving` once the derive claims it; this covers the moment
 * before, so a list right after "Read again" already shows it reading.
 */
const deriving = new Set<string>();

function view(row: CodeAnswer): CodeAnswer {
  return deriving.has(row.id) && !row.deriving ? { ...row, deriving: true } : row;
}

function startDerive(
  ledger: ReturnType<typeof getLedger>,
  id: string,
  opts: { force?: boolean } = {},
): void {
  deriving.add(id);
  // deriveCodeAnswer never throws; it logs its own failures.
  void deriveCodeAnswer(id, { ledger, ...(opts.force ? { force: true } : {}) })
    .catch((e: unknown) =>
      logEvent("code_answer.derive_failed", { id, message_120: String(e).slice(0, 120) }, "warn"),
    )
    .finally(() => deriving.delete(id));
}

/**
 * From a fresh reply generation: a mechanism question the brief does not
 * answer, with a source repo connected, is captured (or bumps the same
 * question asked before) and read in the background when nothing has read
 * it yet. Returns the row's id for the composer card. Never throws: a
 * failure here only means no card, never a failed draft.
 */
export function captureReplyAsk(threadKey: string, ask: ReplyAsk | undefined): string | undefined {
  if (ask?.level !== "mechanism" || ask.briefAnswers || !ask.question) return undefined;
  try {
    const cfg = loadConfig();
    if (!codeAnswersEnabled(cfg)) return undefined;
    const ledger = getLedger();
    const captured = captureCodeQuestion({ question: ask.question, threadKey, ledger, cfg });
    if (!captured) return undefined;
    if (captured.shouldDerive && !deriving.has(captured.answer.id))
      startDerive(ledger, captured.answer.id);
    return captured.answer.id;
  } catch (e) {
    logEvent(
      "code_answer.capture_failed",
      { message_120: (e as Error).message.slice(0, 120) },
      "warn",
    );
    return undefined;
  }
}

/**
 * Whether a saved draft may point at this answer: one its conversation
 * asked, for the question the draft's `ask` carries, by the same identity
 * capture uses (exact, or a near-duplicate phrasing).
 */
export function draftAnswerMatches(
  threadKey: string,
  id: string,
  ask: ReplyAsk | undefined,
): boolean {
  if (!ask?.question) return false;
  const answer = codeAnswersForThread(threadKey, { ledger: getLedger() }).find((a) => a.id === id);
  if (!answer) return false;
  return (
    normalizeQuestion(answer.question) === normalizeQuestion(ask.question) ||
    questionSimilarity(answer.question, ask.question) >= NEAR_DUPLICATE_QUESTION
  );
}

/**
 * GET /api/code-answers?threadKey&id — every question, review order; with
 * `threadKey`, the ones that conversation asked, plus `id` when given (the
 * one its current drafts carry).
 */
export function listCodeAnswersRoute(req: Request): Response {
  const url = new URL(req.url);
  const threadKey = url.searchParams.get("threadKey");
  const id = url.searchParams.get("id");
  const ledger = getLedger();
  const all = listCodeAnswers({ ledger });
  let answers = all;
  if (threadKey || id) {
    const ids = new Set<string>(
      threadKey ? codeAnswersForThread(threadKey, { ledger }).map((a) => a.id) : [],
    );
    if (id) ids.add(id);
    answers = all.filter((a) => ids.has(a.id));
  }
  return jsonResponse({ answers: answers.map(view) }, 200, req);
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b: unknown = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function decision(req: Request, out: { answer: CodeAnswer } | { error: string }): Response {
  if ("error" in out)
    return jsonResponse({ error: out.error }, /not found/.test(out.error) ? 404 : 409, req);
  return jsonResponse({ ok: true, answer: view(out.answer) }, 200, req);
}

/**
 * POST /api/code-answers/:id/approve, body `{ text? }`: approve the answer
 * as read, or the founder's edit (required for a question the code did not
 * settle). 409 when it was decided already or changed meanwhile.
 */
export async function approveCodeAnswerRoute(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  if (demoMode()) return jsonResponse(READ_ONLY, 403, req);
  const b = await body(req);
  if (b.text !== undefined && (typeof b.text !== "string" || !b.text.trim()))
    return jsonResponse({ error: "An edited answer needs text." }, 400, req);
  const text = typeof b.text === "string" ? b.text.trim() : undefined;
  if (text && text.length > MAX_ANSWER_CHARS)
    return jsonResponse(
      { error: `An answer is limited to ${MAX_ANSWER_CHARS} characters.` },
      400,
      req,
    );
  return decision(
    req,
    approveCodeAnswer(params["id"] ?? "", {
      text: text ?? null,
      by: DECIDED_BY,
      ledger: getLedger(),
    }),
  );
}

/** POST /api/code-answers/:id/dismiss — out of the brief, and not read again. */
export function dismissCodeAnswerRoute(req: Request, params: Record<string, string>): Response {
  if (demoMode()) return jsonResponse(READ_ONLY, 403, req);
  return decision(
    req,
    dismissCodeAnswer(params["id"] ?? "", { by: DECIDED_BY, ledger: getLedger() }),
  );
}

/** POST /api/code-answers/:id/derive — read the code again for this question, in the background. */
export function deriveCodeAnswerRoute(req: Request, params: Record<string, string>): Response {
  if (demoMode()) return jsonResponse(READ_ONLY, 403, req);
  if (!codeAnswersEnabled(loadConfig())) return jsonResponse(NO_REPO, 409, req);
  const ledger = getLedger();
  const id = params["id"] ?? "";
  const row = listCodeAnswers({ ledger }).find((a) => a.id === id);
  if (!row) return jsonResponse({ error: "Answer not found." }, 404, req);
  if (row.status === "approved" || row.status === "dismissed")
    return jsonResponse({ error: `This answer is already ${row.status}.` }, 409, req);
  if (row.deriving || deriving.has(id))
    return jsonResponse({ error: "Already reading your code for this." }, 409, req);
  startDerive(ledger, id, { force: true });
  return jsonResponse({ ok: true, answer: view(row) }, 202, req);
}

/** POST /api/code-answers/sweep — check every answer against the repo now. */
export async function sweepCodeAnswersRoute(req: Request): Promise<Response> {
  if (demoMode()) return jsonResponse(READ_ONLY, 403, req);
  if (!codeAnswersEnabled(loadConfig())) return jsonResponse(NO_REPO, 409, req);
  const result = await sweepCodeAnswers({ ledger: getLedger() });
  if (result.error) return jsonResponse({ error: result.error, result }, 502, req);
  return jsonResponse({ ok: true, result }, 200, req);
}

/**
 * POST /api/setup/source-repo/test, body `{ url?, path?, ref? }` (the form's
 * unsaved values) or `{}` for the saved repo: can it be read, at which
 * commit. A bad value or an unreachable repo is the answer, not a failure.
 */
export async function testSourceRepoRoute(req: Request): Promise<Response> {
  if (demoMode()) return jsonResponse(READ_ONLY, 403, req);
  const b = await body(req);
  let repo;
  try {
    repo =
      b.url !== undefined || b.path !== undefined
        ? mergeSourceRepo(b as { url?: string; path?: string; ref?: string }, undefined)
        : loadConfig().sourceRepo;
  } catch (e) {
    return jsonResponse(
      { ok: false, error: (e as Error).message } satisfies SourceRepoTestResult,
      200,
      req,
    );
  }
  if (!repo)
    return jsonResponse({ ok: false, error: "Enter a GitHub URL or a local path." }, 200, req);
  return jsonResponse(await testSourceRepo(repo), 200, req);
}
