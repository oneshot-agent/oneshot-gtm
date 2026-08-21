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

export function htmlToText(html: string): string {
  if (!html) return "";
  let s = html;

  // Invisible content first, so its text never leaks into the output. End tags
  // are matched as `</script[^>]*>` — per the HTML spec a close tag may carry
  // whitespace (including newlines) and junk before `>`, and a stricter
  // pattern would leave the element's raw contents in the "text".
  s = removeAll(s, /<script\b[^>]*>[\s\S]*?<\/script[^>]*>/gi);
  s = removeAll(s, /<style\b[^>]*>[\s\S]*?<\/style[^>]*>/gi);
  s = removeAll(s, /<head\b[^>]*>[\s\S]*?<\/head[^>]*>/gi);
  s = removeAll(s, /<!--[\s\S]*?-->/g);

  // Structural breaks → newlines BEFORE stripping tags, so paragraphs survive.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre|table)\s*>/gi, "\n");

  // Everything else is formatting we don't need — to fixpoint, so nested
  // brackets can't reassemble a tag from the pieces of a removed one.
  s = removeAll(s, /<[^>]+>/g);

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
