/**
 * Dependency-free HTML → readable plain text for email bodies. Preview-quality
 * conversion, not a DOM.
 *
 * Everything here is a single-pass left-to-right builder over indexOf, by
 * design: every regex-with-a-middle over attacker-supplied HTML goes
 * polynomial, and iteration-capped replace loops leak whatever lies past the
 * cap. A bounded fixpoint handles reassembly (removing a span can butt `<scr`
 * against `ipt>`), and a truncation guard makes "an opener never survives" a
 * hard invariant.
 */

/** Named entities that actually occur in mail bodies; everything else numeric. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

/** Spec tag-name boundary: `</script` closes only before whitespace, `/` or `>`. */
function isTagBoundary(ch: string | undefined): boolean {
  return ch === undefined || ch === ">" || ch === "/" || /\s/.test(ch);
}

/**
 * Find the next REAL `<tag` / `</tag` token at or after `from`: the name must
 * end at a tag boundary, so `<script-widget>` is a custom element, not a
 * `<script>` (a `\b` regex boundary matches at the hyphen and got this wrong).
 */
function findToken(lower: string, token: string, from: number): number {
  let i = lower.indexOf(token, from);
  while (i !== -1) {
    if (isTagBoundary(lower[i + token.length])) return i;
    i = lower.indexOf(token, i + token.length);
  }
  return -1;
}

/**
 * One left-to-right pass removing every `<tag …>…</tag …>` block, contents
 * included — no iteration cap to leak the N+1th block. Unterminated opener or
 * missing close drops to end-of-input: raw script/style text must never leak.
 */
function stripBlocksOnce(s: string, tag: string): string {
  const lower = s.toLowerCase();
  const openTok = `<${tag}`;
  const closeTok = `</${tag}`;
  let out = "";
  let i = 0;
  while (i < s.length) {
    const o = findToken(lower, openTok, i);
    if (o === -1) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, o);
    const openEnd = s.indexOf(">", o + openTok.length);
    if (openEnd === -1) break; // unterminated opener: rest is inside the tag
    const c = findToken(lower, closeTok, openEnd + 1);
    if (c === -1) break; // unclosed element: content runs to end-of-input
    const gt = s.indexOf(">", c + closeTok.length);
    if (gt === -1) break;
    i = gt + 1;
  }
  return out;
}

/**
 * stripBlocksOnce to a bounded fixpoint — excising a span can reassemble an
 * opener from the flanking pieces. Any opener surviving the bound truncates
 * the output there: "no <tag content in the result" is an invariant.
 */
function stripBlocks(s: string, tag: string): string {
  for (let pass = 0; pass < 10; pass++) {
    const next = stripBlocksOnce(s, tag);
    if (next === s) break;
    s = next;
  }
  const survivor = findToken(s.toLowerCase(), `<${tag}`, 0);
  return survivor === -1 ? s : s.slice(0, survivor);
}

/**
 * Remove HTML comments in one pass. An unclosed comment runs to end-of-input,
 * per spec. After a cut the scan backs up 3 chars: removing a comment can butt
 * `<!` against `--` and assemble a fresh opener, which must not survive.
 */
function stripComments(s: string): string {
  let from = 0;
  while (true) {
    const open = s.indexOf("<!--", from);
    if (open === -1) return s;
    const close = s.indexOf("-->", open + 4);
    const end = close === -1 ? s.length : close + 3;
    s = s.slice(0, open) + s.slice(end);
    from = Math.max(0, open - 3);
  }
}

/** Tags whose end (or, for <br>, presence) is a paragraph/line break. */
const BREAK_CLOSERS = new Set([
  "p",
  "div",
  "tr",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "table",
]);

/**
 * `\n` for structural tags, `""` for the rest. Runs on one already-isolated
 * span so it adds nothing to the pass's complexity (a `<br\b[^>]*>` replace
 * regex here is quadratic). Gmail's attribute-bearing breaks still break.
 */
function tagReplacement(tagBody: string): string {
  const t = tagBody.toLowerCase();
  if (/^br(?![a-z0-9-])/.test(t)) return "\n";
  const close = /^\/([a-z][a-z0-9]*)\s*$/.exec(t);
  return close?.[1] && BREAK_CLOSERS.has(close[1]) ? "\n" : "";
}

/**
 * One pass dropping every TAG-SHAPED span (`<` + letter/`!`/`/`, through the
 * next `>`); structural tags leave a newline. A bare `<` in prose passes
 * through; an unterminated tag drops the rest (inside the tag, per spec).
 */
function stripTagsOnce(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt === -1) {
      out += s.slice(i);
      break;
    }
    const next = s[lt + 1] ?? "";
    if (!/[a-z!/]/i.test(next)) {
      out += s.slice(i, lt + 1);
      i = lt + 1;
      continue;
    }
    const gt = s.indexOf(">", lt + 2);
    out += s.slice(i, lt);
    if (gt === -1) break;
    out += tagReplacement(s.slice(lt + 1, gt));
    i = gt + 1;
  }
  return out;
}

export function htmlToText(html: string): string {
  if (!html) return "";
  let s = html;

  // Invisible content first, so its text never leaks into the output.
  s = stripBlocks(s, "script");
  s = stripBlocks(s, "style");
  s = stripBlocks(s, "head");
  s = stripComments(s);

  // Tag-shaped spans go, structural ones leave a newline — to a bounded
  // fixpoint (nested brackets can reassemble a tag from the pieces of a
  // removed one; leftovers past the bound are inert prose — script/style
  // content is already gone).
  for (let pass = 0; pass < 10; pass++) {
    const next = stripTagsOnce(s);
    if (next === s) break;
    s = next;
  }

  s = decodeEntities(s);

  // Windows newlines, per-line trim of trailing space, collapse blank runs.
  s = s.replace(/\r\n?/g, "\n");
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "").replace(/^[ \t]+/g, ""))
    .join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}
