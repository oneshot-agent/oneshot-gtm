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
