/**
 * Dependency-free HTML → readable plain text, for email bodies.
 *
 * Exists because most reply clients mirror the format of the mail they answer,
 * and our outbound is HTML-only (`buildRawMessage` sends `text/html` with no
 * `multipart/alternative`) — so HTML-only replies are the NORMAL case for this
 * tool, and anything that renders or feeds an inbound body (the /inbox page,
 * reply drafting, triage) needs a text form. This is a preview-quality
 * conversion, not an HTML parser: good enough to read and to prompt an LLM
 * with, not a DOM.
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

/**
 * Replace-until-fixpoint. A single `.replace` pass over overlapping constructs
 * can REASSEMBLE the pattern it just removed (`<scr<script>ipt>` → one pass
 * leaves `<script>`), which is both a CodeQL incomplete-sanitization finding
 * and a real extraction bug. Bounded so a pathological input can't loop
 * forever; leftovers past the bound are caught by the final tag strip.
 */
function removeAll(s: string, re: RegExp): string {
  for (let i = 0; i < 10; i++) {
    const next = s.replace(re, "");
    if (next === s) return next;
    s = next;
  }
  return s;
}

/**
 * Remove every `<tag …>…</tag …>` block, contents included. The close tag is
 * located with two `indexOf` calls — the token, then the next `>` — because
 * ANY close-side regex here goes polynomial on input stuffed with `</tag`
 * prefixes (CodeQL js/polynomial-redos; `</script[^>]*>` retries `[^>]*` from
 * every prefix), and email HTML is attacker-supplied. The span between the
 * token and the first `>` is `[^>]*` by construction, so the semantics match
 * the spec-lenient close tag (`</script\t\n bar>` closes). Re-scanning from
 * the top after each removal is the fixpoint property: excising a block must
 * not leave a reassembled opener standing. An unclosed opener (or a close
 * token with no `>` after it) drops to end-of-input — raw script/style text
 * must never leak into the "body".
 */
function stripBlocks(s: string, tag: string): string {
  const open = new RegExp(`<${tag}\\b[^>]*>`, "i");
  const closeToken = `</${tag}`;
  for (let i = 0; i < 100; i++) {
    const o = open.exec(s);
    if (!o) return s;
    const afterOpen = o.index + o[0].length;
    // Per spec, `</script` only closes when followed by whitespace, `/` or
    // `>` — `</scripture>` does NOT end a script element, and treating it as
    // a close would stop stripping early and leak the rest of the script
    // source into the "body". Scan forward past false-prefix candidates.
    const lower = s.toLowerCase();
    let closeAt = lower.indexOf(closeToken, afterOpen);
    while (closeAt !== -1) {
      const next = s[closeAt + closeToken.length] ?? ">";
      if (next === ">" || next === "/" || /\s/.test(next)) break;
      closeAt = lower.indexOf(closeToken, closeAt + closeToken.length);
    }
    const gt = closeAt === -1 ? -1 : s.indexOf(">", closeAt + closeToken.length);
    const end = gt === -1 ? s.length : gt + 1;
    s = s.slice(0, o.index) + s.slice(end);
  }
  return s;
}

/**
 * Remove HTML comments with indexOf scanning — `<!--[\s\S]*?-->` is polynomial
 * on input stuffed with `<!--` openers and no closer (CodeQL
 * js/polynomial-redos), the same trap as the block regexes. An unclosed
 * comment runs to end-of-input, per spec. After a cut the scan backs up 3
 * chars: removing a comment can butt `<!` against `--` and assemble a fresh
 * opener, which must not survive.
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

export function htmlToText(html: string): string {
  if (!html) return "";
  let s = html;

  // Invisible content first, so its text never leaks into the output.
  s = stripBlocks(s, "script");
  s = stripBlocks(s, "style");
  s = stripBlocks(s, "head");
  s = stripComments(s);

  // Structural breaks → newlines BEFORE stripping tags, so paragraphs survive.
  // <br\b[^>]*> — Gmail emits attribute-bearing breaks (<br class="gmail_default">)
  // and a stricter pattern silently joined the words around them.
  s = s.replace(/<br\b[^>]*>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre|table)\s*>/gi, "\n");

  // Everything else TAG-SHAPED is formatting we don't need — to fixpoint, so
  // nested brackets can't reassemble a tag from the pieces of a removed one.
  // Tag-shaped means `</`, `<!` or `<letter…`: a bare `<` in prose
  // ("Revenue < $1m and growth > 20%") is comparison text, and the old
  // `<[^>]+>` ate everything between it and the next `>`.
  s = removeAll(s, /<\/?[a-z!][^>]*>/gi);

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
