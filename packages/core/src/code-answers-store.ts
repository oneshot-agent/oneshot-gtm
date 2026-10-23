import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { CodeAnswer, CodeAnswerStatus } from "@oneshot-gtm/shared-types";

/**
 * Answers from your code. One row per how-it-works question a prospect
 * asked that the product brief does not settle: captured from the reply
 * composer, answered by reading the founder's source repo at one commit,
 * and approved (or edited, or dismissed) by the founder. Only approved rows
 * reach a prompt (`productBriefText`). `files_json` pins each file the
 * answer was read from by content hash, so the staleness sweep can tell an
 * unchanged answer (pin the new commit) from one whose files moved (stale,
 * out of the brief). Table created by `ledger-schema.ts` migration v17.
 *
 * Reading the repo and calling the model live in `@oneshot-gtm/find`
 * (`code-answers.ts`); this store only keeps state and guards transitions.
 */

/**
 * How much an answer may say when the founder has not set
 * `codeAnswerDisclosure`. Answers go into outbound messages, so the default
 * is what a caller of the product can observe, and nothing about how it is
 * built.
 */
export const DEFAULT_CODE_ANSWER_DISCLOSURE =
  "Behaviour only: what a user or caller of the product observes. Never storage, locking, file paths, internal component names or environment.";

/** One file an answer was read from, pinned by the sha256 of its content at `commit`. */
export interface CodeAnswerFile {
  path: string;
  sha256: string;
}

/** The row view plus what only the server needs (file hashes, derive digest). */
export interface CodeAnswerRecord extends CodeAnswer {
  pinned: CodeAnswerFile[];
  promptVersion: string | null;
  digest: string | null;
  threads: string[];
}

