import { describe, expect, it } from "vitest";
import type { Ledger } from "@oneshot-gtm/core";
import {
  PRIORITY_ADAPTERS,
  enqueueScoredTarget,
  safeScorePriority,
} from "../src/_priority-adapters.ts";

const NOW = new Date("2026-09-01T12:00:00Z");

/**
 * Every play a registered finder enqueues under. A new finder whose play is
 * missing here (and from PRIORITY_ADAPTERS) fails this suite — add an adapter
 * or an explicit null-path entry below.
 */
const SCORED_PLAYS = [
  "show-hn",
  "post-funding",
  "job-change",
  "hiring-signal",
  "podcast-guest",
  "accelerator-batch",
  "luma-events",
  "stack-consolidation",
  "competitor-switch",
  "repo-interest",
  "breakup-revive",
  "free-pilot",
  "x-repost-intro",
  "x-amplify",
  "x-amplify-dm",
  "new-business",
  "sources-sought",
  "design-partner-loi",
  "civic-pilot",
] as const;

/** Manual/legacy producers that intentionally stay unscored (null path). */
const NULL_PATH_PLAYS = ["profile-intro", "concierge", "demo-no-show"] as const;

/** A realistic enqueue-time payload per play. */
const FIXTURES: Record<(typeof SCORED_PLAYS)[number], Record<string, unknown>> = {
  "show-hn": {
    postTitle: "Show HN: AcmeQL",
    postUrl: "https://news.ycombinator.com/item?id=1",
    founderName: "Sam",
    founderEmail: "sam@acme.dev",
    hookSummary: "SQL for spreadsheets",
    title: "Founder",
    linkedinUrl: "https://linkedin.com/in/sam",
  },
  "post-funding": {
    name: "Ada",
    email: "ada@acme.dev",
    company: "Acme",
    round: "Seed",
    amountUsd: 2_000_000,
    leadInvestor: "Foo Ventures",
    sourceUrl: "https://example.com/press",
    title: "CEO",
  },
  "job-change": {
    name: "Kim",
    email: "kim@acme.dev",
    newRole: "VP Engineering",
    newCompany: "Acme",
    previousRole: "Director",
    previousCompany: "Beta",
    linkedinUrl: "https://linkedin.com/in/kim",
  },
  "hiring-signal": {
    name: "Lee",
    email: "lee@acme.dev",
    company: "Acme",
    jobTitle: "Head of Sales",
    jobPostUrl: "https://acme.dev/jobs/1",
    yourClaim: "we cut ramp time",
    title: "COO",
  },
  "podcast-guest": {
    name: "Pat",
    email: "pat@acme.dev",
    company: "Acme",
    podcast: "Latent Space",
    episodeTitle: "Agents in prod",
    hookQuote: "we rebuilt outbound",
    title: "CTO",
  },
  "accelerator-batch": {
    name: "Ola",
    email: "ola@acme.dev",
    company: "Acme",
    cohort: "YC W26",
    launchUrl: "https://ycombinator.com/launches/1",
    productOneLiner: "agents for accountants",
    title: "Founder",
  },
  "luma-events": {
    name: "Iva",
    email: "iva@acme.dev",
    company: "Acme",
    attendeeBio: "Founder @ Acme",
    role: "Host",
    eventTitle: "SF AI Builders",
    eventDate: "2026-09-03T02:00:00Z",
    eventUrl: "https://lu.ma/x",
  },
  "stack-consolidation": {
    name: "Sam",
    email: "sam@acme.dev",
    company: "Acme",
    vendorStack: "playwright + cypress",
    yourEdge: "one runner",
    evidenceUrl: "https://github.com/acme/repo",
    title: "Staff Engineer",
  },
  "competitor-switch": {
    name: "Sam",
    email: "sam@acme.dev",
    company: "Acme",
    competitor: "RivalCo",
    evidenceUrl: "https://github.com/acme/repo",
    evidenceText: "migrating off RivalCo",
    yourEdge: "cheaper",
    title: "CTO",
  },
  "repo-interest": {
    name: "Sam",
    email: "sam@acme.dev",
    company: "Acme",
    repo: "acme/agent",
    repoLabel: "acme agent",
    yourEdge: "x",
    evidenceUrl: "https://github.com/sam",
    candidateRepos: [{ name: "toolkit", description: null, language: "Rust" }],
    title: "Founder",
  },
  "breakup-revive": {
    name: "Rae",
    email: "rae@acme.dev",
    company: "Acme",
    daysCold: 14,
    lastEventAt: "2026-08-18T00:00:00Z",
  },
  "free-pilot": {
    name: "Dana",
    email: "dana@riverahvac.com",
    company: "Rivera HVAC",
    businessType: "HVAC contractor",
    yourEdge: "free scheduling setup",
    title: "Owner",
  },
  "x-repost-intro": {
    name: "Ken",
    email: "ken@acme.dev",
    title: "Founder",
    handle: "ken",
    twitterUrl: "https://x.com/ken",
    seedHandle: "seed",
    tweetUrl: "https://x.com/seed/status/1",
    tweetText: "great launch",
    mode: "quote",
    followers: 12_300,
    score: 84,
    why: "12.3k followers · reposted",
    dmOpen: true,
  },
  "x-amplify": {
    name: "Ken",
    email: "ken@acme.dev",
    handle: "ken",
    twitterUrl: "https://x.com/ken",
    seedHandle: "seed",
    tweetUrl: "https://x.com/seed/status/1",
    tweetText: "great launch",
    mode: "retweet",
    followers: 900,
    score: 61,
    why: "900 followers",
    launchDate: "2026-08-30T00:00:00Z",
  },
  "x-amplify-dm": {
    name: "Ken",
    handle: "ken",
    twitterUrl: "https://x.com/ken",
    seedHandle: "seed",
    tweetUrl: "https://x.com/seed/status/1",
    tweetText: "great launch",
    mode: "retweet",
    followers: 5_000,
    score: 70,
    why: "5k followers",
    dmOpen: true,
  },
  "new-business": {
    name: "Rae's Dental",
    email: "rae@raesdental.com",
    company: "Rae's Dental",
    source: "nppes",
    sourceLabel: "NPPES Dentist (NY)",
    matchedDateIso: "2026-08-25T00:00:00Z",
    yourEdge: "we set it up free, you keep it if it works",
    title: "Owner",
  },
  "sources-sought": {
    agency: "GENERAL SERVICES ADMINISTRATION",
    noticeNumber: "47PF0018R0023",
    noticeType: "Sources Sought",
    title: "AI-assisted document review pilot",
    naicsCode: "541511",
    name: "Jesse L. Jones",
    email: "jesse.jones@gsa.gov",
    role: "Contracting Officer",
    noticeUrl: "https://sam.gov/opp/abc/view",
    postedDate: "2026-08-01",
    responseDeadline: "2026-09-01",
    descriptionSnippet: "The agency seeks sources capable of...",
    yourEdge: "we cut review time in half",
  },
  "design-partner-loi": {
    agency: "DEPARTMENT OF VETERANS AFFAIRS",
    noticeNumber: "36C10G26Q0001",
    noticeType: "Solicitation",
    title: "Records digitization support",
    naicsCode: "541511",
    name: "Pat Reyes",
    email: "pat.reyes@va.gov",
    role: "Contract Specialist",
    noticeUrl: "https://sam.gov/opp/def/view",
    postedDate: "2026-08-05",
    yourEdge: "we cut review time in half",
  },
  "civic-pilot": {
    city: "New York",
    agendaItemTitle: "Resolution on AI use in city permitting",
    meetingBody: "CITY COUNCIL",
    meetingDate: "2026-09-10",
    meetingUrl: "https://nyc.legistar.com/MeetingDetail.aspx?ID=1",
    name: "Alex Chen",
    email: "alex.chen@council.nyc.gov",
    role: "Chief of Staff",
    yourEdge: "a free 30-day pilot",
  },
};

