/**
 * Parse a JSON string expected to hold an object. Returns null on invalid
 * JSON or any non-object result (arrays, numbers, strings, null) so callers
 * can fall back to a default instead of crashing on a corrupt row.
 */
export function safeParseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
