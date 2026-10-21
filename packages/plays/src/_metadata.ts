/**
 * Per-play step-0 metadata, addressable by play name. The play defs and the
 * /queue send route must share these exact functions so they can't drift.
 * Contract: pure maps from target/payload to metadata: no run options, no
 * config, no I/O; `object` params so typed targets and raw queue payloads both
 * work, fields read defensively.
 */

import { offerOf, offerSendMetadata, playMakesOffer } from "./_prospect-offer.ts";

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

// No senderCohort here on purpose: the sender's own cohort is founder truth
// read from config at draft time, and a stale one may still sit on an old
// queue payload. The play stamps the config value onto the metadata itself.
export const acceleratorBatchMetadata = (t: object): Record<string, unknown> => ({
  prospectCohort: str(t, "cohort"),
  demoDayMonth: str(t, "demoDayMonth"),
});

export const multiplierMetadata = (t: object): Record<string, unknown> => ({
  organization: str(t, "organization"),
  orgType: str(t, "orgType"),
  memberDescription: str(t, "memberDescription"),
  whyFit: str(t, "whyFit"),
  introducedBy: str(t, "introducedBy"),
});

/**
 * The prospect fields the `multiplier` play maps from its row rather than
 * reading generically: the organization is the prospect's company and
 * `multiplier-<orgType>` its source. The play's `prospectMeta` and the
 * reviewed /queue send share this map, so a reviewed send records the same
 * prospect an unattended run does, and the letter's address eligibility
 * (`automaticMailEligible`, which needs a company) reads it either way.
 */
export const multiplierProspectFields = (
  t: object,
): { company: string | null; source: string } => ({
  company: str(t, "organization"),
  source: `multiplier-${str(t, "orgType") ?? "other"}`,
});

/**
 * Per play, the prospect fields the /queue send route cannot read
 * generically from the payload (`company`, the play name as `source`): only
 * the `multiplier` play has any; empty for every other play.
 */
export function playProspectFields(
  playName: string,
  payload: Record<string, unknown>,
): { company?: string | null; source?: string } {
  return playName === "multiplier" ? multiplierProspectFields(payload) : {};
}

export const xRepostIntroMetadata = (t: object): Record<string, unknown> => ({
  seedHandle: str(t, "seedHandle"),
  tweetUrl: str(t, "tweetUrl"),
});

export const xAmplifyMetadata = (t: object): Record<string, unknown> => ({
  seedHandle: str(t, "seedHandle"),
  tweetUrl: str(t, "tweetUrl"),
  launchDate: str(t, "launchDate"),
});

export const discoveryInterviewMetadata = (t: object): Record<string, unknown> => ({
  businessType: str(t, "businessType"),
  topic: str(t, "topic"),
});

export const freePilotMetadata = (t: object): Record<string, unknown> => ({
  businessType: str(t, "businessType"),
});

export const sourcesSoughtMetadata = (t: object): Record<string, unknown> => ({
  agency: str(t, "agency"),
  noticeNumber: str(t, "noticeNumber"),
  noticeType: str(t, "noticeType"),
  // finding PRRT_kwDOSKzrBs6ewQdC / issue #463: persisted so the day-5
  // follow-up (sources-sought.ts's builder) can skip once the notice's
  // response window has closed instead of chasing a dead conversation.
  responseDeadline: str(t, "responseDeadline"),
});

export const civicPilotMetadata = (t: object): Record<string, unknown> => ({
  city: str(t, "city"),
  agendaItemTitle: str(t, "agendaItemTitle"),
  meetingDate: str(t, "meetingDate"),
});

export const designPartnerLoiMetadata = (t: object): Record<string, unknown> => ({
  buyerType: str(t, "buyerType"),
  company: str(t, "company"),
});

export const newBusinessMetadata = (t: object): Record<string, unknown> => ({
  businessType: str(t, "businessType"),
  licenseType: str(t, "licenseType"),
  issuedAgo: str(t, "issuedAgo"),
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
  multiplier: multiplierMetadata,
  "x-repost-intro": xRepostIntroMetadata,
  "x-amplify": xAmplifyMetadata,
  "x-amplify-dm": xAmplifyMetadata,
  "free-pilot": freePilotMetadata,
  "discovery-interview": discoveryInterviewMetadata,
  "sources-sought": sourcesSoughtMetadata,
  "civic-pilot": civicPilotMetadata,
  "design-partner-loi": designPartnerLoiMetadata,
  "new-business": newBusinessMetadata,
};

/**
 * Metadata for one play's step-0 send, from a raw queue payload. Plays with no
 * evidence metadata (profile-intro, breakup-revive, …) return `{}`. The
 * `{subject, body}` base is added by `sendDraftedEmail` regardless.
 *
 * Null-valued keys are stripped: `json_extract(metadata_json, '$.repo')`
 * treats a JSON null and a missing key identically, and downstream readers
 * (expandi-sync's buildSignal) check key presence.
 */
export function playMetadata(
  playName: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const fn = REGISTRY[playName];
  if (!fn) return {};
  const out = fn(payload);
  for (const k of Object.keys(out)) {
    if (out[k] === null || out[k] === undefined) delete out[k];
  }
  return out;
}

/**
 * What a reviewed intro's step-0 record carries beyond the play's own map:
 * the offer on its queue row, and the angle and first-touch format its stored
 * draft was written with. The same fields an unattended run records
 * (`runEmailPlay`), so a follow-up reads the offer and the angle back
 * whichever path sent the intro. Null-valued keys are stripped, as above.
 */
export function reviewedIntroMetadata(
  playName: string,
  payload: Record<string, unknown>,
  draft: { angle?: unknown; formatKey?: unknown },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...playMetadata(playName, payload) };
  const angle = draft.angle as
    | { text?: unknown; index?: unknown; count?: unknown; assignment?: unknown }
    | null
    | undefined;
  if (angle && typeof angle === "object" && typeof angle.text === "string" && angle.text.trim()) {
    out["angleText"] = angle.text;
    if (typeof angle.index === "number") out["angleIndex"] = angle.index;
    if (typeof angle.count === "number") out["angleCount"] = angle.count;
    // Only the arm split is read back (a follow-up keeps the intro's arm).
    if (angle.assignment === "arm") out["angleMethod"] = "arm";
  }
  if (typeof draft.formatKey === "string" && draft.formatKey) {
    out["firstTouchFormat"] = draft.formatKey;
  }
  if (playMakesOffer(playName)) Object.assign(out, offerSendMetadata(offerOf(payload)));
  return out;
}
