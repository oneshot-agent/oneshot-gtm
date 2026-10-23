import {
  DEFAULT_CODE_ANSWER_DISCLOSURE,
  getLedger,
  loadConfig,
  logEvent,
  normalizeQuestion,
  toCodeAnswerView,
  tryReserveDailySpend,
  type CodeAnswerFile,
  type CodeAnswerRecord,
  type Ledger,
  type OneShotConfig,
} from "@oneshot-gtm/core";
import {
  answerFromCode,
  CODE_ANSWER_PROMPT_VERSION,
  pickCodeFiles,
  type CodeSource,
} from "@oneshot-gtm/plays";
import type { CodeAnswer, SourceRepoTestResult } from "@oneshot-gtm/shared-types";
import { openSourceRepo, sha256, type SourceSnapshot } from "./source-repo.ts";

/**
 * Answers from your code: capture a prospect's how-it-works question, read
 * the founder's source repo to answer it, let the founder approve it into
 * the brief, and drop it again when the code it was read from changes.
 *
 * State lives in the ledger (`CodeAnswerStore`, core); the model steps in
 * plays (`code-answer.ts`); the repo readers in `source-repo.ts`. Every
 * function here takes the ledger and config it needs, defaulting to the
 * workspace's own, so the server and tests call them the same way.
 */

/** Daily-spend reservation for one derive: two short calls plus a possible rewrite turn. */
const DERIVE_RESERVATION_USD = 1;
/** Re-derives one sweep may start, so a large push cannot fan out into a burst of model calls. */
const MAX_SWEEP_REDERIVES = 10;

export interface CodeAnswerDeps {
  open?: typeof openSourceRepo;
  pick?: typeof pickCodeFiles;
  answer?: typeof answerFromCode;
  now?: () => Date;
}

/** A source repo is connected: the feature is on. */
export function codeAnswersEnabled(cfg: Pick<OneShotConfig, "sourceRepo">): boolean {
  return !!(cfg.sourceRepo?.path?.trim() || cfg.sourceRepo?.url?.trim());
}

/** The disclosure level in force, and whether it is the default (strict) one. */
export function codeAnswerDisclosure(cfg: Pick<OneShotConfig, "codeAnswerDisclosure">): {
  text: string;
  strict: boolean;
} {
  const own = cfg.codeAnswerDisclosure?.trim();
  return own
    ? { text: own, strict: false }
    : { text: DEFAULT_CODE_ANSWER_DISCLOSURE, strict: true };
}

/**
 * Record a how-it-works question a prospect asked. A near-duplicate of a
 * known question bumps that one. `shouldDerive` is true when the caller
 * should now read the code for it (in the background): a repo is
 * connected, nothing is reading it already, and it has no answer yet (or
 * its answer went stale and was not the founder's own words). Null when
 * the text is not a usable question.
 */
export function captureCodeQuestion(input: {
  question: string;
  threadKey?: string | null;
  ledger?: Ledger;
  cfg?: Pick<OneShotConfig, "sourceRepo">;
}): { answer: CodeAnswer; created: boolean; shouldDerive: boolean } | null {
  const ledger = input.ledger ?? getLedger();
  const cfg = input.cfg ?? loadConfig();
  const captured = ledger.codeAnswers.capture({
    question: input.question,
    threadKey: input.threadKey ?? null,
  });
  if (!captured) return null;
  const r = captured.record;
  const shouldDerive =
    codeAnswersEnabled(cfg) &&
    !r.deriving &&
    (r.status === "open" || (r.status === "stale" && !r.founderEdited));
  if (captured.created || captured.bumped)
    logEvent("code_answer.captured", {
      id: r.id,
      created: captured.created,
      status: r.status,
      asked: r.askedCount,
    });
  return { answer: toCodeAnswerView(r), created: captured.created, shouldDerive };
}

/** Every question, review order (pending first). */
export function listCodeAnswers(opts: { ledger?: Ledger } = {}): CodeAnswer[] {
  return (opts.ledger ?? getLedger()).codeAnswers.list().map(toCodeAnswerView);
}

/** The questions one reply thread asked, newest first. */
export function codeAnswersForThread(
  threadKey: string,
  opts: { ledger?: Ledger } = {},
): CodeAnswer[] {
  return (opts.ledger ?? getLedger()).codeAnswers.forThread(threadKey).map(toCodeAnswerView);
}

