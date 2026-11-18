// Copied from second-brain-pack packs/dev-runner/comment-density.ts at 024c10d.
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
  'Keep why: invariants, security reasons, non-obvious constraints. Delete history, dates, issue and review-round refs, and comments that restate the code; longer explanations belong in a README or doc.';

export interface CommentBlock { file: string; line: number; length: number }

export interface CommentDensity {
  code: number;
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

function lineKind(ext: 'c' | 'hash', s: string, state: { block: boolean; doc: string | null }): Kind {
  if (IGNORED.test(s)) return 'skip';
  if (ext === 'c') {
    if (state.block) {
      if (s.includes('*/')) state.block = false;
      return 'comment';
    }
    if (s.startsWith('/*')) {
      if (!s.includes('*/', 2)) state.block = true;
      return 'comment';
    }
    return s.startsWith('//') || s.startsWith('*') ? 'comment' : 'code';
  }
  // Python docstrings are strings, and some are behaviour (LangChain @tool).
  if (state.doc) {
    if (s.includes(state.doc)) state.doc = null;
    return 'skip';
  }
  const q = s.match(/^[rRbBuUfF]{0,2}("""|''')/)?.[1];
  if (q) {
    if (s.split(q).length - 1 === 1) state.doc = q;
    return 'skip';
  }
  return s.startsWith('#') && !s.startsWith('#!') ? 'comment' : 'code';
}

/** Measure the lines a `git diff -U0 -M` adds; removed lines only matter as the source of moved comments. */
export function commentDensity(diff: string, limits: Partial<CommentLimits> = {}): CommentDensity {
  const lim = { ...DEFAULT_COMMENT_LIMITS, ...limits };
  const lines = diff.split('\n');
  // A comment the diff removes and adds back elsewhere was moved, not written.
  const removed = new Map<string, number>();
  for (const l of lines) {
    if (l.startsWith('-') && !l.startsWith('---')) {
      const s = l.slice(1).trim();
      if (s) removed.set(s, (removed.get(s) ?? 0) + 1);
    }
  }
  let code = 0, comments = 0;
  const blocks: CommentBlock[] = [];
  let file: string | null = null, ext: 'c' | 'hash' | null = null;
  let lineNo = 0, run: CommentBlock | null = null;
  let state = { block: false, doc: null as string | null };
  const close = () => {
    if (run && run.length > lim.block) blocks.push(run);
    run = null;
  };
  for (const l of lines) {
    if (l.startsWith('+++ ')) {
      close();
      file = l.startsWith('+++ b/') ? l.slice(6) : null;
      ext = file && !EXCLUDED.test(file) ? (C_LIKE.test(file) ? 'c' : HASH.test(file) ? 'hash' : null) : null;
      continue;
    }
    const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      close();
      lineNo = Number(hunk[1]);
      state = { block: false, doc: null };
      continue;
    }
    if (l.startsWith(' ')) { lineNo++; close(); continue; }
    if (!l.startsWith('+') || !file || !ext) continue;
    const at = lineNo++;
    const s = l.slice(1).trim();
    if (!s) continue;
    const kind = lineKind(ext, s, state);
    if (kind === 'skip') continue;
    if (kind === 'code') { code++; close(); continue; }
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
  if (total >= lim.minLines && share > lim.share) {
    violations.push(`the diff adds ${comments} comment lines to ${code} code lines (${(share * 100).toFixed(1)}%, limit ${Math.round(lim.share * 100)}%)`);
  }
  if (blocks.length) {
    const worst = [...blocks].sort((a, b) => b.length - a.length);
    const named = worst.slice(0, 5).map((b) => `${b.file}:${b.line} (${b.length} lines)`).join(', ');
    const more = worst.length > 5 ? ` and ${worst.length - 5} more` : '';
    violations.push(`comment blocks longer than ${lim.block} lines: ${named}${more}`);
  }
  return { code, comments, share, blocks, violations };
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
  console.log(`comment-density: ${r.comments} comment / ${r.code} code lines added (${Math.round(r.share * 100)}%)`);
  if (r.violations.length) {
    for (const v of r.violations) console.log(`FAIL ${v}`);
    console.log(COMMENT_RULE_TEXT);
    process.exit(1);
  }
  console.log('ok');
}
