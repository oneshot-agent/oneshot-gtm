import { complete, loadPrompt, tryParseJsonObject, type LlmMessage } from "@oneshot-gtm/intel";

/**
 * The two model steps behind "answers from your code": pick the files that
 * bear on a prospect's how-it-works question, then answer it from those
 * files alone. Reading the repo and keeping state happen in
 * `@oneshot-gtm/find` (`code-answers.ts`); nothing here touches either.
 *
 * Bump `CODE_ANSWER_PROMPT_VERSION` when `code-answer.md`,
 * `code-answer-files.md` or the disclosure check changes what an answer may
 * say: cached pending and unresolved results re-derive on the next read.
 * Approved answers are never re-derived for a version bump; the founder
 * approved their text.
 */
export const CODE_ANSWER_PROMPT_VERSION = "code-answer-v1";

/** Files the answerer reads per question. */
export const MAX_CODE_ANSWER_FILES = 8;
/** One file's share of the source budget; the rest of a longer file is cut. */
const MAX_FILE_CHARS = 40_000;
/** All source handed to the answer step together. */
const MAX_SOURCE_CHARS = 160_000;
/** The path list the picker sees; a larger repo keeps its shallowest source paths. */
const MAX_PATH_LIST_CHARS = 60_000;
const MAX_README_CHARS = 3_000;
/** Longest answer kept. Two sentences fit well inside it. */
export const MAX_CODE_ANSWER_CHARS = 600;

export interface CodeSource {
  path: string;
  content: string;
}

/**
 * Deterministic checks on an answer, beside the prompt's own rules and the
 * founder's review. Always: length, code, file paths, environment-style
 * identifiers, anything shaped like a credential. Under the default
 * disclosure (`strict`), also words that name how the product is built.
 * A founder who set a looser disclosure level has said such words are fine.
 */
