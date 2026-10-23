import type { CodeAnswer, CodeAnswerStatus, SetupRequest } from "@oneshot-gtm/shared-types";

/**
 * Answers from your code, as /setup and the reply composer show them. Pure
 * helpers so the ordering, the composer card's state and the form mapping
 * are testable without rendering.
 */

/** /setup order: what needs the founder first, then what is in the brief, then the rest. */
const ORDER: Record<CodeAnswerStatus, number> = {
  pending: 0,
  open: 1,
  approved: 2,
  stale: 3,
  unresolved: 4,
  dismissed: 5,
};

export function sortCodeAnswers(answers: readonly CodeAnswer[]): CodeAnswer[] {
  return answers
    .filter((a) => a.status !== "dismissed")
    .toSorted(
      (a, b) =>
        ORDER[a.status] - ORDER[b.status] ||
        b.askedCount - a.askedCount ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
}

/** Reading the code: captured and not answered yet, or a re-read in flight. */
export function isReading(a: CodeAnswer): boolean {
  return a.deriving || a.status === "open";
}

/** The answer this conversation asked for: the id its drafts carry, else the latest it first asked. */
export function threadCodeAnswer(
  answers: readonly CodeAnswer[],
  threadKey: string,
  id?: string | null,
): CodeAnswer | null {
  const byId = id ? answers.find((a) => a.id === id) : undefined;
  if (byId) return byId;
  return (
    answers
      .filter((a) => a.sourceThreadKey === threadKey && a.status !== "dismissed")
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
  );
}

export type ComposerCodeAnswerState = "reading" | "pending" | "unresolved" | null;

/** What the composer shows: nothing once approved (it is in the brief), dismissed or stale. */
export function composerCodeAnswerState(a: CodeAnswer | null): ComposerCodeAnswerState {
  if (!a) return null;
  if (isReading(a)) return "reading";
  if (a.status === "pending" && a.answer) return "pending";
  if (a.status === "unresolved") return "unresolved";
  return null;
}

export function shortCommit(commit: string | null): string | null {
  return commit ? commit.slice(0, 7) : null;
}

export function askedLabel(count: number): string {
  return count <= 1 ? "asked once" : `asked ${count} times`;
}

export function codeAnswerStatusLabel(a: CodeAnswer): string {
  if (isReading(a)) return "reading your code";
  switch (a.status) {
    case "pending":
      return "to review";
    case "approved":
      return a.founderEdited ? "in the brief · edited" : "in the brief";
    case "stale":
      return "code changed · out of the brief";
    case "unresolved":
      return "not settled by the code";
    default:
      return a.status;
  }
}

/** A GitHub repo URL, with or without the scheme. Anything else is read as a local path. */
export function looksLikeRepoUrl(value: string): boolean {
  return /^(https?:\/\/)?(www\.)?github\.com\//i.test(value.trim());
}

/** The single "repo" form field and its ref, as the setup request carries them. */
export function sourceRepoRequest(repo: string, ref: string): SetupRequest["sourceRepo"] {
  const value = repo.trim();
  if (!value) return null;
  const r = ref.trim();
  const withRef = r ? { ref: r } : {};
  if (looksLikeRepoUrl(value))
    return { url: /^https?:\/\//i.test(value) ? value : `https://${value}`, ...withRef };
  return { path: value, ...withRef };
}

/** The form's value for a saved repo: the local path when both are set (it wins), else the URL. */
export function sourceRepoField(repo: { url?: string; path?: string } | undefined): string {
  return repo?.path ?? repo?.url ?? "";
}

export function sourceRepoError(repo: string): string | null {
  const value = repo.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value) && !looksLikeRepoUrl(value))
    return "Only GitHub URLs are read. For another host, use a local checkout's path.";
  if (looksLikeRepoUrl(value)) {
    const parts = value
      .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "")
      .replace(/\.git$/i, "")
      .split("/")
      .filter(Boolean);
    return parts.length === 2 ? null : "Use the repo's URL: https://github.com/owner/repo";
  }
  return value.startsWith("/") || value.startsWith("~")
    ? null
    : "Use a GitHub URL or the absolute path of a local checkout.";
}
