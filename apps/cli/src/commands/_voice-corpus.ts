import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

/**
 * The founder's own writing, read from local files, for `config voice`.
 * Two kinds of input, both plain `.md`/`.txt`: posts (`--from`) and messages
 * the founder actually sent to people (`--messages`), which outrank posts
 * for register. Frontmatter-aware without a YAML dependency: a leading `---`
 * block is read line by line for `status:` and `style:` (common static-site
 * and note-taking keys), then dropped; posts marked posted/published rank
 * first, then anything with a style tag, then the rest. A messages file
 * yields each fenced block as one message, or its whole body when it has
 * none. Nothing here knows any particular notes app or folder layout.
 * Everything is capped so the prompt stays a few thousand tokens.
 */

export type CorpusKind = "post" | "dm" | "guide";

export interface CorpusItem {
  path: string;
  kind: CorpusKind;
  text: string;
  /** Lower ranks first. */
  rank: number;
}

const TEXT_EXT = new Set([".md", ".txt", ".markdown"]);
const FRONTMATTER_STATUS_PRIORITY: Record<string, number> = { posted: 0, published: 0, refined: 1 };
/** Trailing editorial sections a vault post carries after the body. */
const TRAILER_RX = /\n#{1,3}\s*(METADATA|Metadata|Notes|NOTES|Strategic Context)\b[\s\S]*$/;

function frontmatter(raw: string): { body: string; status: string | null; style: string | null } {
  if (!raw.startsWith("---")) return { body: raw, status: null, style: null };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { body: raw, status: null, style: null };
  const head = raw.slice(3, end);
  const body = raw.slice(end + 4);
  const pick = (key: string): string | null => {
    const m = new RegExp(`^${key}:\\s*"?([^"\\n]+)"?\\s*$`, "m").exec(head);
    return m?.[1]?.trim() ?? null;
  };
  return { body, status: pick("status"), style: pick("style") };
}

function cleanBody(body: string): string {
  return body
    .replace(TRAILER_RX, "")
    .replace(/^#+\s.*$/gm, "") // headings are scaffolding, not voice
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fencedBlocks(body: string): string[] {
  const out: string[] = [];
  const rx = /```[a-z]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(body)) !== null) {
    const t = m[1]!.trim();
    if (t.length >= 40) out.push(t);
  }
  return out;
}

function walk(root: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (TEXT_EXT.has(extname(name).toLowerCase())) out.push(full);
  }
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Read one path (file or directory) into corpus items. As messages (`dm`),
 * a file yields each fenced block as one item, or its whole cleaned body
 * when it has no fences; as posts, each text file yields one item from its
 * cleaned body.
 */
export function readVoicePath(
  path: string,
  kind: "post" | "dm" = "post",
): { items: CorpusItem[]; files: number } {
  const files: string[] = [];
  try {
    if (statSync(path).isDirectory()) walk(path, files);
    else files.push(path);
  } catch {
    return { items: [], files: 0 };
  }
  const items: CorpusItem[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const fm = frontmatter(raw);
    if (kind === "dm") {
      const blocks = fencedBlocks(fm.body);
      if (blocks.length > 0) {
        for (const block of blocks) items.push({ path: file, kind: "dm", text: block, rank: 0 });
      } else {
        const text = cleanBody(fm.body);
        if (text.length >= 40) items.push({ path: file, kind: "dm", text, rank: 0 });
      }
      continue;
    }
    const text = cleanBody(fm.body);
    if (text.length < 80) continue;
    const statusRank = fm.status ? (FRONTMATTER_STATUS_PRIORITY[fm.status.toLowerCase()] ?? 3) : 3;
    const styleRank = fm.style ? 0 : 1;
    items.push({ path: file, kind: "post", text, rank: statusRank * 2 + styleRank + 1 });
  }
  return { items, files: files.length };
}

/**
 * The corpus for one derivation: every path read, ranked, deduplicated and
 * capped. `guide` (a file the founder wrote about their own style) is
 * carried whole as evidence, capped separately.
 */
export function loadVoiceCorpus(
  paths: readonly string[],
  opts: {
    /** Files or folders of messages the founder sent to people; outrank posts for register. */
    messages?: readonly string[];
    guide?: string;
    maxItems?: number;
    /** Messages are short and many; they take at most this many slots so posts still reach the prompt. */
    maxMessages?: number;
    maxChars?: number;
    maxItemChars?: number;
  } = {},
): { items: CorpusItem[]; guide: string | null; files: number } {
  const maxItems = opts.maxItems ?? 40;
  const maxMessages = opts.maxMessages ?? 12;
  const maxChars = opts.maxChars ?? 24_000;
  const maxItemChars = opts.maxItemChars ?? 1_200;
  const all: CorpusItem[] = [];
  let files = 0;
  for (const p of opts.messages ?? []) {
    const read = readVoicePath(p, "dm");
    all.push(...read.items);
    files += read.files;
  }
  for (const p of paths) {
    const read = readVoicePath(p, "post");
    all.push(...read.items);
    files += read.files;
  }
  const seen = new Set<string>();
  const ranked = all
    .toSorted((a, b) => a.rank - b.rank || a.path.localeCompare(b.path))
    .filter((item) => {
      const key = normalize(item.text).slice(0, 200);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const items: CorpusItem[] = [];
  let chars = 0;
  let messages = 0;
  for (const item of ranked) {
    if (items.length >= maxItems) break;
    if (item.kind === "dm") {
      if (messages >= maxMessages) continue;
      messages++;
    }
    const text =
      item.text.length > maxItemChars
        ? `${item.text.slice(0, maxItemChars).trimEnd()}…`
        : item.text;
    if (chars + text.length > maxChars) continue;
    chars += text.length;
    items.push({ ...item, text });
  }
  let guide: string | null = null;
  if (opts.guide) {
    try {
      guide = cleanBody(frontmatter(readFileSync(opts.guide, "utf8")).body).slice(0, 6_000);
    } catch {
      guide = null;
    }
  }
  return { items, guide, files };
}

/** The user message for `voice-derive`: GUIDE, then POSTS, then DMS, each numbered. */
function numbered(list: CorpusItem[]): string {
  return list.map((i, n) => `${n + 1}. ${i.text.replace(/\n+/g, " / ")}`).join("\n");
}

export function voiceCorpusPrompt(corpus: { items: CorpusItem[]; guide: string | null }): string {
  const posts = corpus.items.filter((i) => i.kind === "post");
  const dms = corpus.items.filter((i) => i.kind === "dm");
  return [
    ...(corpus.guide ? [`GUIDE:\n${corpus.guide}`, ""] : []),
    `POSTS (${posts.length}):`,
    numbered(posts) || "(none)",
    "",
    `DMS (${dms.length}):`,
    numbered(dms) || "(none)",
  ].join("\n");
}

/** A one-line label for a corpus path in the CLI summary. */
export function corpusLabel(path: string): string {
  return basename(path) || path;
}
