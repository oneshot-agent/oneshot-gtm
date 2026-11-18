// Copied from second-brain-pack packs/dev-runner/comment-density.ts at f3b9696.
// Change it there and copy it again; the loop's guard applies the same limits.
// How much of a diff's added code is comments. The guard refuses a loop branch
// over the limits; each target repo's CI runs a verbatim copy at
// scripts/comment-density.ts, so this file has no imports.

export interface CommentLimits {
  /** Highest share of added counted lines that may be comments. */
  share: number;
  /** The share is only judged once a diff adds this many counted lines. */
  minLines: number;
  /** Longest run of new comment lines allowed in one place. */
  block: number;
}

export const DEFAULT_COMMENT_LIMITS: CommentLimits = { share: 0.25, minLines: 30, block: 8 };

export const COMMENT_RULE_TEXT =
  'New comments say only why: invariants, security reasons, non-obvious constraints. Leave out history, dates, issue and review-round refs, and anything the code already says; longer explanations belong in a README or doc. Comments the branch did not add are not judged.';

export interface CommentBlock { file: string; line: number; length: number }

export interface CommentDensity {
  code: number;
  /** Comment lines the diff removes from counted files. */
  removedComments: number;
  comments: number;
  share: number;
  blocks: CommentBlock[];
  violations: string[];
}

const C_LIKE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|go)$/;
const HASH = /\.(py|sh|bash)$/;
const EXCLUDED = /(^|\/)(tests?|__tests__|fixtures?|vendor|dist|node_modules|migrations)\/|\.(test|spec)\.[^/.]+$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$|\.generated\.|\.d\.ts$|\.min\.js$/;
// Neither comment nor code: tooling reads these.
const IGNORED = /eslint-(disable|enable)|@ts-(expect-error|ignore|nocheck)|\bnoqa\b|nosemgrep|type:\s*ignore|prettier-ignore|biome-ignore|(istanbul|c8) ignore|shellcheck (disable|source)|BEGIN GENERATED|END GENERATED|LOOKUPS:(START|END)|SPDX-License-Identifier|@license\b/i;

type Kind = 'comment' | 'code' | 'skip';
interface ScanState { block: boolean; doc: string | null; template: boolean }

/** Unescaped backticks: an odd count opens or closes a template literal. */
function backticks(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '`') n++;
  }
  return n;
}

/** Code after the block comment closes makes the line code. */
function afterClose(s: string, end: number): Kind {
  return s.slice(end + 2).trim() ? 'code' : 'comment';
}

