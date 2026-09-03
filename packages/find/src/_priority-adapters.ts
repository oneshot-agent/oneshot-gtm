import { type Ledger, type ProspectPriority, logEvent } from "@oneshot-gtm/core";
import {
  type PriorityEvidence,
  type PrioritySignal,
  SENIORITY_BANDS,
  computePriority,
} from "./_priority.ts";

/**
 * Per-play adapters: payload already persisted at enqueue time → normalized
 * `PriorityEvidence` (issue #410, Phase 1). Adapters only READ fields the
 * finder already paid for — no enrichment, no network. Payloads are treated
 * as untrusted `Record<string, unknown>` because the backfill replays legacy
 * rows whose shape may predate today's `*Target` interfaces.
 */

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Contact flags every email finder shares (`email`/`linkedinUrl`/`phone`). */
function contact(p: Record<string, unknown>, emailField = "email") {
  return {
    hasEmail: str(p[emailField]) !== null,
    hasLinkedin: str(p["linkedinUrl"]) !== null,
    hasPhone: str(p["phone"]) !== null,
  };
}

function urlCount(...urls: unknown[]): number {
  return urls.filter((u) => str(u) !== null).length;
}

/**
 * Label-mined title prior for the indie-builder finders (luma, github-stars):
 * exec-band titles measured at 35–44% approval vs a 55–92% baseline — the
 * classic seniority boost is an ANTI-signal for this ICP. Non-exec titles are
 * plain neutral evidence; a missing title stays unknown (no signal at all).
 */
function minedTitleSignals(title: string | null): PrioritySignal[] {
  if (!title) return [];
  const exec = SENIORITY_BANDS[0]!.pattern.test(title);
  return [{ kind: "title-prior", strength: exec ? 35 : 50, reason: `title: ${title}` }];
}