interface Row {
  id: string;
  question: string;
  question_key: string;
  status: CodeAnswerStatus;
  answer: string | null;
  founder_edited: number;
  why_unresolved: string | null;
  files_json: string;
  commit_sha: string | null;
  prompt_version: string | null;
  digest: string | null;
  asked_count: number;
  threads_json: string;
  source_thread_key: string | null;
  deriving_at: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

/** A derive older than this is presumed dead (process restart) and may be taken over. */
export const CODE_ANSWER_DERIVE_LEASE_MS = 10 * 60_000;
/** Distinct threads remembered per question; the count keeps going past it. */
const MAX_THREADS = 200;
/** Questions shorter or longer than this are not captured. */
export const CODE_QUESTION_MIN_CHARS = 8;
export const CODE_QUESTION_MAX_CHARS = 500;

/** Statuses a fresh derive may overwrite. Approved and dismissed are the founder's. */
const DERIVABLE: readonly CodeAnswerStatus[] = ["open", "unresolved", "pending", "stale"];

const STOPWORDS = new Set(
  (
    "a an the and or but if of to in on at by for with from into onto about as is are was were be been being " +
    "do does did doing done have has had having can could would should will shall may might must " +
    "you your yours we our us i me my it its this that these those there here what which who whom whose " +
    "how when where why so then than just also any some all each such very really please tell know " +
    "get gets got"
  ).split(" "),
);

/** Lower-cased, punctuation collapsed: the identity of a question. */
export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * A light suffix strip, enough for two phrasings of a question to meet:
 * "handling"/"handles"/"handle", "created"/"create", "retries"/"retry", "boxes"/"box". A
 * trailing "e" goes last so the base form and its inflections agree.
 */
function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && /(?:ss|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** The content words of a question, stemmed: what two phrasings of it share. */
export function questionTerms(question: string): Set<string> {
  return new Set(
    normalizeQuestion(question)
      .split(" ")
      .filter((w) => w && !STOPWORDS.has(w))
      .map(stem),
  );
}

/**
 * Dice overlap of two questions' content words, 0..1. Word order, filler and
 * plurals do not count; a different subject word does.
 */
export function questionSimilarity(a: string, b: string): number {
  const x = questionTerms(a);
  const y = questionTerms(b);
  if (!x.size || !y.size) return normalizeQuestion(a) === normalizeQuestion(b) ? 1 : 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return (2 * shared) / (x.size + y.size);
}

/** At or above this, a captured question folds into the existing row. */
export const NEAR_DUPLICATE_QUESTION = 0.8;

const parse = <T>(raw: string | null, fallback: T): T => {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

function pinnedOf(row: Row): CodeAnswerFile[] {
  const files = parse<unknown>(row.files_json, []);
  if (!Array.isArray(files)) return [];
  return files.filter(
    (f): f is CodeAnswerFile =>
      !!f && typeof f.path === "string" && typeof (f as CodeAnswerFile).sha256 === "string",
  );
}

function toRecord(row: Row, now: number): CodeAnswerRecord {
  const pinned = pinnedOf(row);
  const threads = parse<unknown>(row.threads_json, []);
  return {
    id: row.id,
    question: row.question,
    status: row.status,
    deriving:
      row.deriving_at != null && now - Date.parse(row.deriving_at) < CODE_ANSWER_DERIVE_LEASE_MS,
    answer: row.answer,
    founderEdited: row.founder_edited === 1,
    whyUnresolved: row.why_unresolved,
    files: pinned.map((f) => ({ path: f.path })),
    commit: row.commit_sha,
    askedCount: row.asked_count,
    sourceThreadKey: row.source_thread_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
    pinned,
    promptVersion: row.prompt_version,
    digest: row.digest,
    threads: Array.isArray(threads) ? threads.filter((t) => typeof t === "string") : [],
  };
}

/** The wire view: no hashes, no digest. */
export function toCodeAnswerView(record: CodeAnswerRecord): CodeAnswer {
  const { pinned: _p, promptVersion: _v, digest: _d, threads: _t, ...view } = record;
  return view;
}

/** Review order: what needs the founder first, then what is live, then the rest. */
const STATUS_ORDER: Record<CodeAnswerStatus, number> = {
  pending: 0,
  stale: 1,
  approved: 2,
  open: 3,
  unresolved: 4,
  dismissed: 5,
};

export class CodeAnswerStore {
  constructor(readonly db: Database) {}

  private row(id: string): Row | null {
    return this.db.query<Row, [string]>("SELECT * FROM code_answers WHERE id=?").get(id);
  }

  get(id: string, now = Date.now()): CodeAnswerRecord | null {
    const row = this.row(id);
    return row ? toRecord(row, now) : null;
  }

  /**
   * Record a question. An exact or near-duplicate of an existing question
   * (any status, dismissed included, so a dismissed question is not asked
   * again under new words) bumps that row's count once per thread instead
   * of adding a row. Returns null for text too short or too long to be a
   * question.
   */
  capture(input: {
    question: string;
    threadKey?: string | null;
    now?: Date;
  }): { record: CodeAnswerRecord; created: boolean; bumped: boolean } | null {
    const question = input.question.replace(/\s+/g, " ").trim();
    if (question.length < CODE_QUESTION_MIN_CHARS || question.length > CODE_QUESTION_MAX_CHARS)
      return null;
    const key = normalizeQuestion(question);
    if (!key) return null;
    const now = input.now ?? new Date();
    const iso = now.toISOString();
    const thread = input.threadKey?.trim() || null;
    const tx = this.db.transaction(() => {
      const existing = this.findSimilar(question, key);
      if (existing) {
        const threads = parse<string[]>(existing.threads_json, []);
        const seen = thread != null && threads.includes(thread);
        if (seen) return { id: existing.id, created: false, bumped: false };
        const next = thread ? [...threads, thread].slice(-MAX_THREADS) : threads;
        this.db
          .query(
            "UPDATE code_answers SET asked_count=asked_count+1, threads_json=?, source_thread_key=COALESCE(source_thread_key, ?), updated_at=? WHERE id=?",
          )
          .run(JSON.stringify(next), thread, iso, existing.id);
        return { id: existing.id, created: false, bumped: true };
      }
      const id = randomUUID();
      this.db
        .query(
          `INSERT INTO code_answers(id, question, question_key, status, threads_json, source_thread_key, created_at, updated_at)
           VALUES (?,?,?,'open',?,?,?,?)`,
        )
        .run(id, question, key, JSON.stringify(thread ? [thread] : []), thread, iso, iso);
      return { id, created: true, bumped: false };
    });
    const out = tx();
    return { record: this.get(out.id, now.getTime())!, created: out.created, bumped: out.bumped };
  }

  private findSimilar(question: string, key: string): Row | null {
    const exact = this.db
      .query<Row, [string]>("SELECT * FROM code_answers WHERE question_key=?")
      .get(key);
    if (exact) return exact;
    let best: { row: Row; score: number } | null = null;
    for (const row of this.db.query<Row, []>("SELECT * FROM code_answers").all()) {
      const score = questionSimilarity(question, row.question);
      if (score >= NEAR_DUPLICATE_QUESTION && (!best || score > best.score)) best = { row, score };
    }
    return best?.row ?? null;
  }

  list(filter: { status?: CodeAnswerStatus } = {}, now = Date.now()): CodeAnswerRecord[] {
    const rows = filter.status
      ? this.db.query<Row, [string]>("SELECT * FROM code_answers WHERE status=?").all(filter.status)
      : this.db.query<Row, []>("SELECT * FROM code_answers").all();
    return rows
      .map((r) => toRecord(r, now))
      .toSorted(
        (a, b) =>
          STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
          b.askedCount - a.askedCount ||
          b.updatedAt.localeCompare(a.updatedAt),
      );
  }

  /** Questions this reply thread asked, for the composer card. */
  forThread(threadKey: string, now = Date.now()): CodeAnswerRecord[] {
    return this.db
      .query<Row, [string]>(
        "SELECT * FROM code_answers WHERE EXISTS (SELECT 1 FROM json_each(code_answers.threads_json) WHERE value=?) ORDER BY updated_at DESC",
      )
      .all(threadKey)
      .map((r) => toRecord(r, now));
  }

  /** Approved answers, oldest approval first: what the brief carries. */
  approved(): Array<{ question: string; answer: string }> {
    return this.db
      .query<{ question: string; answer: string }, []>(
        "SELECT question, answer FROM code_answers WHERE status='approved' AND answer IS NOT NULL AND trim(answer)<>'' ORDER BY decided_at, rowid",
      )
      .all();
  }

  /**
   * Take the derive lease. False when another derive holds a fresh one, or
   * the row is approved or dismissed (the founder's decision stands).
   */
  claimDerive(id: string, now = new Date()): boolean {
    const cutoff = new Date(now.getTime() - CODE_ANSWER_DERIVE_LEASE_MS).toISOString();
    return (
      this.db
        .query(
          `UPDATE code_answers SET deriving_at=?
            WHERE id=? AND status IN (${DERIVABLE.map(() => "?").join(",")})
              AND (deriving_at IS NULL OR deriving_at < ?)`,
        )
        .run(now.toISOString(), id, ...DERIVABLE, cutoff).changes > 0
    );
  }

  releaseDerive(id: string): void {
    this.db.query("UPDATE code_answers SET deriving_at=NULL WHERE id=?").run(id);
  }

  /**
   * Store a derive's outcome. Guarded: a row the founder approved or
   * dismissed while the code was being read keeps that decision. A fresh
   * answer replaces the text and clears `founder_edited`.
   */
  recordDerive(
    id: string,
    result: {
      status: "pending" | "unresolved";
      answer?: string | null;
      why?: string | null;
      files: CodeAnswerFile[];
      commit: string;
      promptVersion: string;
      digest: string;
    },
    now = new Date(),
  ): CodeAnswerRecord | null {
    const iso = now.toISOString();
    const changes = this.db
      .query(
        `UPDATE code_answers
            SET status=?, answer=?, founder_edited=0, why_unresolved=?, files_json=?, commit_sha=?,
                prompt_version=?, digest=?, deriving_at=NULL, updated_at=?, decided_at=NULL, decided_by=NULL
          WHERE id=? AND status IN (${DERIVABLE.map(() => "?").join(",")})`,
      )
      .run(
        result.status,
        result.status === "pending" ? (result.answer ?? null) : null,
        result.status === "unresolved" ? (result.why ?? null) : null,
        JSON.stringify(result.files),
        result.commit,
        result.promptVersion,
        result.digest,
        iso,
        id,
        ...DERIVABLE,
      ).changes;
    if (!changes) return null;
    return this.get(id, now.getTime());
  }

  /** The files are unchanged at a newer commit: carry the answer forward. */
  pinCommit(id: string, commit: string, now = new Date()): void {
    this.db
      .query(
        "UPDATE code_answers SET commit_sha=?, updated_at=? WHERE id=? AND commit_sha IS NOT ?",
      )
      .run(commit, now.toISOString(), id, commit);
  }

  /**
   * Files behind an approved or pending answer changed: it leaves the brief.
   * The text stays for reference until a fresh derive replaces it.
   */
  markStale(id: string, now = new Date()): boolean {
    return (
      this.db
        .query(
          "UPDATE code_answers SET status='stale', updated_at=? WHERE id=? AND status IN ('approved','pending')",
        )
        .run(now.toISOString(), id).changes > 0
    );
  }

  /**
   * Approve an answer into the brief, optionally with the founder's own
   * text. A pending answer may be approved as written; anything else
   * (unresolved, stale, still open) needs the founder's text, and then no
   * file pins it: it is their statement, not one read from the code.
   */
  approve(
    id: string,
    input: { text?: string | null; by: string; now?: Date },
  ): { record: CodeAnswerRecord } | { error: string } {
    const existing = this.row(id);
    if (!existing) return { error: `code answer '${id}' not found` };
    const now = input.now ?? new Date();
    const text = input.text?.trim() || null;
    if (text && text.length > 1200)
      return { error: "the answer is too long (1200 characters at most)" };
    // The brief's link allow-list is the founder's brief alone; an answer
    // that carried a link would make it citable through the back door.
    if (/https?:\/\/|\bwww\./i.test(text ?? existing.answer ?? ""))
      return { error: "links belong in the product brief, not in an answer from the code" };
    if (existing.status === "approved" || existing.status === "dismissed")
      return { error: `this answer is already ${existing.status}` };
    if (existing.status !== "pending" && !text)
      return { error: `this question is ${existing.status}: write the answer to approve it` };
    const edited = !!text && text !== (existing.answer ?? "").trim();
    const ownWords = existing.status !== "pending";
    const changes = this.db
      .query(
        `UPDATE code_answers
            SET status='approved', answer=COALESCE(?, answer), founder_edited=?, why_unresolved=NULL,
                ${ownWords ? "files_json='[]', digest=NULL," : ""}
                updated_at=?, decided_at=?, decided_by=?
          WHERE id=? AND status=?`,
      )
      .run(
        text,
        edited ? 1 : 0,
        now.toISOString(),
        now.toISOString(),
        input.by,
        id,
        existing.status,
      ).changes;
    if (!changes) return { error: "this answer changed while you were deciding; reload it" };
    return { record: this.get(id, now.getTime())! };
  }

  /** The founder does not want this question answered from the code. Any status but dismissed. */
  dismiss(
    id: string,
    input: { by?: string; now?: Date } = {},
  ): { record: CodeAnswerRecord } | { error: string } {
    const existing = this.row(id);
    if (!existing) return { error: `code answer '${id}' not found` };
    if (existing.status === "dismissed") return { error: "this answer is already dismissed" };
    const now = input.now ?? new Date();
    this.db
      .query(
        "UPDATE code_answers SET status='dismissed', updated_at=?, decided_at=?, decided_by=? WHERE id=?",
      )
      .run(now.toISOString(), now.toISOString(), input.by ?? null, id);
    return { record: this.get(id, now.getTime())! };
  }
}