function lineKind(ext: 'c' | 'hash', s: string, st: ScanState): Kind {
  let kind: Kind;
  if (ext === 'c') {
    if (st.template) {
      if (backticks(s) % 2) st.template = false;
      return 'code';
    }
    if (st.block) {
      const end = s.indexOf('*/');
      if (end >= 0) st.block = false;
      kind = end >= 0 ? afterClose(s, end) : 'comment';
    } else if (s.startsWith('/*')) {
      const end = s.indexOf('*/', 2);
      if (end < 0) st.block = true;
      kind = end >= 0 ? afterClose(s, end) : 'comment';
    } else if (s.startsWith('//') || s.startsWith('*')) {
      kind = 'comment';
    } else {
      if (backticks(s) % 2) st.template = true;
      kind = 'code';
    }
  } else if (st.doc) {
    // Python docstrings are strings, and some are behaviour (LangChain @tool).
    if (s.includes(st.doc)) st.doc = null;
    return 'skip';
  } else {
    const q = s.match(/^[rRbBuUfF]{0,2}("""|''')/)?.[1];
    if (q) {
      if (s.split(q).length - 1 === 1) st.doc = q;
      return 'skip';
    }
    kind = s.startsWith('#') && !s.startsWith('#!') ? 'comment' : 'code';
  }
  // Tooling reads these; only a comment line can be one.
  return kind === 'comment' && IGNORED.test(s) ? 'skip' : kind;
}

/** `+++ b/path` or Git's quoted `+++ "b/p\303\251th"`; null for a deleted file. */
function headerPath(l: string): string | null {
  const m = l.match(/^\+\+\+ (?:"b\/(.*)"|b\/(.*))$/);
  return m ? (m[1] ?? m[2]) : null;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A code line's code and trailing comment; quotes are tracked so `//` or `#` in a string stays code. */
function splitTrailing(ext: 'c' | 'hash', s: string): { code: string; comment: string } {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ext === 'c' ? ch === '/' && s[i + 1] === '/' : ch === '#' && /\s/.test(s[i - 1] ?? '')) {
      return { code: squash(s.slice(0, i)), comment: squash(s.slice(i)) };
    }
  }
  return { code: squash(s), comment: '' };
}

function kindOf(file: string | null): 'c' | 'hash' | null {
  if (!file || EXCLUDED.test(file)) return null;
  return C_LIKE.test(file) ? 'c' : HASH.test(file) ? 'hash' : null;
}

/** Measure the lines a `git diff -U0 -M` adds; removed lines only matter as the source of moved or edited comments. */
export function commentDensity(diff: string, limits: Partial<CommentLimits> = {}): CommentDensity {
  const lim = { ...DEFAULT_COMMENT_LIMITS, ...limits };
  const lines = diff.split('\n');
  // A comment the diff removes and adds back elsewhere was moved, not written.
  const removed = new Map<string, number>();
  // Trailing comments of removed code lines, by their code, to pair with a re-added line.
  const removedCode = new Map<string, string[]>();
  let removedComments = 0;
  let inHunk = false, oldExt: 'c' | 'hash' | null = null;
  let oldState: ScanState = { block: false, doc: null, template: false };
  for (const l of lines) {
    if (l.startsWith('diff --git ')) { inHunk = false; oldExt = null; }
    else if (!inHunk && l.startsWith('--- ')) oldExt = kindOf(l.startsWith('--- a/') ? l.slice(6) : null);
    else if (l.startsWith('@@ ')) { inHunk = true; oldState = { block: false, doc: null, template: false }; }
    else if (inHunk && l.startsWith('-')) {
      const s = l.slice(1).trim();
      if (!s) continue;
      removed.set(s, (removed.get(s) ?? 0) + 1);
      if (!oldExt) continue;
      const plain = !oldState.block && !oldState.template;
      const kind = lineKind(oldExt, s, oldState);
      if (kind === 'comment') removedComments++;
      else if (kind === 'code' && plain) {
        const { code, comment } = splitTrailing(oldExt, s);
        removedCode.set(code, [...(removedCode.get(code) ?? []), comment]);
      }
    }
  }
  let code = 0, comments = 0;
  const blocks: CommentBlock[] = [];
  let file: string | null = null, ext: 'c' | 'hash' | null = null;
  let lineNo = 0, run: CommentBlock | null = null;
  let state: ScanState = { block: false, doc: null, template: false };
  inHunk = false;
  const close = () => {
    if (run && run.length > lim.block) blocks.push(run);
    run = null;
  };
  for (const l of lines) {
    if (l.startsWith('diff --git ')) { close(); inHunk = false; file = null; ext = null; continue; }
    if (!inHunk && l.startsWith('+++ ')) {
      file = headerPath(l);
      ext = kindOf(file);
      continue;
    }
    const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      close();
      inHunk = true;
      lineNo = Number(hunk[1]);
      state = { block: false, doc: null, template: false };
      continue;
    }
    if (!inHunk) continue;
    if (l.startsWith(' ')) { lineNo++; close(); continue; }
    if (!l.startsWith('+') || !file || !ext) continue;
    const at = lineNo++;
    const s = l.slice(1).trim();
    if (!s) continue;
    const plain = !state.block && !state.template;
    const kind = lineKind(ext, s, state);
    if (kind === 'skip') continue;
    if (kind === 'code') {
      close();
      // Unchanged code whose trailing comment changed is a comment edit, not new code.
      const split = plain ? splitTrailing(ext, s) : null;
      const was = split ? removedCode.get(split.code) : undefined;
      const i = split && was ? was.findIndex((c) => c !== split.comment) : -1;
      if (!split || !was || i < 0) { code++; continue; }
      const [old] = was.splice(i, 1);
      if (old && !IGNORED.test(old)) removedComments++;
      if (split.comment && !IGNORED.test(split.comment)) comments++;
      continue;
    }
    const moved = removed.get(s) ?? 0;
    if (moved) { removed.set(s, moved - 1); continue; }
    comments++;
    if (run) run.length++;
    else run = { file, line: at, length: 1 };
  }
  close();
  const total = code + comments;
  const share = total ? comments / total : 0;
  const violations: string[] = [];
  // Rewriting comments into fewer lines, with no code added, is a trim.
  const trim = code === 0 && comments <= removedComments;
  if (!trim && total >= lim.minLines && share > lim.share) {
    violations.push(`the diff adds ${comments} comment lines to ${code} code lines (${(share * 100).toFixed(1)}%, limit ${Math.round(lim.share * 100)}%)`);
  }
  if (!trim && blocks.length) {
    const named = blocks.slice(0, 5).map((b) => `${b.file}:${b.line} (${b.length} lines)`).join(', ');
    const more = blocks.length > 5 ? ` and ${blocks.length - 5} more` : '';
    violations.push(`comment blocks longer than ${lim.block} lines: ${named}${more}`);
  }
  return { code, removedComments, comments, share, blocks, violations };
}

if ((import.meta as { main?: boolean }).main) {
  const args = process.argv.slice(2);
  const base = args[args.indexOf('--base') + 1];
  if (!args.includes('--base') || !base) {
    console.error('usage: bun comment-density.ts --base <ref>');
    process.exit(2);
  }
  const bun = (globalThis as { Bun?: { spawnSync: (cmd: string[]) => { exitCode: number; stdout: Uint8Array; stderr: Uint8Array } } }).Bun;
  if (!bun) { console.error('comment-density: run with bun'); process.exit(2); }
  const git = bun.spawnSync(['git', 'diff', '-U0', '-M', `${base}...HEAD`]);
  if (git.exitCode !== 0) { console.error(new TextDecoder().decode(git.stderr)); process.exit(2); }
  const r = commentDensity(new TextDecoder().decode(git.stdout));
  console.log(`comment-density: ${r.comments} comment / ${r.code} code lines added (${Math.round(r.share * 100)}%), ${r.removedComments} comment lines removed`);
  if (r.violations.length) {
    for (const v of r.violations) console.log(`FAIL ${v}`);
    console.log(COMMENT_RULE_TEXT);
    process.exit(1);
  }
  console.log('ok');
}
