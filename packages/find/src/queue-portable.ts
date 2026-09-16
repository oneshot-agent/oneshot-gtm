/**
 * The part of a queue payload that belongs to the PERSON, not to the
 * workspace that found them — what a "move to workspace X" carries across.
 *
 * A payload mixes three kinds of keys: identity and research (name, email,
 * LinkedIn, `personResearch`, `productResearch`, the finder's evidence such as
 * `postTitle` or `cohort`), which travel so the destination never re-pays for
 * research; the sender's positioning (`yourEdge`/`yourClaim`), which the
 * destination re-derives from its own trigger config at draft time
 * (`resolveQueueTarget`); and verdicts written against the SOURCE ICP
 * (`icpVerdict`, `fitReason`), which would be lies in the other workspace.
 * The second and third groups are dropped here.
 */

/** Keys that describe the source workspace's positioning or its judgment, never the prospect. */
export const WORKSPACE_SPECIFIC_PAYLOAD_KEYS: readonly string[] = [
  "yourEdge",
  "yourClaim",
  "fitReason",
  "fitReasonSource",
  "icpVerdict",
  "icpVerdictReason",
  "angle",
  "emailOverride",
];

/** Provenance stamped on a moved row — read by the review UI, never by a classifier. */
export interface MovedFrom {
  workspace: string;
  queueId: number;
  at: string;
}

/** A copy of `payload` without the workspace-specific keys; null when it is not an object. */
export function portableQueuePayload(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (WORKSPACE_SPECIFIC_PAYLOAD_KEYS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}
