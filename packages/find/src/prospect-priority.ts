import { getLedger } from "@oneshot-gtm/core";

export interface ProspectPriority {
  version: "heuristic-v1";
  total: number;
  components: {
    personFit: number;
    accountFit: number;
    intentStrength: number;
    timingFreshness: number;
    signalConfidence: number;
    contactability: number;
  };
  reasons: string[];
  finder: string;
  scoredAt: string;
}

type Evidence = Record<string, unknown>;
type Components = ProspectPriority["components"];

const WEIGHTS: Record<keyof Components, number> = {
  personFit: 0.3,
  accountFit: 0.2,
  intentStrength: 0.2,
  timingFreshness: 0.15,
  signalConfidence: 0.1,
  contactability: 0.05,
};

const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const present = (p: Evidence, keys: string[]): boolean => keys.some((key) => text(p[key]) != null);
const clamp = (value: number): number => Math.max(0, Math.min(100, value));

/** Score only evidence already retained by a finder. Missing evidence stays neutral (50). */
export function scoreProspectPriority(input: {
  payload: unknown;
  finder: string;
  foundAt?: string | null;
  now?: Date;
}): ProspectPriority {
  const p = input.payload && typeof input.payload === "object" ? (input.payload as Evidence) : {};
  const now = input.now ?? new Date();
  const reasons: string[] = [];
  const c: Components = {
    personFit: 50,
    accountFit: 50,
    intentStrength: 50,
    timingFreshness: 50,
    signalConfidence: 50,
    contactability: 50,
  };

  const role =
    text(p["title"]) ??
    text(p["role"]) ??
    text(p["founderRole"]) ??
    text(p["guestRole"]) ??
    text(p["newRole"]) ??
    text(p["authorRole"]);
  if (role) {
    if (/founder|co-?founder|owner|chief|ceo|cto|vp|head|director/i.test(role)) {
      c.personFit = 85;
      reasons.push(`Decision-maker role: ${role}`);
    } else {
      c.personFit = 60;
      reasons.push(`Known role: ${role}`);
    }
  }

  const company =
    text(p["company"]) ??
    text(p["companyName"]) ??
    text(p["newCompany"]) ??
    text(p["guestCompany"]);
  const domain = text(p["companyDomain"]) ?? text(p["domain"]);
  const industry = text(p["industry"]);
  if (company || domain || industry) {
    c.accountFit = industry ? 75 : 65;
    reasons.push(`Account evidence: ${industry ?? company ?? domain}`);
  }

  const finderIntent: Record<string, [number, string]> = {
    "x-reposters": [85, "Reposted a relevant post"],
    "github-stars": [82, "Starred a relevant repository"],
    "github-topics": [75, "Built with a relevant technology"],
    "show-hn": [78, "Recently launched on Show HN"],
    "post-funding-auto": [72, "Recent funding signal"],
    "post-funding": [72, "Recent funding signal"],
    "job-change": [70, "Recent job change"],
    "hiring-signal": [76, "Active hiring signal"],
    "podcast-guest": [68, "Recent public thought-leadership signal"],
    luma: [65, "Relevant event participation"],
    "accelerator-batch": [67, "Recent accelerator cohort signal"],
  };
  const intent = finderIntent[input.finder];
  if (intent) {
    c.intentStrength = intent[0];
    reasons.push(intent[1]);
  }
  const points = number(p["points"]) ?? number(p["score"]);
  if (points != null) {
    c.intentStrength = Math.max(c.intentStrength, 55 + Math.min(35, Math.log2(points + 1) * 5));
    reasons.push(`Source engagement: ${Math.round(points)}`);
  }

  const signalDate =
    text(p["publishedAt"]) ??
    text(p["postedAt"]) ??
    text(p["createdAt"]) ??
    text(p["created_at"]) ??
    text(p["eventDateIso"]) ??
    input.foundAt ??
    null;
  if (signalDate) {
    const timestamp = Date.parse(signalDate);
    if (Number.isFinite(timestamp)) {
      const days = Math.max(0, (now.getTime() - timestamp) / 86_400_000);
      c.timingFreshness = days <= 2 ? 95 : days <= 7 ? 85 : days <= 30 ? 70 : days <= 90 ? 55 : 35;
      reasons.push(`Signal ${days < 1 ? "today" : `${Math.floor(days)}d ago`}`);
    }
  }

  const sourceUrl = present(p, [
    "url",
    "repoUrl",
    "jobUrl",
    "episodeUrl",
    "launchUrl",
    "profileUrl",
  ]);
  const summary = present(p, ["summary", "description", "oneLiner", "bio", "storyText"]);
  if (sourceUrl || summary) c.signalConfidence = sourceUrl && summary ? 85 : 70;

  const email = present(p, ["email", "founderEmail"]);
  const social = present(p, ["linkedinUrl", "twitterUrl", "githubUrl", "profileUrl"]);
  const phone = present(p, ["phone", "founderPhone"]);
  if (email || social || phone) {
    c.contactability = email && (social || phone) ? 95 : email ? 85 : 65;
    reasons.push(email ? "Verified contact route available" : "Social contact route available");
  }

  for (const key of Object.keys(c) as Array<keyof Components>) c[key] = clamp(c[key]);
  const total = Math.round(
    (Object.keys(WEIGHTS) as Array<keyof Components>).reduce(
      (sum, key) => sum + c[key] * WEIGHTS[key],
      0,
    ),
  );
  return {
    version: "heuristic-v1",
    total: clamp(total),
    components: c,
    reasons: reasons.slice(0, 5),
    finder: input.finder,
    scoredAt: now.toISOString(),
  };
}

export interface ScoreProspectsResult {
  scored: number;
  skippedMalformed: number;
  dryRun: boolean;
  byFinder: Array<{
    finder: string;
    scored: number;
    approved: number;
    rejected: number;
    pending: number;
    average: number;
  }>;
}

export function scoreStoredProspects(opts: {
  scope: string;
  limit: number;
  refresh?: boolean;
  dryRun?: boolean;
  now?: Date;
}): ScoreProspectsResult {
  const ledger = getLedger();
  const rows = ledger.listQueueForPriority({
    ...(opts.scope === "all" ? {} : { playName: opts.scope }),
    limit: opts.limit,
    refresh: opts.refresh === true,
  });
  const groups = new Map<
    string,
    { scores: number[]; approved: number; rejected: number; pending: number }
  >();
  let scored = 0;
  let skippedMalformed = 0;
  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      skippedMalformed++;
      continue;
    }
    const priority = scoreProspectPriority({
      payload,
      finder: row.play_name,
      foundAt: row.found_at,
      now: opts.now,
    });
    if (!opts.dryRun) ledger.setQueuePriority(row.id, priority);
    scored++;
    const group = groups.get(row.play_name) ?? { scores: [], approved: 0, rejected: 0, pending: 0 };
    group.scores.push(priority.total);
    if (row.status === "approved" || row.status === "sent") group.approved++;
    else if (row.status === "rejected") group.rejected++;
    else group.pending++;
    groups.set(row.play_name, group);
  }
  return {
    scored,
    skippedMalformed,
    dryRun: opts.dryRun === true,
    byFinder: [...groups].map(([finder, g]) => ({
      finder,
      scored: g.scores.length,
      approved: g.approved,
      rejected: g.rejected,
      pending: g.pending,
      average: Math.round(g.scores.reduce((a, b) => a + b, 0) / g.scores.length),
    })),
  };
}
