/**
 * Pure parser for strategist ACTION markers. Lives outside the React
 * component so it can be unit-tested without rendering anything — and so
 * the regex's correctness is locked down (a previous version excluded `-`
 * from the trigger-name capture, silently breaking every multi-word
 * trigger).
 */

type StrategistActionKind = "enable" | "disable" | "apply-config";

export interface ParsedStrategistAction {
  kind: StrategistActionKind;
  trigger: string;
  /** Only present when kind === "apply-config" and the JSON parsed cleanly. */
  config?: Record<string, unknown>;
}

/**
 * Trigger names contain hyphens (post-funding-auto, github-topics, show-hn).
 * `[^:>]+?` is the only correct character class — earlier `[^:>-]+` excluded
 * `-` and silently broke every multi-word trigger. The trigger name capture
 * stops at the first `:` (which separates the optional JSON config) or `>`.
 *
 * Non-greedy `+?` on the trigger name + non-greedy `*?` on the JSON capture
 * handle JSON with multiple `-->` substrings (rare, but possible if a vendor
 * name contains them).
 */
const ACTION_RE = /<!--ACTION:(enable|disable|apply-config):([^:>]+?)(?::([\s\S]*?))?-->/;

/**
 * Looser match for partial markers mid-stream. Used to strip "<!--ACTION:..."
 * fragments from displayed text before the closing `-->` arrives, so the
 * founder doesn't see marker scaffolding flicker into view as the SSE
 * stream paints chunk by chunk.
 */
const PARTIAL_ACTION_RE = /<!--ACTION:[\s\S]*$/;

export function parseStrategistAction(text: string): ParsedStrategistAction | null {
  const m = text.match(ACTION_RE);
  if (!m) return null;
  const kind = m[1] as StrategistActionKind;
  const trigger = (m[2] ?? "").trim();
  if (!trigger) return null;
  const rawConfig = m[3] ?? "";
  if (kind === "apply-config") {
    try {
      const config = JSON.parse(rawConfig) as Record<string, unknown>;
      // Guard against null / non-object payloads — JSON.parse("null") returns
      // null, which TS sees as an object but is useless to the consumer.
      if (!config || typeof config !== "object" || Array.isArray(config)) return null;
      return { kind, trigger, config };
    } catch {
      return null;
    }
  }
  return { kind, trigger };
}

/**
 * Strip both complete and partial ACTION markers from a piece of streamed
 * assistant text, leaving only the founder-facing prose.
 */
export function stripActionMarkers(text: string): string {
  return text.replace(ACTION_RE, "").replace(PARTIAL_ACTION_RE, "").trim();
}
