/**
 * Per-play step-0 metadata, addressable by play name.
 *
 * Why this exists: each play's `EmailPlayDef.metadata` stamps the evidence that
 * made someone a prospect (`repo`, `eventTitle`, `vendorStack`, …) onto the
 * step-0 `sequence_events` row. `runEmailPlay` applies it — but the /queue
 * "send this reviewed draft" route (`apps/server/src/api/queue.ts`) calls
 * `sendDraftedEmail` directly and used to pass no metadata at all. The result:
 * 178 of 351 repo-interest step-0 rows had no `repo` key, which silently
 * mis-routed 19 prospects into the wrong arm of the LinkedIn A/B experiment.
 *
 * These are the SAME functions the play defs reference (each play imports its
 * own), so the queue route and the play cannot drift apart — there is exactly
 * one definition of "what this play records".
 *
 * Contract: every function is a PURE map from the target/payload to the
 * metadata object. No run options, no config, no I/O. Functions take `object`
 * (not the play's target interface) so both a typed target and a raw queue
 * payload are accepted; fields are read defensively. `accelerator-batch` is
 * the one play whose def also mixes in a run option (`opts.senderCohort` as a
 * fallback) — its def layers that on top; queue sends have no run options, so
 * the payload field is used as-is.
 */

type Payload = Record<string, unknown>;

function field(raw: object, k: string): unknown {
  return (raw as Payload)[k];
}
function str(raw: object, k: string): string | null {
  const v = field(raw, k);
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(raw: object, k: string): number | null {
  const v = field(raw, k);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export const repoInterestMetadata = (t: object): Record<string, unknown> => ({
  repo: str(t, "repo"),
});

export const lumaEventsMetadata = (t: object): Record<string, unknown> => ({
  eventTitle: str(t, "eventTitle"),
  eventUrl: str(t, "eventUrl"),
  eventDate: str(t, "eventDate"),
});

export const stackConsolidationMetadata = (t: object): Record<string, unknown> => ({
  vendorStack: str(t, "vendorStack"),
  evidenceUrl: str(t, "evidenceUrl"),
});

export const showHnMetadata = (t: object): Record<string, unknown> => ({
  postUrl: str(t, "postUrl"),
  postTitle: str(t, "postTitle"),
});

export const postFundingMetadata = (t: object): Record<string, unknown> => ({
  round: str(t, "round"),
  amountUsd: num(t, "amountUsd"),
  leadInvestor: str(t, "leadInvestor"),
});

export const jobChangeMetadata = (t: object): Record<string, unknown> => ({
  newRole: str(t, "newRole"),
  newCompany: str(t, "newCompany"),
});

export const hiringSignalMetadata = (t: object): Record<string, unknown> => ({
  jobTitle: str(t, "jobTitle"),
  jobPostUrl: str(t, "jobPostUrl"),
});

export const podcastGuestMetadata = (t: object): Record<string, unknown> => ({
  podcast: str(t, "podcast"),
  episodeTitle: str(t, "episodeTitle"),
});

export const competitorSwitchMetadata = (t: object): Record<string, unknown> => ({
  competitor: str(t, "competitor"),
  evidenceUrl: str(t, "evidenceUrl"),
});

export const acceleratorBatchMetadata = (t: object): Record<string, unknown> => ({
  senderCohort: str(t, "senderCohort"),
  prospectCohort: str(t, "cohort"),
});

const REGISTRY: Record<string, (t: object) => Record<string, unknown>> = {
  "repo-interest": repoInterestMetadata,
  "luma-events": lumaEventsMetadata,
  "stack-consolidation": stackConsolidationMetadata,
  "show-hn": showHnMetadata,
  "post-funding": postFundingMetadata,
  "job-change": jobChangeMetadata,
  "hiring-signal": hiringSignalMetadata,
  "podcast-guest": podcastGuestMetadata,
  "competitor-switch": competitorSwitchMetadata,
  "accelerator-batch": acceleratorBatchMetadata,
};

/**
 * Metadata for one play's step-0 send, from a raw queue payload. Plays with no
 * evidence metadata (profile-intro, breakup-revive, …) return `{}` — the
 * `{subject, body}` base is added by `sendDraftedEmail` regardless.
 *
 * Null-valued keys are stripped: `json_extract(metadata_json, '$.repo')`
 * treats a JSON null and a missing key identically, and downstream readers
 * (expandi-sync's buildSignal) check key presence.
 */
export function playMetadata(playName: string, payload: Record<string, unknown>): Record<string, unknown> {
  const fn = REGISTRY[playName];
  if (!fn) return {};
  const out = fn(payload);
  for (const k of Object.keys(out)) {
    if (out[k] === null || out[k] === undefined) delete out[k];
  }
  return out;
}
