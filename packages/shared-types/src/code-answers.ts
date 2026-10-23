/**
 * Answers from your code. A how-it-works question a prospect asked, that the
 * product brief does not answer, is read against the founder's connected
 * source repo (`OneShotConfig.sourceRepo`) and answered in a sentence or two.
 * Nothing reaches a prompt until the founder approves it; an approved answer
 * goes `stale` and drops out of the brief when the files it was read from
 * change.
 */

/**
 * `open`: captured, not read yet (or being read). `unresolved`: the code did
 * not settle it (see `whyUnresolved`). `pending`: answered, waiting for the
 * founder. `approved`: in the brief. `dismissed`: the founder said no.
 * `stale`: the files it was read from changed since it was approved; it is
 * out of the brief until a fresh answer is approved.
 */
export type CodeAnswerStatus =
  | "open"
  | "unresolved"
  | "pending"
  | "approved"
  | "dismissed"
  | "stale";

export interface CodeAnswer {
  id: string;
  question: string;
  status: CodeAnswerStatus;
  /** The answer text (the founder's edit when `founderEdited`). Null while open or unresolved. */
  answer: string | null;
  founderEdited: boolean;
  /** Why the code did not settle the question, when `unresolved`. */
  whyUnresolved: string | null;
  /** Files the answer was read from (paths only; contents never leave the server). */
  files: Array<{ path: string }>;
  /** The commit the answer was read at (full sha). */
  commit: string | null;
  /** How many times prospects have asked this question (near-duplicates included). */
  askedCount: number;
  /** The reply thread that first asked it, when it came from the composer. */
  sourceThreadKey: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
}

/** Result of `testSourceRepo`: can the configured repo be read? */
export interface SourceRepoTestResult {
  ok: boolean;
  /** Which reader was used, when a repo is configured. */
  backend?: "github" | "local";
  /** The ref that was resolved (the default branch when none is set). */
  ref?: string;
  commit?: string;
  /** Files the answerer may read (after the vendored/secret/binary filter). */
  readableFiles?: number;
  error?: string;
}