/** Approve into the brief, as written or with the founder's text (required unless pending). */
export function approveCodeAnswer(
  id: string,
  input: { text?: string | null; by: string; ledger?: Ledger },
): { answer: CodeAnswer } | { error: string } {
  const out = (input.ledger ?? getLedger()).codeAnswers.approve(id, {
    text: input.text ?? null,
    by: input.by,
  });
  if ("error" in out) return out;
  logEvent("code_answer.approved", { id, edited: out.record.founderEdited });
  return { answer: toCodeAnswerView(out.record) };
}

export function dismissCodeAnswer(
  id: string,
  input: { by?: string; ledger?: Ledger } = {},
): { answer: CodeAnswer } | { error: string } {
  const out = (input.ledger ?? getLedger()).codeAnswers.dismiss(id, { by: input.by });
  if ("error" in out) return out;
  logEvent("code_answer.dismissed", { id });
  return { answer: toCodeAnswerView(out.record) };
}

/**
 * Identity of one derive's inputs: prompt version, the question, the
 * disclosure level, and the files read (by content hash). With no files,
 * the commit stands in: an unresolved "nothing relevant" holds until the
 * code moves.
 */
export function codeAnswerDigest(input: {
  question: string;
  disclosure: string;
  files: readonly CodeAnswerFile[];
  commit: string;
}): string {
  const files = input.files.map((f) => [f.path, f.sha256]).toSorted();
  return sha256(
    JSON.stringify([
      CODE_ANSWER_PROMPT_VERSION,
      normalizeQuestion(input.question),
      input.disclosure,
      files,
      files.length ? null : input.commit,
    ]),
  );
}

/** Re-hash pinned files at `snapshot`'s commit; null entries are missing or now unreadable. */
async function rehash(
  snapshot: SourceSnapshot,
  pinned: readonly CodeAnswerFile[],
): Promise<{ files: CodeAnswerFile[]; changed: boolean }> {
  const files: CodeAnswerFile[] = [];
  let changed = false;
  for (const f of pinned) {
    const content = await snapshot.readFile(f.path);
    if (content == null) {
      changed = true;
      continue;
    }
    const hash = sha256(content);
    if (hash !== f.sha256) changed = true;
    files.push({ path: f.path, sha256: hash });
  }
  return { files, changed };
}

export type DeriveCodeAnswerOutcome = {
  /**
   * `pending`/`unresolved`: freshly derived. `cached`: the same inputs were
   * already answered, nothing spent. `skipped`: nothing to do (decided by
   * the founder, already being read, no repo). `failed`: the repo or the
   * model failed; the row is unchanged and a later sweep retries it.
   */
  status: "pending" | "unresolved" | "cached" | "skipped" | "failed";
  answer: CodeAnswer | null;
  reason?: string;
};

/**
 * Read the code for one question: pick files, read them at one commit,
 * answer, and store the result as `pending` (or `unresolved`, with why).
 * Never throws. Spend-gated by the daily ceiling. Skips the model when the
 * question was already answered from the same file contents, unless
 * `force`. `snapshot` lets a sweep reuse the commit it already resolved.
 */