describe("adapter registry coverage", () => {
  it("has an adapter for every finder-produced play and nothing unaccounted for", () => {
    expect(Object.keys(PRIORITY_ADAPTERS).toSorted()).toEqual([...SCORED_PLAYS].toSorted());
    for (const play of NULL_PATH_PLAYS) {
      expect(PRIORITY_ADAPTERS[play]).toBeUndefined();
    }
  });
});

describe("per-play adapters", () => {
  for (const play of SCORED_PLAYS) {
    it(`${play}: fixture payload → valid heuristic-v1 artifact`, () => {
      const p = safeScorePriority(play, FIXTURES[play], NOW);
      expect(p).not.toBeNull();
      expect(p!.version).toBe("heuristic-v2");
      expect(p!.finder).toBe(play);
      expect(p!.scoredAt).toBe(NOW.toISOString());
      expect(Number.isInteger(p!.total)).toBe(true);
      expect(p!.total).toBeGreaterThanOrEqual(0);
      expect(p!.total).toBeLessThanOrEqual(100);
      expect(p!.reasons.length).toBeGreaterThan(0);
      for (const v of Object.values(p!.components)) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    });

    it(`${play}: empty payload degrades to a neutral artifact, no throw`, () => {
      const p = safeScorePriority(play, {}, NOW);
      expect(p).not.toBeNull();
      expect(p!.total).toBeGreaterThanOrEqual(0);
      expect(p!.total).toBeLessThanOrEqual(100);
    });
  }

  it("x lanes: the lane-local XScoredCandidate.score never leaks into the total", () => {
    const low = safeScorePriority(
      "x-repost-intro",
      { ...FIXTURES["x-repost-intro"], score: 5 },
      NOW,
    );
    const high = safeScorePriority(
      "x-repost-intro",
      { ...FIXTURES["x-repost-intro"], score: 95 },
      NOW,
    );
    expect(low).toEqual(high);
  });
});

