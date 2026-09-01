import { type Ledger, type ProspectPriority, logEvent } from "@oneshot-gtm/core";
import { type PriorityEvidence, type PrioritySignal, computePriority } from "./_priority.ts";

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
    const strength = followers >= 10_000 ? 70 : followers >= 1_000 ? 60 : 45;
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
    eventAt: str(p["launchDate"]),
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
      amount !== null ? fmtUsd(amount) : null,
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

  "luma-events": (p) => {
    const role = str(p["role"]);
    return {
      title: str(p["title"]),
      seniorityHint: str(p["attendeeBio"]),
      companyKnown: str(p["company"]) !== null,
      intentSignals: [
        {
          kind: "event",
          strength: role === "Host" ? 75 : 65,
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

  "repo-interest": (p) => ({
    title: str(p["title"]),
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
