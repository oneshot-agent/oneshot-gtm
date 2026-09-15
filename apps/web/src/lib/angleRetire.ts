import type { AngleUsageView, TriggerView } from "@oneshot-gtm/shared-types";

/**
 * Retiring an angle from a trigger's edge, done inside the config editor's
 * textarea so the founder's existing **save** is the only write. Nothing here
 * touches the server.
 */

const ANGLE_SEPARATOR = "//";
const EDGE_FIELDS = ["yourEdge", "yourClaim"] as const;

/** Same normalization the ledger keys angles by (packages/core/src/ledger-drafts.ts). */
export function angleKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The editor text with `angleText` removed from its edge field, re-serialized
 * the way the editor seeds it (2-space JSON, key order kept). Null when the
 * text is not a JSON object, carries no edge field, or the angle is not in
 * it — the caller leaves the textarea alone.
 */
export function removeAngleFromConfigText(text: string, angleText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const cfg = parsed as Record<string, unknown>;
  const field = EDGE_FIELDS.find((k) => typeof cfg[k] === "string");
  if (!field) return null;
  const angles = (cfg[field] as string)
    .split(ANGLE_SEPARATOR)
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  const key = angleKey(angleText);
  const kept = angles.filter((a) => angleKey(a) !== key);
  if (kept.length === angles.length) return null;
  cfg[field] = kept.join(` ${ANGLE_SEPARATOR} `);
  return JSON.stringify(cfg, null, 2);
}

/**
 * An angle the founder has had chances to send and never did: rotated away
 * from it twice, or shown it three times, with zero reviewed sends.
 */
export function isNeverSent(a: AngleUsageView): boolean {
  return a.sent === 0 && (a.rotatedAway >= 2 || a.offered >= 3);
}

/** Configured angles of a trigger that meet `isNeverSent`. */
export function neverSentAngles(usage: TriggerView["angleUsage"] | undefined): AngleUsageView[] {
  return usage?.angles.filter(isNeverSent) ?? [];
}