function fmtUsd(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${Math.round(amount / 1_000)}k`;
  return `$${amount}`;
}

function fmtFollowers(followers: number): string {
  return followers >= 1_000 ? `${(followers / 1_000).toFixed(1)}k` : String(followers);
}

/** Shared evidence for the three X lanes — lane-local reach/repost signals feed
 *  components; `XScoredCandidate.score` is deliberately never read. */
function xEvidence(p: Record<string, unknown>): PriorityEvidence {
  const accountSignals: PrioritySignal[] = [];
  const followers = num(p["followers"]);
  if (followers !== null) {
    // 50 = "weak but not negative": small reach is unknown-ish, and signals
    // are authoritative in v2 (no neutral floor to lean on).
    const strength = followers >= 10_000 ? 70 : followers >= 1_000 ? 60 : 50;
    accountSignals.push({
      kind: "reach",
      strength,
      reason: `${fmtFollowers(followers)} followers`,
    });
  }
  const seed = str(p["seedHandle"]);
  const quote = p["mode"] === "quote";
  const intentSignals: PrioritySignal[] = [
    {
      kind: "repost",
      strength: quote ? 80 : 70,
      reason: `${quote ? "quote-tweeted" : "reposted"}${seed ? ` @${seed}` : ""}`,
    },
  ];
  return {
    title: str(p["title"]),
    accountSignals,
    intentSignals,
    // No eventAt on purpose: the repost itself is inside the finder's 48h
    // harvest window, so it's inherently fresh at enqueue time — while the
    // campaign's configured launchDate can be far in the past and would
    // wrongly decay a repost that happened yesterday.
    evidenceUrlCount: urlCount(p["tweetUrl"], p["twitterUrl"]),
    hasEvidenceText: str(p["tweetText"]) !== null,
    hasEmail: str(p["email"]) !== null,
    dmOpen: p["dmOpen"] === true,
  };
}

export const PRIORITY_ADAPTERS: Record<string, (p: Record<string, unknown>) => PriorityEvidence> = {
  "show-hn": (p) => ({
    title: str(p["title"]),
    intentSignals: [
      {
        kind: "launch",
        strength: 85,
        reason: `launched on Show HN: ${str(p["postTitle"]) ?? "?"}`,
      },
    ],
    evidenceUrlCount: urlCount(p["postUrl"]),
    hasEvidenceText: str(p["hookSummary"]) !== null,
    ...contact(p, "founderEmail"),
  }),

  "post-funding": (p) => {
    const round = str(p["round"]);
    const amount = num(p["amountUsd"]);
    const lead = str(p["leadInvestor"]);
    const evidence = [
      round,
      // amountUsd 0 is the producer's missing-amount sentinel, not a $0 round.
      amount !== null && amount > 0 ? fmtUsd(amount) : null,
      lead ? `led by ${lead}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    return {
      title: str(p["title"]),
      companyKnown: str(p["company"]) !== null,
      accountSignals: [
        { kind: "funding", strength: 85, reason: `raised ${evidence || "funding"}` },
      ],
      intentSignals: [
        {
          kind: "fresh-budget",
          strength: 70,
          reason: `fresh ${round ?? ""} budget`.replace("  ", " "),
        },
      ],
      evidenceUrlCount: urlCount(p["sourceUrl"]),
      ...contact(p),
    };
  },

  "job-change": (p) => ({
    title: str(p["title"]),
    seniorityHint: str(p["newRole"]),
    companyKnown: str(p["newCompany"]) !== null,
    intentSignals: [
      {
        kind: "new-role",
        strength: 75,
        reason: `just started as ${str(p["newRole"]) ?? "?"} at ${str(p["newCompany"]) ?? "?"}`,
      },
    ],
    hasEvidenceText: str(p["previousRole"]) !== null || str(p["previousCompany"]) !== null,
    ...contact(p),
  }),

  "hiring-signal": (p) => ({
    title: str(p["title"]),
    companyKnown: str(p["company"]) !== null,
    accountSignals: [
      { kind: "hiring", strength: 75, reason: `hiring: ${str(p["jobTitle"]) ?? "?"}` },
    ],
    intentSignals: [{ kind: "hiring-need", strength: 65, reason: "open req = active need" }],
    evidenceUrlCount: urlCount(p["jobPostUrl"]),
    hasEvidenceText: str(p["yourClaim"]) !== null,
    ...contact(p),
  }),

  "podcast-guest": (p) => ({
    title: str(p["title"]),
    companyKnown: str(p["company"]) !== null,
    intentSignals: [
      {
        kind: "podcast",
        strength: 60,
        reason: `guest on ${str(p["podcast"]) ?? "?"}: ${str(p["episodeTitle"]) ?? "?"}`,
      },
    ],
    hasEvidenceText: str(p["hookQuote"]) !== null,
    ...contact(p),
  }),

  "accelerator-batch": (p) => ({
    title: str(p["title"]),
    companyKnown: str(p["company"]) !== null,
    accountSignals: [
      { kind: "accelerator", strength: 80, reason: `${str(p["cohort"]) ?? "accelerator"} cohort` },
    ],
    intentSignals: [{ kind: "launch-mode", strength: 70, reason: "in launch mode" }],
    evidenceUrlCount: urlCount(p["launchUrl"]),
    hasEvidenceText: str(p["productOneLiner"]) !== null,
    ...contact(p),
  }),

  // v2, label-mined (65 approved / 69 rejected individually-judged rows):
  // exec titles 35% approval vs 55% title-missing → title prior inverted;
  // bios no longer feed seniority (bioTitleBand measured flat-to-negative);
  // Host 35% vs Guest 54% → Host now scores BELOW Guest, not above.
  "luma-events": (p) => {
    const role = str(p["role"]);
    return {
      personSignals: minedTitleSignals(str(p["title"])),
      companyKnown: str(p["company"]) !== null,
      intentSignals: [
        {
          kind: "event",
          strength: role === "Host" ? 45 : 65,
          reason: `${role ?? "attendee"} at ${str(p["eventTitle"]) ?? "?"}`,
        },
      ],
      eventAt: str(p["eventDate"]),
      evidenceUrlCount: urlCount(p["eventUrl"]),
      hasEvidenceText: str(p["attendeeBio"]) !== null || str(p["eventDescription"]) !== null,
      ...contact(p),
    };
  },

  "stack-consolidation": (p) => ({
    title: str(p["title"]),
    companyKnown: str(p["company"]) !== null,
    accountSignals: [
      {
        kind: "stack",
        strength: 65,
        reason: `runs ${str(p["vendorStack"]) ?? "a multi-vendor stack"}`,
      },
    ],
    intentSignals: [{ kind: "consolidation", strength: 60, reason: "consolidation candidate" }],
    evidenceUrlCount: urlCount(p["evidenceUrl"]),
    ...contact(p),
  }),

  "competitor-switch": (p) => ({
    title: str(p["title"]),
    companyKnown: str(p["company"]) !== null,
    intentSignals: [
      {
        kind: "competitor",
        strength: 80,
        reason: `engaging with competitor ${str(p["competitor"]) ?? "?"}`,
      },
    ],
    evidenceUrlCount: urlCount(p["evidenceUrl"]),
    hasEvidenceText: str(p["evidenceText"]) !== null,
    ...contact(p),
  }),

  // v2: exec-title prior inverted here too (44% approval at n=9, matching
  // luma's direction; repo-interest labels are direction-only — bulk-approve
  // heavy — so only the title change is applied, candidateRepos left alone).
  "repo-interest": (p) => ({
    personSignals: minedTitleSignals(str(p["title"])),
    companyKnown: str(p["company"]) !== null,
    intentSignals: [
      {
        kind: "repo-star",
        strength: 60,
        reason: `showed interest in ${str(p["repoLabel"]) ?? str(p["repo"]) ?? "the repo"}`,
      },
    ],
    evidenceUrlCount: urlCount(p["evidenceUrl"]),
    hasEvidenceText: Array.isArray(p["candidateRepos"]) && p["candidateRepos"].length > 0,
    ...contact(p),
  }),

  "breakup-revive": (p) => ({
    companyKnown: str(p["company"]) !== null,
    intentSignals: [
      {
        kind: "prior-engagement",
        strength: 55,
        reason: `prior thread ${num(p["daysCold"]) ?? "?"}d cold`,
      },
    ],
    ageDays: num(p["daysCold"]),
    ...contact(p),
  }),

  "x-repost-intro": xEvidence,
  "x-amplify": xEvidence,
  "x-amplify-dm": xEvidence,

  // gov-solicitation routes here for ptype r/p (Sources Sought / Presolicitation) —
  // the pre-PMF window: the agency is still writing the requirement.
  "sources-sought": (p) => ({
    title: str(p["role"]),
    companyKnown: str(p["agency"]) !== null,
    accountSignals: [
      { kind: "agency", strength: 60, reason: `${str(p["agency"]) ?? "an agency"} notice` },
    ],
    intentSignals: [
      {
        kind: "sources-sought",
        strength: 85,
        reason: `sources sought: ${str(p["title"]) ?? "?"}`,
      },
    ],
    // A response deadline is the actionable date (an upcoming ask, like a
    // Luma event); absent that, fall back to when the notice posted.
    eventAt: str(p["responseDeadline"]) ?? str(p["postedDate"]),
    evidenceUrlCount: urlCount(p["noticeUrl"]),
    hasEvidenceText: str(p["descriptionSnippet"]) !== null,
    ...contact(p),
  }),

  // gov-solicitation routes here for every other ptype (the requirement is
  // already fixed — a weaker window than sources-sought, never stronger).
  "design-partner-loi": (p) => ({
    title: str(p["role"]),
    companyKnown: str(p["agency"]) !== null,
    accountSignals: [
      { kind: "agency", strength: 60, reason: `${str(p["agency"]) ?? "an agency"} notice` },
    ],
    intentSignals: [
      {
        kind: "solicitation",
        strength: 65,
        reason: `${str(p["noticeType"]) ?? "solicitation"}: ${str(p["title"]) ?? "?"}`,
      },
    ],
    eventAt: str(p["responseDeadline"]) ?? str(p["postedDate"]),
    evidenceUrlCount: urlCount(p["noticeUrl"]),
    hasEvidenceText: str(p["descriptionSnippet"]) !== null,
    ...contact(p),
  }),

  "civic-pilot": (p) => ({
    title: str(p["role"]),
    companyKnown: str(p["city"]) !== null,
    accountSignals: [
      {
        kind: "civic",
        strength: 60,
        reason: `${str(p["meetingBody"]) ?? "a city body"} in ${str(p["city"]) ?? "?"}`,
      },
    ],
    intentSignals: [
      {
        kind: "agenda-item",
        strength: 65,
        reason: `agenda item: ${str(p["agendaItemTitle"]) ?? "?"}`,
      },
    ],
    // The meeting date is the upcoming event, same semantics as luma-events.
    eventAt: str(p["meetingDate"]),
    evidenceUrlCount: urlCount(p["meetingUrl"]),
    hasEvidenceText: false,
    ...contact(p),
  }),
};