export async function deriveCodeAnswer(
  id: string,
  opts: {
    cfg?: OneShotConfig;
    ledger?: Ledger;
    force?: boolean;
    snapshot?: SourceSnapshot;
    deps?: CodeAnswerDeps;
  } = {},
): Promise<DeriveCodeAnswerOutcome> {
  const ledger = opts.ledger ?? getLedger();
  const store = ledger.codeAnswers;
  const deps = opts.deps ?? {};
  const now = deps.now ?? (() => new Date());
  const view = (r: CodeAnswerRecord | null) => (r ? toCodeAnswerView(r) : null);
  let record: CodeAnswerRecord | null = null;
  let claimed = false;
  try {
    const cfg = opts.cfg ?? loadConfig();
    record = store.get(id);
    if (!record) return { status: "failed", answer: null, reason: "not found" };
    if (record.status === "approved" || record.status === "dismissed")
      return { status: "skipped", answer: view(record), reason: `already ${record.status}` };
    if (!codeAnswersEnabled(cfg) && !opts.snapshot)
      return { status: "skipped", answer: view(record), reason: "no source repo is connected" };
    if (!store.claimDerive(id, now()))
      return { status: "skipped", answer: view(store.get(id)), reason: "already being read" };
    claimed = true;

    let snapshot = opts.snapshot;
    if (!snapshot) {
      const opened = await (deps.open ?? openSourceRepo)(cfg.sourceRepo);
      if (!opened.ok) return fail(opened.error);
      snapshot = opened.snapshot;
    }
    const disclosure = codeAnswerDisclosure(cfg);

    if (
      !opts.force &&
      record.digest &&
      record.promptVersion === CODE_ANSWER_PROMPT_VERSION &&
      (record.status === "pending" || record.status === "unresolved")
    ) {
      const again = await rehash(snapshot, record.pinned);
      const digest = codeAnswerDigest({
        question: record.question,
        disclosure: disclosure.text,
        files: again.files,
        commit: snapshot.commit,
      });
      if (!again.changed && digest === record.digest) {
        store.pinCommit(id, snapshot.commit, now());
        return { status: "cached", answer: view(store.get(id)) };
      }
    }

    const reservation = tryReserveDailySpend(DERIVE_RESERVATION_USD);
    if (!reservation.granted) return fail(reservation.reason);
    try {
      const paths = await snapshot.listFiles();
      if (!paths.length) return fail(`no readable files at ${snapshot.ref}`);
      const readmePath = paths.find((p) => /^readme(\.[a-z]+)?$/i.test(p));
      const readme = readmePath ? await snapshot.readFile(readmePath) : null;
      const picked = await (deps.pick ?? pickCodeFiles)({
        question: record.question,
        brief: cfg.productBrief,
        paths,
        readme,
      });
      const sources: CodeSource[] = [];
      const files: CodeAnswerFile[] = [];
      for (const path of picked) {
        const content = await snapshot.readFile(path);
        if (content == null) continue;
        sources.push({ path, content });
        files.push({ path, sha256: sha256(content) });
      }
      const result = sources.length
        ? await (deps.answer ?? answerFromCode)({
            question: record.question,
            disclosure: disclosure.text,
            strict: disclosure.strict,
            sources,
          })
        : ({ answered: false, why: "no file in the repo looked related" } as const);
      const stored = store.recordDerive(
        id,
        {
          status: result.answered ? "pending" : "unresolved",
          answer: result.answered ? result.answer : null,
          why: result.answered ? null : result.why,
          files,
          commit: snapshot.commit,
          promptVersion: CODE_ANSWER_PROMPT_VERSION,
          digest: codeAnswerDigest({
            question: record.question,
            disclosure: disclosure.text,
            files,
            commit: snapshot.commit,
          }),
        },
        now(),
      );
      logEvent("code_answer.derived", {
        id,
        status: result.answered ? "pending" : "unresolved",
        files: files.length,
        commit: snapshot.commit.slice(0, 12),
        backend: snapshot.backend,
        rewritten: result.answered ? result.rewritten : false,
        kept: !!stored,
      });
      if (!stored)
        return { status: "skipped", answer: view(store.get(id)), reason: "decided while reading" };
      return { status: result.answered ? "pending" : "unresolved", answer: view(stored) };
    } finally {
      reservation.release();
    }
  } catch (err) {
    return fail((err as Error).message || "derive failed");
  } finally {
    if (claimed) store.releaseDerive(id);
  }

  function fail(reason: string): DeriveCodeAnswerOutcome {
    logEvent("code_answer.derive_failed", { id, message_120: reason.slice(0, 120) }, "warn");
    return { status: "failed", answer: view(store.get(id) ?? record), reason };
  }
}

export interface CodeAnswerSweepResult {
  /** True when no repo is connected: nothing was read. */
  skipped: boolean;
  error?: string;
  commit?: string;
  /** Approved/pending answers whose files were re-hashed at a new commit. */
  checked: number;
  /** Of those, unchanged: carried to the new commit. */
  unchanged: number;
  /** Answers that went stale (out of the brief). */
  stale: number;
  /** Fresh derives started (stale answers, failed or never-read questions, changed unresolved ones). */
  rederived: number;
}

/**
 * The staleness sweep (daily from the scheduler, and on demand). Resolves
 * the ref once (refreshing a local checkout's remote first); an answer
 * already at that commit costs nothing. For the rest, re-hash the files
 * each approved or pending answer was read from: unchanged moves it to the
 * new commit; changed or gone marks it stale (out of the brief) and, unless
 * the founder wrote it, re-derives it into pending for re-approval. Open
 * questions (a derive that failed) and unresolved ones whose files moved
 * are retried too, up to `MAX_SWEEP_REDERIVES`. Never throws.
 */
