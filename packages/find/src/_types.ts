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
  /** How many were enqueued. */
  enqueued: number;
  /** Approximate USD spent on OneShot calls during this run. */
  costUsd: number;
  /** Reason the run halted early, if any (e.g. "max-cost cap"). */
  halted?: string;
}

export interface CandidateBase {
  /** Unique key for dedupe within this play. */
  dedupeKey: string;
  /** Free-text description used for ICP filtering. */
  description: string;
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
  summary: string | null;
}

export interface AcceleratorListExtract {
  name: string;
  launchUrl: string;
  oneLiner: string | null;
}

export interface JobChangeExtract {
  fullName: string | null;
  newRole: string | null;
  newCompany: string | null;
  newCompanyDomain: string | null;
  previousRole: string | null;
  previousCompany: string | null;
  linkedinUrl: string | null;
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
}