describe("safeScorePriority degraded paths", () => {
  it("returns null for unknown plays and non-object payloads", () => {
    expect(safeScorePriority("profile-intro", FIXTURES["show-hn"], NOW)).toBeNull();
    expect(safeScorePriority("show-hn", "not an object", NOW)).toBeNull();
    expect(safeScorePriority("show-hn", null, NOW)).toBeNull();
    expect(safeScorePriority("show-hn", [1, 2], NOW)).toBeNull();
  });

  it("returns null instead of throwing when an adapter blows up", () => {
    PRIORITY_ADAPTERS["boom-test"] = () => {
      throw new Error("adapter bug");
    };
    try {
      expect(safeScorePriority("boom-test", {}, NOW)).toBeNull();
    } finally {
      delete PRIORITY_ADAPTERS["boom-test"];
    }
  });
});

describe("enqueueScoredTarget", () => {
  function captureLedger() {
    const calls: Array<Record<string, unknown>> = [];
    const ledger = {
      enqueueTarget: (input: Record<string, unknown>) => {
        calls.push(input);
        return 42;
      },
    } as unknown as Ledger;
    return { ledger, calls };
  }

  it("attaches a computed priority on the normal path", () => {
    const { ledger, calls } = captureLedger();
    const id = enqueueScoredTarget(ledger, {
      playName: "show-hn",
      payload: FIXTURES["show-hn"],
      dedupeKey: "k",
      source: "find:show-hn",
    });
    expect(id).toBe(42);
    const priority = calls[0]!["priority"] as Record<string, unknown>;
    expect(priority["version"]).toBe("heuristic-v2");
    expect(priority["finder"]).toBe("show-hn");
  });

  it("skips scoring for auto-rejections — a gate is never argued with", () => {
    const { ledger, calls } = captureLedger();
    enqueueScoredTarget(ledger, {
      playName: "show-hn",
      payload: { postTitle: "x" },
      dedupeKey: "k",
      source: "find:show-hn",
      notes: "auto: ICP — off-topic",
      initialStatus: "rejected",
    });
    expect(calls[0]!["priority"]).toBeNull();
  });

  it("degrades to a null priority for unscorable payloads without blocking the enqueue", () => {
    const { ledger, calls } = captureLedger();
    const id = enqueueScoredTarget(ledger, {
      playName: "profile-intro",
      payload: { name: "x" },
      dedupeKey: "k",
      source: "manual",
    });
    expect(id).toBe(42);
    expect(calls[0]!["priority"]).toBeNull();
  });
});