export async function sweepCodeAnswers(
  opts: { cfg?: OneShotConfig; ledger?: Ledger; deps?: CodeAnswerDeps } = {},
): Promise<CodeAnswerSweepResult> {
  const result: CodeAnswerSweepResult = {
    skipped: false,
    checked: 0,
    unchanged: 0,
    stale: 0,
    rederived: 0,
  };
  try {
    const cfg = opts.cfg ?? loadConfig();
    if (!codeAnswersEnabled(cfg)) return { ...result, skipped: true };
    const ledger = opts.ledger ?? getLedger();
    const store = ledger.codeAnswers;
    const now = opts.deps?.now ?? (() => new Date());
    const rows = store.list();
    if (!rows.some((r) => r.status !== "dismissed")) return { ...result, skipped: true };
    const opened = await (opts.deps?.open ?? openSourceRepo)(cfg.sourceRepo, { fetchRemote: true });
    if (!opened.ok) {
      logEvent("code_answer.sweep_failed", { message_120: opened.error.slice(0, 120) }, "warn");
      return { ...result, error: opened.error };
    }
    const snapshot = opened.snapshot;
    result.commit = snapshot.commit;
    const rederive: string[] = [];
    for (const r of rows) {
      if (r.deriving) continue;
      if (r.status === "open" || (r.status === "stale" && !r.founderEdited)) {
        rederive.push(r.id);
        continue;
      }
      const tracked =
        r.status === "approved" || r.status === "pending" || r.status === "unresolved";
      if (!tracked || !r.pinned.length || r.commit === snapshot.commit) continue;
      const again = await rehash(snapshot, r.pinned);
      if (r.status === "unresolved") {
        if (again.changed) rederive.push(r.id);
        else store.pinCommit(r.id, snapshot.commit, now());
        continue;
      }
      result.checked++;
      if (!again.changed) {
        store.pinCommit(r.id, snapshot.commit, now());
        result.unchanged++;
        continue;
      }
      if (store.markStale(r.id, now())) {
        result.stale++;
        if (!r.founderEdited) rederive.push(r.id);
      }
    }
    for (const id of rederive.slice(0, MAX_SWEEP_REDERIVES)) {
      const out = await deriveCodeAnswer(id, {
        cfg,
        ledger,
        snapshot,
        ...(opts.deps ? { deps: opts.deps } : {}),
      });
      if (out.status === "pending" || out.status === "unresolved") result.rederived++;
    }
    logEvent("code_answer.sweep", {
      commit: snapshot.commit.slice(0, 12),
      checked: result.checked,
      unchanged: result.unchanged,
      stale: result.stale,
      rederived: result.rederived,
    });
    return result;
  } catch (err) {
    return { ...result, error: (err as Error).message || "sweep failed" };
  }
}

/**
 * Can the configured repo be read? Resolves the ref and counts the files
 * the answerer may read. Never throws; the error is a sentence for /setup
 * (private repo without a token, missing folder, unknown ref).
 */
export async function testSourceRepo(
  sourceRepo: OneShotConfig["sourceRepo"] | null | undefined,
  deps: Pick<CodeAnswerDeps, "open"> = {},
): Promise<SourceRepoTestResult> {
  if (!sourceRepo || !codeAnswersEnabled({ sourceRepo }))
    return { ok: false, error: "no source repo is connected" };
  const backend = sourceRepo.path?.trim() ? "local" : "github";
  try {
    const opened = await (deps.open ?? openSourceRepo)(sourceRepo);
    if (!opened.ok) return { ok: false, backend, error: opened.error };
    const { snapshot } = opened;
    const files = await snapshot.listFiles();
    const base = {
      backend: snapshot.backend,
      ref: snapshot.ref,
      commit: snapshot.commit,
      readableFiles: files.length,
    };
    return files.length
      ? { ok: true, ...base }
      : { ok: false, ...base, error: `no readable source files at ${snapshot.ref}` };
  } catch (err) {
    return {
      ok: false,
      backend,
      error: (err as Error).message || "the source repo could not be read",
    };
  }
}
