/**
 * Parse a JSON object out of an LLM response. Handles three shapes in order:
 *   1. A fenced ```json ... ``` block.
 *   2. A raw JSON document (with optional surrounding whitespace).
 *   3. A response with prose before/after — slice between the outer braces.
 *
 * Returns `fallback` when all three attempts fail. The helper exists so every
 * finder/play that asks the LLM for structured JSON doesn't re-implement the
 * same four-step recovery ceremony (there were seven copies of it before).
 */
/**
 * The body of the first ```json … ``` (or bare ```) fence, or null. A linear
 * indexOf scan, not a regex: a lazy match between fences backtracks
 * polynomially on long LLM output with many spaces after an opening fence.
 */
function fencedBody(raw: string): string | null {
  const open = raw.indexOf("```");
  if (open < 0) return null;
  let from = open + 3;
  if (raw.startsWith("json", from)) from += 4;
  const close = raw.indexOf("```", from);
  return close < 0 ? null : raw.slice(from, close);
}

export function tryParseJsonObject<T>(raw: string, fallback: T): T {
  const fenced = fencedBody(raw);
  const candidate = fenced ?? raw;
  const trimmed = candidate.trim();
  if (trimmed.length > 0) {
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      // fall through to brace-slice
    }
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as T;
      } catch {
        // fall through to fallback
      }
    }
  }
  return fallback;
}
