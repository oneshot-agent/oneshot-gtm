/**
 * Already connected, read off a profile view: the account's `network_distance`
 * to the person. A known connection gets no connection request; the first
 * LinkedIn message is what comes next.
 */

/** The spellings a first-degree connection reads as: the profile view's, and the provider's attendee alias. */
const FIRST_DEGREE = new Set(["FIRST_DEGREE", "DISTANCE_1"]);

/** Whether a profile view's `network_distance` says the person is a first-degree connection. Anything else is unknown. */
export function isFirstDegree(distance: unknown): boolean {
  return typeof distance === "string" && FIRST_DEGREE.has(distance);
}

/**
 * `via` on the LinkedIn event recorded in place of an invite for a known
 * connection. It sent nothing: no note, no request.
 */
export const KNOWN_CONNECTION_VIA = "profile-read";

/** Whether a sequence event's metadata is that record rather than a message or an invite. */
export function isKnownConnectionMarker(metadataJson: string | null | undefined): boolean {
  try {
    const meta = JSON.parse(metadataJson ?? "{}") as { via?: unknown } | null;
    return meta?.via === KNOWN_CONNECTION_VIA;
  } catch {
    return false;
  }
}

type ViewRecord = Record<string, unknown>;

const isRecord = (v: unknown): v is ViewRecord => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A newer stored profile view over the one already in the paid cache. The
 * newer view's fields win, but it never erases what the older one knew:
 * a distance it does not report stays, with when it was read
 * (`networkDistanceReadAt`), and a partial view (Experience held back) laid
 * over a complete one keeps that one's Experience list and is not partial.
 * A complete view over a partial one is complete.
 */
export function mergeStoredView(
  previous: { result: unknown; fetchedAt: string } | null,
  next: ViewRecord,
): ViewRecord {
  const now = new Date().toISOString();
  const nextDistance = typeof next["networkDistance"] === "string" && next["networkDistance"];
  const kept: ViewRecord = { ...next };
  if (nextDistance) kept["networkDistanceReadAt"] = storedDistanceReadAt(next, now);
  const prev = previous && isRecord(previous.result) ? previous.result : null;
  if (!prev) return kept;
  const merged: ViewRecord = { ...prev };
  for (const [k, v] of Object.entries(kept)) if (v !== null && v !== undefined) merged[k] = v;
  const prevDistance = typeof prev["networkDistance"] === "string" && prev["networkDistance"];
  if (!nextDistance && prevDistance) {
    merged["networkDistance"] = prevDistance;
    merged["networkDistanceReadAt"] = storedDistanceReadAt(prev, previous!.fetchedAt);
  }
  if (next["partial"] !== true) delete merged["partial"];
  else if (prev["partial"] !== true) {
    merged["experience"] = Array.isArray(prev["experience"]) ? prev["experience"] : [];
    delete merged["partial"];
  }
  return merged;
}

/** When a stored view's distance was read: its own time, else the view's, else when it was stored. */
export function storedDistanceReadAt(result: unknown, fetchedAt: string): string {
  if (!isRecord(result)) return fetchedAt;
  const v = result["networkDistanceReadAt"] ?? result["readAt"];
  return typeof v === "string" && v ? v : fetchedAt;
}