export function disclosureViolations(text: string, opts: { strict?: boolean } = {}): string[] {
  const flags: string[] = [];
  if (text.length > MAX_CODE_ANSWER_CHARS) flags.push("answer exceeds length limit");
  if (/```|`[^`]+`/.test(text)) flags.push("code in the answer");
  if (
    /(?:^|[\s(])(?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,5}\b/i.test(text) ||
    /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|cs|php|sql|sh|ya?ml|toml)\b/i.test(
      text,
    )
  )
    flags.push("source path");
  if (/\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/.test(text)) flags.push("environment or config identifier");
  if (
    text
      .split(/[^A-Za-z0-9_+/=-]+/)
      .some((t) => t.length >= 32 && /\d/.test(t) && /[A-Za-z]/.test(t))
  )
    flags.push("credential-shaped string");
  if (
    opts.strict !== false &&
    /\b(?:databases?|sql|row[ -]locks?|locking|mutex(?:es)?|semaphores?|cach(?:e[ds]?|ing)|middleware|orchestrators?|environment variables?|env vars?|config(?:uration)? files?)\b/i.test(
      text,
    )
  )
    flags.push("internal implementation detail");
  return flags;
}

/** Rank paths so a capped list keeps implementation code: shallow, non-test, non-doc first. */
function pathRank(path: string): number {
  const lower = path.toLowerCase();
  let rank = path.split("/").length;
  if (
    /(^|\/)(__tests__|tests?|spec|specs|fixtures?|__mocks__|e2e)(\/|$)|\.(test|spec)\./.test(lower)
  )
    rank += 4;
  if (/(^|\/)(docs?|examples?|samples?|demo|scripts?)(\/|$)/.test(lower)) rank += 3;
  if (/\.(md|mdx|txt|rst|json|ya?ml|toml|csv|html|css|scss)$/.test(lower)) rank += 2;
  return rank;
}

/** The paths the picker sees, within the list budget, in repo order. */
export function pathsForPicker(paths: readonly string[]): string[] {
  let total = paths.reduce((n, p) => n + p.length + 1, 0);
  if (total <= MAX_PATH_LIST_CHARS) return [...paths];
  const keep = new Set<string>();
  total = 0;
  for (const p of paths.toSorted((a, b) => pathRank(a) - pathRank(b) || a.localeCompare(b))) {
    if (total + p.length + 1 > MAX_PATH_LIST_CHARS) break;
    keep.add(p);
    total += p.length + 1;
  }
  return paths.filter((p) => keep.has(p));
}

/**
 * Step one: which files would settle the question. Returns paths from
 * `paths` only (anything the model invents is dropped), at most
 * `MAX_CODE_ANSWER_FILES`, possibly none.
 */
export async function pickCodeFiles(input: {
  question: string;
  brief: string | null;
  paths: readonly string[];
  readme?: string | null;
}): Promise<string[]> {
  const shown = pathsForPicker(input.paths);
  const allowed = new Set(shown);
  const user = [
    `QUESTION: ${input.question}`,
    `PRODUCT BRIEF:\n${(input.brief ?? "").trim() || "(none)"}`,
    ...(input.readme?.trim() ? [`README:\n${input.readme.trim().slice(0, MAX_README_CHARS)}`] : []),
    `FILES:\n${shown.join("\n")}`,
  ].join("\n\n");
  const response = await complete({
    messages: [
      { role: "system", content: loadPrompt("code-answer-files") },
      { role: "user", content: user },
    ],
    temperature: 0,
    maxTokens: 500,
    timeoutMs: 60_000,
  });
  const parsed = tryParseJsonObject<{ files?: unknown }>(response.content, {});
  const files = Array.isArray(parsed.files) ? parsed.files : [];
  const out: string[] = [];
  for (const f of files) {
    if (typeof f !== "string") continue;
    const path = f.trim().replace(/^\.?\//, "");
    if (allowed.has(path) && !out.includes(path)) out.push(path);
    if (out.length >= MAX_CODE_ANSWER_FILES) break;
  }
  return out;
}

/** The SOURCE block: each file under its path, cut to the budgets. */
export function sourceBlock(sources: readonly CodeSource[]): string {
  let left = MAX_SOURCE_CHARS;
  const parts: string[] = [];
  for (const s of sources) {
    if (left <= 0) break;
    const cap = Math.min(MAX_FILE_CHARS, left);
    const body = s.content.length > cap ? `${s.content.slice(0, cap)}\n[… cut]` : s.content;
    parts.push(`----- ${s.path} -----\n${body}`);
    left -= body.length;
  }
  return parts.join("\n\n");
}

export type CodeAnswerResult =
  | { answered: true; answer: string; rewritten: boolean }
  | { answered: false; why: string };

const REWRITE_INSTRUCTION = (flags: string[]) =>
  `The answer broke the disclosure rules: ${flags.join(", ")}. Rewrite only the behaviour a user or caller observes, in at most two sentences of plain prose. Name no storage, components, files, identifiers or configuration. Keep every condition and limitation the source shows; add no new guarantee. Return the same JSON format.`;

/**
 * Step two: answer from the source. Temperature 0. One corrective turn
 * when the first answer breaks the disclosure check; a second break comes
 * back unresolved with the reason, never as an answer.
 */
export async function answerFromCode(input: {
  question: string;
  disclosure: string;
  /** True under the default disclosure level (see `disclosureViolations`). */
  strict: boolean;
  sources: readonly CodeSource[];
}): Promise<CodeAnswerResult> {
  const messages: LlmMessage[] = [
    { role: "system", content: loadPrompt("code-answer") },
    {
      role: "user",
      content: [
        `QUESTION: ${input.question}`,
        `DISCLOSURE LEVEL: ${input.disclosure}`,
        `SOURCE:\n${sourceBlock(input.sources)}`,
      ].join("\n\n"),
    },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await complete({
      messages,
      temperature: 0,
      maxTokens: 800,
      timeoutMs: 90_000,
    });
    const parsed = tryParseJsonObject<Record<string, unknown>>(response.content, {});
    const note = typeof parsed.note === "string" ? parsed.note.replace(/\s+/g, " ").trim() : "";
    if (parsed.answered === true && note) {
      const flags = disclosureViolations(note, { strict: input.strict });
      if (!flags.length) return { answered: true, answer: note, rewritten: attempt > 0 };
      if (attempt === 0) {
        messages.push(
          { role: "assistant", content: response.content },
          { role: "user", content: REWRITE_INSTRUCTION(flags) },
        );
        continue;
      }
      return {
        answered: false,
        why: `the answer kept breaking the disclosure rules (${flags.join(", ")})`,
      };
    }
    const why = typeof parsed.why === "string" ? parsed.why.trim() : "";
    return { answered: false, why: why || "the model returned no usable answer" };
  }
  return { answered: false, why: "the model returned no usable answer" };
}