describe("review-hardened evidence edges", () => {
  it("post-funding treats amountUsd 0 as the missing-amount sentinel, never '$0'", () => {
    const p = safeScorePriority("post-funding", { ...FIXTURES["post-funding"], amountUsd: 0 }, NOW);
    expect(p!.reasons.join(" ")).not.toContain("$0");
  });

  it("x lanes score freshness neutral — launchDate must not decay a fresh repost", () => {
    const p = safeScorePriority(
      "x-amplify",
      { ...FIXTURES["x-amplify"], launchDate: "2020-01-01T00:00:00Z" },
      NOW,
    );
    expect(p!.components.timingFreshness).toBe(50);
  });
});

describe("v2 label-mined adapter priors", () => {
  it("luma: exec titles score DOWN, Host scores below Guest, bios no longer feed seniority", () => {
    const exec = safeScorePriority(
      "luma-events",
      { ...FIXTURES["luma-events"], title: "CEO", attendeeBio: "AI enthusiast" },
      NOW,
    )!;
    expect(exec.components.personFit).toBe(35);
    const host = safeScorePriority("luma-events", FIXTURES["luma-events"], NOW)!;
    const guest = safeScorePriority(
      "luma-events",
      { ...FIXTURES["luma-events"], role: "Guest" },
      NOW,
    )!;
    expect(host.components.intentStrength).toBe(45);
    expect(guest.components.intentStrength).toBe(65);
    // A founder-looking bio alone no longer inflates personFit (measured flat).
    const bioOnly = safeScorePriority(
      "luma-events",
      { ...FIXTURES["luma-events"], title: undefined },
      NOW,
    )!;
    expect(bioOnly.components.personFit).toBe(50);
  });

  it("repo-interest: exec-title prior inverted, non-exec titles neutral", () => {
    const exec = safeScorePriority(
      "repo-interest",
      { ...FIXTURES["repo-interest"], title: "CTO" },
      NOW,
    )!;
    expect(exec.components.personFit).toBe(35);
    const ic = safeScorePriority(
      "repo-interest",
      { ...FIXTURES["repo-interest"], title: "ML Engineer" },
      NOW,
    )!;
    expect(ic.components.personFit).toBe(50);
  });
});

describe("new-business / free-pilot — matchedDateIso feeds timing freshness", () => {
  it("new-business: a fresh matchedDateIso scores timingFreshness high, not neutral", () => {
    const fresh = safeScorePriority(
      "new-business",
      {
        ...FIXTURES["new-business"],
        matchedDateIso: new Date(NOW.getTime() - 86_400_000).toISOString(),
      },
      NOW,
    )!;
    expect(fresh.components.timingFreshness).toBe(90);
  });

  it("new-business: an old matchedDateIso decays timingFreshness, not neutral", () => {
    const old = safeScorePriority(
      "new-business",
      {
        ...FIXTURES["new-business"],
        matchedDateIso: new Date(NOW.getTime() - 200 * 86_400_000).toISOString(),
      },
      NOW,
    )!;
    expect(old.components.timingFreshness).toBe(25);
  });

  it("free-pilot: a fresh matchedDateIso scores timingFreshness high, not neutral", () => {
    const fresh = safeScorePriority(
      "free-pilot",
      {
        ...FIXTURES["free-pilot"],
        matchedDateIso: new Date(NOW.getTime() - 86_400_000).toISOString(),
      },
      NOW,
    )!;
    expect(fresh.components.timingFreshness).toBe(90);
  });

  it("free-pilot: a missing matchedDateIso still degrades to neutral, no throw", () => {
    const missing = safeScorePriority(
      "free-pilot",
      { ...FIXTURES["free-pilot"], matchedDateIso: undefined },
      NOW,
    )!;
    expect(missing.components.timingFreshness).toBe(50);
  });
});

describe("free-pilot — sourceLabel is registry metadata, not evidence text", () => {
  it("does not overstate signalConfidence off sourceLabel alone", () => {
    const p = safeScorePriority("free-pilot", FIXTURES["free-pilot"], NOW)!;
    // sourceLabel is always present on a real registry payload, so this
    // pins the pre-fix regression: hasEvidenceText must NOT be derived from
    // it (finding PRRT_kwDOSKzrBs6exPH9). Neutral == no evidenceUrlCount and
    // no genuine quoted-evidence signal.
    expect(p.components.signalConfidence).toBe(50);
  });
});