/**
 * Score a payload for a play, or null when it can't be scored: unknown play
 * (manual/legacy producers), non-object payload, or any adapter/engine throw.
 * NEVER throws — a scoring failure must not block an enqueue or a backfill.
 */
export function safeScorePriority(
  playName: string,
  payload: unknown,
  now: Date = new Date(),
): ProspectPriority | null {
  try {
    const adapter = PRIORITY_ADAPTERS[playName];
    if (!adapter) return null;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
    return computePriority(playName, adapter(payload as Record<string, unknown>), now);
  } catch (err) {
    logEvent("priority.score_failed", {
      play: playName,
      error: ((err as Error).message ?? "unknown").slice(0, 200),
    });
    return null;
  }
}

/**
 * The finders' enqueue choke point: compute the shadow priority, then
 * delegate to `ledger.enqueueTarget` unchanged. Auto-rejections skip scoring
 * — their thin payloads carry no evidence, and a gate must never be argued
 * with by a score.
 */
export function enqueueScoredTarget(
  ledger: Ledger,
  input: Parameters<Ledger["enqueueTarget"]>[0],
): number | null {
  const priority =
    input.initialStatus === "rejected" ? null : safeScorePriority(input.playName, input.payload);
  return ledger.enqueueTarget({ ...input, priority });
}
