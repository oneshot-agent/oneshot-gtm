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
export function tryParseJsonObject<T>(raw: string, fallback: T): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw) ?? "";
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
