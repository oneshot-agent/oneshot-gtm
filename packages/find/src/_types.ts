export interface FinderResult {
  source: string;
  /** How many candidates the source returned. */
  candidates: number;
  /** How many were dropped by the ICP filter. */
  droppedIcp: number;
  /** How many were dropped because of dedupe (already in queue or in prospects). */
  droppedDuplicate: number;
  /** How many were dropped because enrichment failed (no email, undeliverable, etc). */
  droppedEnrichment: number;
  /** How many were dropped because a per-finder low-signal threshold wasn't met (e.g. show-hn minPoints). Optional — not every finder has such a gate. */
  droppedLowSignal?: number;
  /**
   * How many were dropped by the PERSON-level ICP gate — i.e. the human's job
   * title is a different function (sales, marketing, investor, design, intern).
   * Distinct from `droppedIcp`, which judges the company / repo / event.
   * Optional — only finders that have adopted the gate set it.
   */
  droppedRole?: number;
  /** How many were enqueued. */
  enqueued: number;
  /** Approximate USD spent on OneShot calls during this run. */
  costUsd: number;
  /** SDK/LLM portion when costUsd also includes a separate source meter (for example X). */
  sdkCostUsd?: number;
  /** Reason the run halted early, if any (e.g. "max-cost cap"). */
  halted?: string;
  /**
   * Per-cohort fetch outcomes for the multi-cohort accelerator-batch sweep.
   * Surfaces "yc-w26: 28, spc-2026-1: 0 (no hits)" on the trigger card so
   * the operator can see which incubators had signal without grepping logs.
   * Only set by `accelerator-batch`; other finders leave it unset.
   */
  perCohort?: Array<{ cohort: string; records: number; error?: string }>;
  /**
   * Per-source fetch outcomes for `local-registry` (one entry per configured
   * Socrata portal or nppes taxonomy×state pair). Same isolation contract as
   * `perCohort`: a dead portal logs and continues, the run only halts when
   * every source returns 0. Only set by `local-registry`.
   */
  perSource?: Array<{ source: string; label: string; records: number; error?: string }>;
}

export interface ShowHnHit {
  objectID: string;
  title: string;
  url: string | null;
  author: string;
  points: number;
  num_comments: number;
  story_text: string | null;
  created_at: string;
  created_at_i: number;
}

export interface PostFundingExtract {
  company: string | null;
  companyDomain: string | null;
  round: string | null;
  amountUsd: number | null;
  leadInvestor: string | null;
  founderName: string | null;
  founderRole: string | null;
  industry: string | null;
  linkedinUrl: string | null;
  phone: string | null;
  summary: string | null;
}

/**
 * Normalized accelerator-cohort company record. Both adapters (yc-oss
 * directory + websearch fallback) return this shape so the per-company
 * pipeline in `accelerator-batch.ts` doesn't care where a record came from.
 */
export interface CompanyRecord {
  name: string;
  /** Best-known company website. May be null when only a YC profile URL is available. */
  website: string | null;
  oneLiner: string | null;
  longDescription: string | null;
  industry: string | null;
  tags: string[];
  /** Canonical YC profile URL when sourced from yc-oss; null for websearch records. */
  ycUrl: string | null;
  /**
   * Founder/CEO name when known up-front (websearch path extracts it; yc-oss
   * path leaves it null). The pipeline resolves null values via a per-company
   * webRead+extract before calling findEmail — the OneShot SDK requires a
   * person name for email-by-domain to work.
   */
  founderName: string | null;
  /** LinkedIn URL of the founder when surfaced by the source (websearch extract) — null otherwise. */
  founderLinkedinUrl: string | null;
  /** Phone number of the founder when surfaced by the source — rare; null otherwise. */
  founderPhone: string | null;
  source: "yc-oss" | "websearch";
}

export interface AcceleratorLaunchExtract {
  company: string | null;
  companyDomain: string | null;
  oneLiner: string | null;
  founderName: string | null;
  founderRole: string | null;
  launchUrl: string | null;
  linkedinUrl: string | null;
  phone: string | null;
}

export interface JobChangeExtract {
  fullName: string | null;
  newRole: string | null;
  newCompany: string | null;
  newCompanyDomain: string | null;
  previousRole: string | null;
  previousCompany: string | null;
  linkedinUrl: string | null;
  phone: string | null;
  summary: string | null;
}

export interface HiringSignalExtract {
  jobTitle: string | null;
  jobUrl: string | null;
  company: string | null;
  companyDomain: string | null;
  hiringManagerName: string | null;
  hiringManagerRole: string | null;
  team: string | null;
  postedAt: string | null;
  linkedinUrl: string | null;
  phone: string | null;
  summary: string | null;
}

export interface PodcastGuestExtract {
  podcastName: string | null;
  episodeTitle: string | null;
  episodeUrl: string | null;
  guestName: string | null;
  guestRole: string | null;
  guestCompany: string | null;
  guestCompanyDomain: string | null;
  publishedAt: string | null;
  linkedinUrl: string | null;
  phone: string | null;
  summary: string | null;
}

export interface LumaPublicAttendee {
  name: string;
  profileUrl: string | null;
  websiteUrl: string | null;
  linkedinUrl: string | null;
  twitterUrl: string | null;
  bio: string | null;
  role: string | null;
}

export interface LumaEventExtract {
  eventTitle: string | null;
  eventDateIso: string | null;
  /**
   * IANA zone the event page states (e.g. "America/Los_Angeles" for "7:30 PM
   * PDT"). First choice when rendering the date for a draft — see
   * `resolveEventZone` in `@oneshot-gtm/core`. Null when the page doesn't say.
   */
  eventTimezone: string | null;
  eventCity: string | null;
  /** Short summary of what the event is about — grounds the draft's topic. Null when the page has none. */
  eventDescription: string | null;
  eventHasPassed: boolean;
  publicAttendees: LumaPublicAttendee[];
}

export interface AgentBuilderExtract {
  repoUrl: string | null;
  githubHandle: string | null;
  authorFullName: string | null;
  authorRole: string | null;
  companyName: string | null;
  companyDomain: string | null;
  personalDomain: string | null;
  stackDetected: string[];
  summary: string | null;
}

export interface RunOpts {
  dryRun: boolean;
  /** Hard cap on USD spent. The finder halts mid-run when this is hit. */
  maxCostUsd?: number;
  /** Max candidates to consider this run. */
  limit?: number;
  /** Free-text ICP override (otherwise read from config). */
  icpOverride?: string;
  /**
   * Person-level ICP gate: when the free role text is still ambiguous, buy one
   * extra enrichProfile (~$0.005) to get a real job title before deciding.
   * Defaults to on — the alternative is guessing, which is what let 15% of the
   * emailed population be off-ICP. Turn off to cap spend on a wide sweep.
   */
  qualifyFillGaps?: boolean;
}
