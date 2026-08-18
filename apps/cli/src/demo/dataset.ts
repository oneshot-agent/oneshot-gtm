import { cadenceGoalId } from "@oneshot-gtm/core";

/**
 * The demo install, as pure data. No I/O — `seed.ts` writes it.
 *
 * Two rules hold this file together:
 *
 * 1. **Deterministic.** Every timestamp is an offset from the anchor the caller
 *    passes, and there is no `Math.random` anywhere. Seeding twice with the same
 *    anchor produces the same ledger, so a re-shoot matches the first take and
 *    the tests can assert on exact rows.
 *
 * 2. **Two timestamp formats, matched to what production writes.** Columns whose
 *    value comes from the `datetime('now')` DEFAULT (`created_at`, `found_at`,
 *    `enrolled_at`, `recorded_at`, …) get SQLite's `YYYY-MM-DD HH:MM:SS`; columns
 *    the app writes with `toISOString()` (`next_due_at`, `reviewed_at`,
 *    `triggers.last_polled_at`, `runs.started_at`, `bounced_at`, …) get ISO.
 *    Mixing them silently breaks the string comparisons those columns are read
 *    with — `next_due_at <= ?` and friends.
 *
 * The cast extends the one already in `examples/*.json` (Jane Founder / Acme,
 * Sam Builder / Beacon, Rae Kim / Stellar, Jordan Lee / Acme Data, Priya Shah /
 * Northstar AI) so the sample target files and the demo tell one story.
 */

const DAY_MS = 86_400_000;

/** ISO — for columns the app writes with `new Date().toISOString()`. */
function isoAt(anchor: Date, daysAgo: number, hour: number, minute: number): string {
  const d = new Date(anchor.getTime() - daysAgo * DAY_MS);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

/** SQLite `datetime('now')` format — for columns filled by the column DEFAULT. */
function sqlAt(anchor: Date, daysAgo: number, hour: number, minute: number): string {
  return isoAt(anchor, daysAgo, hour, minute).slice(0, 19).replace("T", " ");
}

/** ISO, minutes before the anchor — for trigger poll times, see buildTriggers. */
function isoMinutesAgo(anchor: Date, minutesAgo: number): string {
  return new Date(anchor.getTime() - minutesAgo * 60_000).toISOString();
}

/** Deterministic minute-of-hour so rows don't all share a timestamp. */
function jitter(i: number): number {
  return (i * 37) % 60;
}

// ---------------------------------------------------------------------------
// Founder
// ---------------------------------------------------------------------------

// A fictional dev-tools founder, deliberately selling something OTHER than
// OneShot so a viewer never confuses the demo product with the tool being demoed.
export const DEMO_FOUNDER = {
  name: "Mira Vance",
  email: "mira@tracepoint.dev",
  product: "Tracepoint",
  oneLiner: "Drop-in distributed tracing for background jobs — no sampling, no agent.",
  productDomain: "tracepoint.dev",
  sendingDomain: "tracepoint.email",
  icp: "Seed to Series A dev-tool and AI-infra startups running background job queues in production, where a founding or staff engineer owns reliability.",
} as const;

const IDENTITY_PRIMARY = "oneshot:mira@tracepoint.email";
const IDENTITY_SECOND = "oneshot:hey@tracepoint.email";
const IDENTITY_WARMING = "oneshot:mira@trace-mail.dev";

// OneShot identities only. A Gmail identity would need a stored refresh token
// and a live profile call for `doctor` to read green, and faking OAuth is well
// past what a screenshot is worth.
const IDENTITIES = [
  {
    id: IDENTITY_PRIMARY,
    provider: "oneshot",
    label: "Mira · tracepoint.email",
    sendingDomain: "tracepoint.email",
    mailbox: "mira",
    maxPerDay: 50,
    warmup: { startPerDay: 10, incrementPerWeek: 10 },
  },
  {
    id: IDENTITY_SECOND,
    provider: "oneshot",
    label: "Hey · tracepoint.email",
    sendingDomain: "tracepoint.email",
    mailbox: "hey",
    maxPerDay: 50,
    warmup: { startPerDay: 10, incrementPerWeek: 10 },
  },
  {
    id: IDENTITY_WARMING,
    provider: "oneshot",
    label: "Mira · trace-mail.dev (warming)",
    sendingDomain: "trace-mail.dev",
    mailbox: "mira",
    maxPerDay: 30,
    warmup: { startPerDay: 10, incrementPerWeek: 10 },
  },
];

// ---------------------------------------------------------------------------
// Cast
// ---------------------------------------------------------------------------

type CadenceStatus = "active" | "replied" | "breakup" | "completed" | "bounced";

interface DemoPerson {
  name: string;
  email: string;
  company: string;
  title: string;
  play: string;
  source: string;
  linkedin: string | null;
  /** Why this person surfaced — becomes the receipt memo and the dossier hook. */
  hook: string;
  /** Days before the anchor that the first touch went out. */
  daysAgo: number;
  /** Emails actually sent (intro + follow-ups). current_step is steps - 1. */
  steps: number;
  status: CadenceStatus;
  identity: string;
  outcome?: {
    kind: "meeting_booked" | "sql_qualified" | "deal_won" | "ghosted";
    amountUsd?: number;
    daysAgo: number;
    notes: string;
  };
  /** Drives the inbox fixture. Only set on `replied` rows. */
  reply?: { daysAgo: number; hour: number; subject: string; body: string };
}

const PEOPLE: DemoPerson[] = [
  {
    name: "Jane Founder",
    email: "jane@acme.dev",
    company: "Acme",
    title: "Co-founder / CTO",
    play: "show-hn",
    source: "show-hn",
    linkedin: "https://linkedin.com/in/jane-founder-fake",
    hook: "Show HN for open-source durable workflows for AI agents; defended the Postgres queue choice at 1k concurrent jobs.",
    daysAgo: 26,
    steps: 2,
    status: "replied",
    identity: IDENTITY_PRIMARY,
    outcome: {
      kind: "meeting_booked",
      daysAgo: 21,
      notes: "30 min Thursday, wants to see span capture on their worker pool.",
    },
    reply: {
      daysAgo: 23,
      hour: 14,
      subject: "Re: your Postgres queue answer in the HN thread",
      body: "Ha, that thread ate my whole afternoon. We are at about 1k concurrent jobs and the thing I actually cannot see is which step in a chain is slow. If Tracepoint does that without a sidecar I want a look. Thursday works.",
    },
  },
  {
    name: "Sam Builder",
    email: "sam@beacon.run",
    company: "Beacon",
    title: "Founder",
    play: "show-hn",
    source: "show-hn",
    linkedin: "https://linkedin.com/in/sam-builder-fake",
    hook: "Show HN: distributed cron with at-least-once semantics; shipped v1 with no dashboard on purpose.",
    daysAgo: 5,
    steps: 1,
    status: "active",
    identity: IDENTITY_PRIMARY,
  },
  {
    name: "Rae Kim",
    email: "rae@stellar.dev",
    company: "Stellar",
    title: "Co-founder",
    play: "podcast-guest",
    source: "podcast-guest",
    linkedin: "https://linkedin.com/in/rae-kim-fake",
    hook: "Latent Space, 'The economics of agent infra' — argued the eval suite is the moat, not the model.",
    daysAgo: 19,
    steps: 2,
    status: "replied",
    identity: IDENTITY_SECOND,
    outcome: {
      kind: "sql_qualified",
      daysAgo: 15,
      notes: "Budget confirmed, wants a security review before a pilot.",
    },
    reply: {
      daysAgo: 17,
      hour: 11,
      subject: "Re: the eval-cost argument from 38:20",
      body: "Nice catch on the timestamp, most people who mail me about that episode have clearly not listened to it. Deterministic per-call cost is exactly the problem. Send me whatever you have on the security posture and I will route it internally.",
    },
  },
  {
    name: "Jordan Lee",
    email: "jordan@acmedata.io",
    company: "Acme Data",
    title: "Head of Platform",
    play: "job-change",
    source: "job-change",
    linkedin: "https://linkedin.com/in/jordan-lee-fake",
    hook: "Moved from Staff Engineer, Infra at Stripe to Head of Platform — first 90 days, owns reliability.",
    daysAgo: 4,
    steps: 1,
    status: "active",
    identity: IDENTITY_PRIMARY,
  },
  {
    name: "Priya Shah",
    email: "priya@northstar.ai",
    company: "Northstar AI",
    title: "VP Engineering",
    play: "competitor-switch",
    source: "competitor-switch",
    linkedin: "https://linkedin.com/in/priya-shah-fake",
    hook: "Public G2 review complaining that their current tracing vendor samples away the failures they care about.",
    daysAgo: 24,
    steps: 3,
    status: "replied",
    identity: IDENTITY_PRIMARY,
    outcome: {
      kind: "deal_won",
      amountUsd: 4800,
      daysAgo: 9,
      notes: "Annual, 12 months up front. Started on the worker fleet only.",
    },
    reply: {
      daysAgo: 20,
      hour: 9,
      subject: "Re: the sampling complaint in your G2 review",
      body: "You are the first person to email me about that review instead of about a renewal. Sampling is the whole problem — the traces we lose are the ones from the runs that failed. What does pricing look like for about forty workers?",
    },
  },
  {
    name: "Marco Ruiz",
    email: "marco@quaydb.com",
    company: "QuayDB",
    title: "Co-founder / CEO",
    play: "post-funding",
    source: "post-funding-auto",
    linkedin: "https://linkedin.com/in/marco-ruiz-fake",
    hook: "Raised a $6M seed to build a managed Postgres branching service; hiring infra now.",
    daysAgo: 22,
    steps: 3,
    status: "breakup",
    identity: IDENTITY_SECOND,
  },
  {
    name: "Lena Fischer",
    email: "lena@sift.works",
    company: "Sift",
    title: "Founding Engineer",
    play: "hiring-signal",
    source: "hiring-signal",
    linkedin: "https://linkedin.com/in/lena-fischer-fake",
    hook: "Open Ashby role for a Founding Reliability Engineer — the job description names background-job visibility as the first project.",
    daysAgo: 6,
    steps: 2,
    status: "active",
    identity: IDENTITY_PRIMARY,
  },
  {
    name: "Tobi Adeyemi",
    email: "tobi@relaykit.dev",
    company: "RelayKit",
    title: "Founder",
    play: "repo-interest",
    source: "github-stars",
    linkedin: "https://linkedin.com/in/tobi-adeyemi-fake",
    hook: "Starred an adjacent OpenTelemetry worker-instrumentation repo three days after publishing their own queue library.",
    daysAgo: 27,
    steps: 3,
    status: "completed",
    identity: IDENTITY_SECOND,
  },
  {
    name: "Hana Sato",
    email: "hana@obsidianflow.io",
    company: "Obsidian Flow",
    title: "CTO",
    play: "luma-events",
    source: "luma-events",
    linkedin: "https://linkedin.com/in/hana-sato-fake",
    hook: "Hosting an AI-infra meetup in SF next week; the listing describes their pipeline as 'mostly cron and hope'.",
    daysAgo: 3,
    steps: 1,
    status: "active",
    identity: IDENTITY_PRIMARY,
  },
  {
    name: "Dmitri Volkov",
    email: "dmitri@cascade.systems",
    company: "Cascade Systems",
    title: "Co-founder / CTO",
    play: "post-funding",
    source: "post-funding-auto",
    linkedin: "https://linkedin.com/in/dmitri-volkov-fake",
    hook: "Series A for an agent-orchestration platform; the announcement calls out reliability as the year's focus.",
    daysAgo: 12,
    steps: 2,
    status: "replied",
    identity: IDENTITY_PRIMARY,
    outcome: {
      kind: "meeting_booked",
      daysAgo: 8,
      notes: "Intro call booked with them plus their staff SRE.",
    },
    reply: {
      daysAgo: 10,
      hour: 16,
      subject: "Re: reliability as the year's focus",
      body: "Timing is uncomfortable, we spent Tuesday arguing about exactly this. Can you do next week with our SRE on the call? He will have harder questions than me.",
    },
  },
  {
    name: "Ana Lopes",
    email: "ana@driftline.ai",
    company: "Driftline",
    title: "Founder",
    play: "show-hn",
    source: "show-hn",
    linkedin: null,
    hook: "Show HN for a serverless inference router; the thread is all about tail latency.",
    daysAgo: 15,
    steps: 1,
    status: "bounced",
    identity: IDENTITY_SECOND,
  },
  {
    name: "Owen Byrne",
    email: "owen@pinch.dev",
    company: "Pinch",
    title: "Director of Engineering",
    play: "job-change",
    source: "job-change",
    linkedin: "https://linkedin.com/in/owen-byrne-fake",
    hook: "Joined as Director of Engineering from Datadog — knows what good tracing feels like and does not have it here.",
    daysAgo: 8,
    steps: 2,
    status: "active",
    identity: IDENTITY_SECOND,
  },
  {
    name: "Yara Haddad",
    email: "yara@kelp.systems",
    company: "Kelp",
    title: "Co-founder",
    play: "hiring-signal",
    source: "hiring-signal",
    linkedin: "https://linkedin.com/in/yara-haddad-fake",
    hook: "Two Greenhouse listings for platform engineers, both mentioning 'observability for async workloads'.",
    daysAgo: 25,
    steps: 3,
    status: "breakup",
    identity: IDENTITY_PRIMARY,
  },
  {
    name: "Nils Berg",
    email: "nils@fenwick.sh",
    company: "Fenwick",
    title: "Founder",
    play: "podcast-guest",
    source: "podcast-guest",
    linkedin: "https://linkedin.com/in/nils-berg-fake",
    hook: "On 20VC describing a three-day outage they could not reconstruct after the fact.",
    daysAgo: 7,
    steps: 2,
    status: "replied",
    identity: IDENTITY_PRIMARY,
    reply: {
      daysAgo: 3,
      hour: 15,
      subject: "Re: the outage you described on 20VC",
      body: "Three days, and we still do not really know what happened on day one. I am not in a hurry to relive it, but I am in a hurry to not repeat it. What does setup actually look like on a Celery fleet?",
    },
  },
  {
    name: "Ines Moreau",
    email: "ines@baseplate.dev",
    company: "Baseplate",
    title: "VP Platform",
    play: "competitor-switch",
    source: "competitor-switch",
    linkedin: "https://linkedin.com/in/ines-moreau-fake",
    hook: "Wrote a public postmortem blaming per-host pricing for turning off tracing on the worker fleet.",
    daysAgo: 10,
    steps: 2,
    status: "replied",
    identity: IDENTITY_SECOND,
    outcome: {
      kind: "meeting_booked",
      daysAgo: 2,
      notes: "Tuesday, wants the per-job pricing model in writing first.",
    },
    reply: {
      daysAgo: 4,
      hour: 12,
      subject: "Re: the line in your postmortem about per-host pricing",
      body: "You read the whole postmortem, which puts you ahead of our own board. Per-job pricing is the thing that would let me turn tracing back on for the workers. Send me the model and let us book something.",
    },
  },
  {
    name: "Kwame Mensah",
    email: "kwame@triacore.io",
    company: "Triacore",
    title: "Staff Engineer",
    play: "repo-interest",
    source: "github-stars",
    linkedin: "https://linkedin.com/in/kwame-mensah-fake",
    hook: "Starred the job-queue instrumentation repo and opened an issue about missing span context across retries.",
    daysAgo: 17,
    steps: 2,
    status: "replied",
    identity: IDENTITY_PRIMARY,
    outcome: {
      kind: "meeting_booked",
      daysAgo: 13,
      notes: "Technical deep dive; he wants to see retry span linking specifically.",
    },
    reply: {
      daysAgo: 14,
      hour: 10,
      subject: "Re: your retry-context issue",
      body: "That issue has been open for four months with no answer, so this is already better support than upstream. Retry span linking is the entire reason I filed it. Show me.",
    },
  },
  {
    name: "Sofia Rossi",
    email: "sofia@quarry.build",
    company: "Quarry",
    title: "Head of Infrastructure",
    play: "luma-events",
    source: "luma-events",
    linkedin: "https://linkedin.com/in/sofia-rossi-fake",
    hook: "Featured speaker at a Berlin platform-engineering event; talk abstract is about async debugging.",
    daysAgo: 28,
    steps: 3,
    status: "completed",
    identity: IDENTITY_SECOND,
  },
  {
    name: "Ravi Menon",
    email: "ravi@stanchion.dev",
    company: "Stanchion",
    title: "Co-founder / CTO",
    play: "post-funding",
    source: "post-funding-auto",
    linkedin: "https://linkedin.com/in/ravi-menon-fake",
    hook: "Seed round for a data-contract enforcement tool; scaling from three to eleven engineers.",
    daysAgo: 2,
    steps: 1,
    status: "active",
    identity: IDENTITY_PRIMARY,
  },
  {
    name: "Elin Dahl",
    email: "elin@northport.works",
    company: "Northport",
    title: "Founder",
    play: "show-hn",
    source: "show-hn",
    linkedin: "https://linkedin.com/in/elin-dahl-fake",
    hook: "Show HN for an open-source workflow engine; top comment asks how they debug a stuck run.",
    daysAgo: 1,
    steps: 1,
    status: "active",
    identity: IDENTITY_PRIMARY,
  },
  {
    name: "Bruno Castro",
    email: "bruno@aperture-labs.dev",
    company: "Aperture Labs",
    title: "Head of Engineering",
    play: "job-change",
    source: "job-change",
    linkedin: "https://linkedin.com/in/bruno-castro-fake",
    hook: "Stepped into Head of Engineering after the previous lead left mid-migration.",
    daysAgo: 21,
    steps: 3,
    status: "breakup",
    identity: IDENTITY_SECOND,
  },
  {
    name: "Mei Tanaka",
    email: "mei@keelson.io",
    company: "Keelson",
    title: "Founding Engineer",
    play: "hiring-signal",
    source: "hiring-signal",
    linkedin: "https://linkedin.com/in/mei-tanaka-fake",
    hook: "Lever posting for an SRE whose first listed responsibility is 'make the nightly pipeline explainable'.",
    daysAgo: 9,
    steps: 2,
    status: "active",
    identity: IDENTITY_WARMING,
  },
  {
    name: "Felix Braun",
    email: "felix@waypost.dev",
    company: "Waypost",
    title: "Co-founder",
    play: "repo-interest",
    source: "github-stars",
    linkedin: "https://linkedin.com/in/felix-braun-fake",
    hook: "Starred two OpenTelemetry worker repos in one week while shipping a queue rewrite.",
    daysAgo: 6,
    steps: 1,
    status: "active",
    identity: IDENTITY_WARMING,
  },
  {
    name: "Aisha Rahman",
    email: "aisha@tidewater.build",
    company: "Tidewater",
    title: "CTO",
    play: "podcast-guest",
    source: "podcast-guest",
    linkedin: "https://linkedin.com/in/aisha-rahman-fake",
    hook: "On Lenny's Podcast: 'we ship fast and find out on Monday what broke on Saturday'.",
    daysAgo: 20,
    steps: 2,
    status: "replied",
    identity: IDENTITY_PRIMARY,
    outcome: {
      kind: "deal_won",
      amountUsd: 7200,
      daysAgo: 5,
      notes: "Two-year, paid annually. Rolled out fleet-wide in week one.",
    },
    reply: {
      daysAgo: 18,
      hour: 8,
      subject: "Re: 'find out on Monday what broke on Saturday'",
      body: "I regret saying that line on a podcast and I stand by it completely. Yes — send pricing. If this works on our Saturday batch run we will buy it this quarter.",
    },
  },
  {
    name: "Piotr Nowak",
    email: "piotr@grainline.dev",
    company: "Grainline",
    title: "Founder",
    play: "luma-events",
    source: "luma-events",
    linkedin: "https://linkedin.com/in/piotr-nowak-fake",
    hook: "Listed as a guest at a Warsaw AI-infra dinner; builds ETL for model training runs.",
    daysAgo: 13,
    steps: 1,
    status: "bounced",
    identity: IDENTITY_SECOND,
  },
];

// ---------------------------------------------------------------------------
// Cost model
// ---------------------------------------------------------------------------

// Plausible per-call USD, in the same order of magnitude as real OneShot calls.
// The whole 30-day install lands around $6 of spend, which is the point of the
// Measure page: CAC in single-digit dollars, attested per call.
const COST: Record<string, number> = {
  "web.search": 0.012,
  "email.find": 0.02,
  "email.verify": 0.008,
  "enrich.profile": 0.05,
  "research.person": 0.12,
  "email.send": 0.004,
};

/** Follow-up spacing, in days after the intro. */
const STEP_OFFSETS = [0, 3, 7];

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface DemoReceipt {
  id: number;
  playName: string;
  callType: string;
  costUsd: number;
  signedReceipt: unknown;
  oneshotRequestId: string;
  senderIdentity: string | null;
  memo: string;
  decisionContext: unknown;
  valueTag: unknown | null;
  valueTaggedAt: string | null;
  goalId: string;
  createdAt: string;
}

export interface DemoProspectRow {
  id: number;
  name: string;
  email: string;
  company: string;
  linkedinUrl: string | null;
  dossierJson: string;
  source: string;
  sourceProfileUrl: string | null;
  createdAt: string;
}

export interface DemoSequenceEvent {
  prospectId: number;
  playName: string;
  stepIndex: number;
  channel: string;
  status: string;
  metadataJson: string;
  receiptId: number;
  createdAt: string;
}

export interface DemoCadence {
  prospectId: number;
  playName: string;
  currentStep: number;
  status: string;
  enrolledAt: string;
  nextDueAt: string | null;
  nextStepDraftJson: string | null;
  nextStepDraftedAt: string | null;
}

export interface DemoDataset {
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  prospects: DemoProspectRow[];
  receipts: DemoReceipt[];
  sequenceEvents: DemoSequenceEvent[];
  cadences: DemoCadence[];
  outcomes: Array<{
    prospectId: number;
    playName: string;
    outcome: string;
    amountUsd: number | null;
    notes: string;
    recordedAt: string;
  }>;
  queue: Array<{
    playName: string;
    payloadJson: string;
    dedupeKey: string;
    source: string;
    status: string;
    foundAt: string;
    reviewedAt: string | null;
    sentAt: string | null;
    notes: string | null;
    prospectId: number | null;
    lastDraftJson: string | null;
    lastDraftedAt: string | null;
  }>;
  triggers: Array<{
    name: string;
    lastPolledAt: string | null;
    lastRunSummary: string | null;
    enabled: number;
    configJson: string;
  }>;
  runs: Array<{
    playName: string;
    dryRun: number;
    status: string;
    startedAt: string;
    completedAt: string;
    targetCount: number;
    draftedCount: number;
    sentCount: number;
    errorCount: number;
    targetsJson: string;
    eventsJson: string;
    prospectEmailsJson: string;
  }>;
  bounces: Array<{
    messageId: string;
    recipient: string;
    identityId: string;
    kind: string;
    statusCode: string;
    diagnostic: string;
    prospectId: number;
    bouncedAt: string;
    createdAt: string;
  }>;
  canaries: Array<{
    fromIdentity: string;
    toIdentity: string;
    placement: string;
    labelsJson: string;
    spf: string;
    dkim: string;
    dmarc: string;
    subject: string;
    sourcePlay: string;
    sameDomain: number;
    latencyMs: number;
    createdAt: string;
  }>;
  senderAssignments: Array<{ email: string; identityId: string; assignedAt: string }>;
  inboxDrafts: Array<{
    threadKey: string;
    inboundEmailId: string;
    toEmail: string;
    subject: string;
    identityId: string;
    body: string;
    updatedAt: string;
  }>;
  inboxSent: Array<{
    threadKey: string;
    toEmail: string;
    subject: string;
    body: string;
    identityId: string;
    requestId: string;
    sentAt: string;
  }>;
  interviews: Array<{
    person: string;
    transcriptPath: string | null;
    jtbd: string;
    painQuotesJson: string;
    createdAt: string;
  }>;
  fixtures: {
    "inbox.json": unknown;
    "rocs-by-goal.json": unknown;
    "domains.json": unknown;
    "balance.json": unknown;
  };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildDemoDataset(anchor: Date): DemoDataset {
  const prospects: DemoProspectRow[] = [];
  const receipts: DemoReceipt[] = [];
  const sequenceEvents: DemoSequenceEvent[] = [];
  const cadences: DemoCadence[] = [];
  const outcomes: DemoDataset["outcomes"] = [];
  const senderAssignments: DemoDataset["senderAssignments"] = [];

  let receiptId = 0;

  PEOPLE.forEach((p, i) => {
    const prospectId = i + 1;
    const goalId = cadenceGoalId(p.play, p.email);
    const valueTag = p.outcome ? outcomeValueTag(p.outcome) : null;
    const valueTaggedAt = p.outcome ? sqlAt(anchor, p.outcome.daysAgo, 17, jitter(i)) : null;

    prospects.push({
      id: prospectId,
      name: p.name,
      email: p.email,
      company: p.company,
      linkedinUrl: p.linkedin,
      dossierJson: JSON.stringify({
        title: p.title,
        company: p.company,
        hook: p.hook,
        source: p.source,
      }),
      source: p.source,
      sourceProfileUrl: p.linkedin,
      createdAt: sqlAt(anchor, p.daysAgo, 8, jitter(i)),
    });

    senderAssignments.push({
      email: p.email,
      identityId: p.identity,
      assignedAt: sqlAt(anchor, p.daysAgo, 8, jitter(i)),
    });

    // Discovery + contact resolution, all on the day the finder surfaced them.
    const prep: Array<{ callType: string; memo: string }> = [
      { callType: "web.search", memo: `${p.play} — surface ${p.company} from ${p.source}` },
      { callType: "email.find", memo: `${p.play} — resolve contact for ${p.name}` },
      { callType: "email.verify", memo: `${p.play} — verify ${p.email} before sending` },
      { callType: "enrich.profile", memo: `${p.play} — enrich ${p.name} for the draft` },
    ];
    // A deep person-research call on the higher-intent plays only, which is how
    // the spend actually distributes: you don't pay $0.12 to research a Show HN
    // poster whose whole pitch is in the thread.
    if (p.play === "competitor-switch" || p.play === "podcast-guest") {
      prep.push({ callType: "research.person", memo: `${p.play} — dossier for ${p.name}` });
    }

    prep.forEach((call, k) => {
      receiptId += 1;
      receipts.push({
        id: receiptId,
        playName: p.play,
        callType: call.callType,
        costUsd: COST[call.callType] ?? 0.01,
        signedReceipt: signedReceiptFor(call.callType, p, receiptId),
        oneshotRequestId: `req_demo_${String(receiptId).padStart(5, "0")}`,
        senderIdentity: null,
        memo: call.memo,
        decisionContext: {
          playName: p.play,
          callType: call.callType,
          goalId,
          source: p.source,
          company: p.company,
        },
        valueTag,
        valueTaggedAt,
        goalId,
        createdAt: sqlAt(anchor, p.daysAgo, 8, jitter(i * 4 + k)),
      });
    });

    // One send receipt + one sequence_event per step actually delivered.
    for (let step = 0; step < p.steps; step++) {
      const stepDaysAgo = p.daysAgo - (STEP_OFFSETS[step] ?? 0);
      const bounced = p.status === "bounced" && step === p.steps - 1;
      receiptId += 1;
      const sendReceiptId = receiptId;
      receipts.push({
        id: sendReceiptId,
        playName: p.play,
        callType: "email.send",
        costUsd: COST["email.send"] ?? 0.004,
        signedReceipt: signedReceiptFor("email.send", p, sendReceiptId),
        oneshotRequestId: `req_demo_${String(sendReceiptId).padStart(5, "0")}`,
        senderIdentity: p.identity,
        memo:
          step === 0
            ? `${p.play} intro to ${p.name} — ${p.hook.slice(0, 60)}`
            : `${p.play} follow-up ${step} to ${p.name}`,
        decisionContext: {
          playName: p.play,
          callType: "email.send",
          goalId,
          stepIndex: step,
          senderIdentity: p.identity,
        },
        valueTag,
        valueTaggedAt,
        goalId,
        createdAt: sqlAt(anchor, stepDaysAgo, 9, jitter(i * 3 + step)),
      });

      sequenceEvents.push({
        prospectId,
        playName: p.play,
        stepIndex: step,
        channel: "email",
        status: bounced
          ? "bounced"
          : p.status === "replied" && step === p.steps - 1
            ? "replied"
            : "sent",
        metadataJson: JSON.stringify({
          subject: subjectFor(p, step),
          body: bodyFor(p, step),
          evidence: p.hook,
          senderIdentity: p.identity,
        }),
        receiptId: sendReceiptId,
        createdAt: sqlAt(anchor, stepDaysAgo, 9, jitter(i * 3 + step)),
      });
    }

    cadences.push({
      prospectId,
      playName: p.play,
      currentStep: p.steps - 1,
      status: p.status,
      enrolledAt: sqlAt(anchor, p.daysAgo, 9, jitter(i)),
      // Only a live cadence has a next step pending; everything else is settled.
      // Due dates fan out from two days overdue to four days out rather than
      // deriving from the last send, which would put nearly every active row in
      // the overdue column and make the founder look like they'd abandoned the
      // thing. A couple of overdue rows is the honest picture: that's the
      // founder's to-do list, and the demo scheduler won't clear it.
      nextDueAt: p.status === "active" ? isoAt(anchor, 2 - (i % 7), 9, jitter(i)) : null,
      nextStepDraftJson:
        p.status === "active" && p.steps > 1
          ? JSON.stringify({
              subject: subjectFor(p, p.steps),
              body: bodyFor(p, p.steps),
              flags: [],
              payload: { name: p.name, company: p.company, hook: p.hook },
              draftedAt: isoAt(anchor, 1, 7, jitter(i)),
            })
          : null,
      nextStepDraftedAt:
        p.status === "active" && p.steps > 1 ? isoAt(anchor, 1, 7, jitter(i)) : null,
    });

    if (p.outcome) {
      outcomes.push({
        prospectId,
        playName: p.play,
        outcome: p.outcome.kind,
        amountUsd: p.outcome.amountUsd ?? null,
        notes: p.outcome.notes,
        recordedAt: sqlAt(anchor, p.outcome.daysAgo, 17, jitter(i)),
      });
    }
  });

  return {
    config: buildConfig(),
    secrets: DEMO_SECRETS,
    prospects,
    receipts,
    sequenceEvents,
    cadences,
    outcomes,
    queue: buildQueue(anchor),
    triggers: buildTriggers(anchor),
    runs: buildRuns(anchor, receipts),
    bounces: buildBounces(anchor, prospects),
    canaries: buildCanaries(anchor),
    senderAssignments,
    inboxDrafts: buildInboxDrafts(anchor),
    inboxSent: buildInboxSent(anchor),
    interviews: buildInterviews(anchor),
    fixtures: {
      "inbox.json": buildInboxFixture(anchor),
      "rocs-by-goal.json": buildRocsFixture(receipts, anchor),
      "domains.json": buildDomainsFixture(anchor),
      "balance.json": { balance: "41.86 USDC", raw: "41.86 USDC" },
    },
  };
}

// ---------------------------------------------------------------------------
// Config + secrets
// ---------------------------------------------------------------------------

// Deliberately non-functional. They exist so `doctor`'s pure-env checks
// (llmApiKey, oneshotEnvReady) read green without a network call, and so an
// accidental Run click fails at auth instead of spending real money.
const DEMO_SECRETS: Record<string, string> = {
  OPENROUTER_API_KEY: "sk-or-v1-demo-not-a-real-key-do-not-use",
  AGENT_PRIVATE_KEY: "0xdemo0000000000000000000000000000000000000000000000000000000000",
};

function buildConfig(): Record<string, unknown> {
  return {
    walletMode: "private-key",
    llmProvider: "openrouter",
    llmModel: "anthropic/claude-sonnet-4.6",
    telemetryEnabled: false,
    founderName: DEMO_FOUNDER.name,
    founderEmail: DEMO_FOUNDER.email,
    productOneLiner: DEMO_FOUNDER.oneLiner,
    productDomain: DEMO_FOUNDER.productDomain,
    sendingDomain: DEMO_FOUNDER.sendingDomain,
    emailProvider: "oneshot",
    emailIdentities: IDENTITIES,
    icpOneLiner: DEMO_FOUNDER.icp,
    cadenceOverrides: { "show-hn": [3, 7] },
    founderCredentials: "Ran platform reliability at a 400-engineer infra company before this.",
    productPortfolio: "Tracepoint — used by 60+ teams to trace background jobs end to end.",
    partners: "Built on OpenTelemetry; ships adapters for Sidekiq, Celery, BullMQ and Temporal.",
    mobileSignature: false,
    clientId: "demo-00000000-0000-4000-8000-000000000000",
  };
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

function subjectFor(p: DemoPerson, step: number): string {
  if (step === 0) return `${p.company} + background job traces`;
  if (step === 1) return `Re: ${p.company} + background job traces`;
  return `Closing the loop, ${p.name.split(" ")[0] ?? p.name}`;
}

function bodyFor(p: DemoPerson, step: number): string {
  const first = p.name.split(" ")[0] ?? p.name;
  if (step === 0) {
    return [
      `Hey ${first},`,
      "",
      `${p.hook}`,
      "",
      "I built Tracepoint because I kept hitting the same wall: the job failed, the logs are fine, and there is no trace to follow. It drops into a worker with one import and no sidecar.",
      "",
      "Worth fifteen minutes?",
      "",
      "Mira",
    ].join("\n");
  }
  if (step === 1) {
    return [
      `Hey ${first},`,
      "",
      `One concrete thing since last week: retries now inherit the parent span, so a job that succeeds on attempt four still shows you what attempts one through three did.`,
      "",
      `That is the part ${p.company} would feel first.`,
      "",
      "Mira",
    ].join("\n");
  }
  return [
    `Hey ${first},`,
    "",
    "I will stop here so I am not clogging your inbox. If background job visibility becomes a problem worth solving this quarter, reply to this and I will pick it back up.",
    "",
    "Mira",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Signed receipts
// ---------------------------------------------------------------------------

function signedReceiptFor(callType: string, p: DemoPerson, id: number): unknown {
  const base = {
    receipt_id: `rcpt_demo_${String(id).padStart(5, "0")}`,
    request_id: `req_demo_${String(id).padStart(5, "0")}`,
    status: "completed",
    settlement: {
      network: "base",
      asset: "USDC",
      amount: String(COST[callType] ?? 0.01),
      tx_hash: `0xdemo${String(id).padStart(6, "0")}`,
    },
  };
  if (callType === "email.send") {
    return {
      ...base,
      email: {
        id: `msg_demo_${String(id).padStart(5, "0")}`,
        provider_message_id: `<demo-${id}@tracepoint.email>`,
        status: "sent",
      },
      to: p.email,
    };
  }
  return { ...base, subject_ref: p.email };
}

function outcomeValueTag(outcome: NonNullable<DemoPerson["outcome"]>): unknown {
  switch (outcome.kind) {
    case "meeting_booked":
      return { type: "meeting", label: "meeting booked" };
    case "sql_qualified":
      return { type: "qualified", label: "SQL qualified" };
    case "deal_won":
      return { type: "revenue", amount: outcome.amountUsd, label: "deal won" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

function buildQueue(anchor: Date): DemoDataset["queue"] {
  // Rows the finders surfaced but that haven't shipped yet — the founder's
  // actual inbox of work. A mix of statuses so every filter chip has something
  // behind it, and drafts on the approved rows so the preview expands.
  const pending = [
    {
      play: "show-hn",
      source: "show-hn",
      payload: {
        postTitle: "Show HN: Halyard — deterministic replay for distributed workers",
        postUrl: "https://news.ycombinator.com/item?id=41200011",
        founderName: "Tom Whitfield",
        founderEmail: "tom@halyard.dev",
        hookSummary:
          "Thread argues replay is only useful if you captured the span in the first place; Tom concedes the point.",
      },
      daysAgo: 0,
    },
    {
      play: "show-hn",
      source: "show-hn",
      payload: {
        postTitle: "Show HN: Cutter — a job queue that refuses to lose work",
        postUrl: "https://news.ycombinator.com/item?id=41200042",
        founderName: "Ida Sorensen",
        founderEmail: "ida@cutter.works",
        hookSummary:
          "Front page in 40 minutes; the top comment asks how you debug a stuck consumer.",
      },
      daysAgo: 0,
    },
    {
      play: "post-funding",
      source: "post-funding-auto",
      payload: {
        name: "Gabriel Okafor",
        email: "gabriel@ridgeline.systems",
        company: "Ridgeline",
        round: "Seed",
        amount: "$4.2M",
        announcementUrl: "https://example.com/ridgeline-seed",
      },
      daysAgo: 1,
    },
    {
      play: "hiring-signal",
      source: "hiring-signal",
      payload: {
        name: "Clara Bianchi",
        email: "clara@spindrift.dev",
        company: "Spindrift",
        role: "Founding Reliability Engineer",
        jobUrl: "https://jobs.ashbyhq.com/spindrift/example",
        yourClaim: "Tracepoint gives a new reliability hire a map of the async system in week one.",
      },
      daysAgo: 2,
    },
    {
      play: "podcast-guest",
      source: "podcast-guest",
      payload: {
        name: "Victor Aalto",
        email: "victor@lodestar.build",
        company: "Lodestar",
        podcast: "Latent Space",
        episodeTitle: "Shipping agents that recover",
        hookQuote:
          "At 22:10 you said the hard part is not the failure, it is reconstructing what the agent did before it failed.",
        bridge: "That reconstruction is literally the product.",
      },
      daysAgo: 2,
    },
  ];

  const approved = [
    {
      play: "job-change",
      source: "job-change",
      payload: {
        name: "Noor Farouk",
        email: "noor@brightkiln.io",
        newRole: "VP Engineering",
        newCompany: "Brightkiln",
        previousRole: "Director of Platform",
        previousCompany: "Datadog",
        linkedinUrl: "https://linkedin.com/in/noor-farouk-fake",
      },
      daysAgo: 1,
      draft: {
        subject: "Brightkiln + background job traces",
        body: "Hey Noor,\n\nYou came from a place where tracing was a given. Brightkiln's queue workers almost certainly are not instrumented yet, and the first eight weeks is when you get to decide that.\n\nTracepoint drops into a worker with one import, no sidecar, no sampling.\n\nWorth fifteen minutes?\n\nMira",
      },
    },
    {
      play: "competitor-switch",
      source: "competitor-switch",
      payload: {
        name: "Grace Odum",
        email: "grace@fathomline.ai",
        company: "Fathomline",
        competitor: "per-host APM",
        evidenceUrl: "https://example.com/fathomline-postmortem",
        yourEdge: "Per-job pricing, so nobody turns off tracing on the worker fleet to save money.",
      },
      daysAgo: 3,
      draft: {
        subject: "The line in your postmortem about turning off tracing",
        body: "Hey Grace,\n\nYour postmortem says you disabled tracing on the worker fleet because per-host pricing made it untenable, and then the next incident took six hours to reconstruct. Those two sentences are the whole pitch.\n\nTracepoint prices per job, not per host.\n\nWorth a look?\n\nMira",
      },
    },
  ];

  const rows: DemoDataset["queue"] = [];

  pending.forEach((r, i) => {
    rows.push({
      playName: r.play,
      payloadJson: JSON.stringify(r.payload),
      dedupeKey: `demo-pending-${i}`,
      source: r.source,
      status: "pending",
      foundAt: sqlAt(anchor, r.daysAgo, 6, jitter(i)),
      reviewedAt: null,
      sentAt: null,
      notes: null,
      prospectId: null,
      lastDraftJson: null,
      lastDraftedAt: null,
    });
  });

  approved.forEach((r, i) => {
    rows.push({
      playName: r.play,
      payloadJson: JSON.stringify(r.payload),
      dedupeKey: `demo-approved-${i}`,
      source: r.source,
      status: "approved",
      foundAt: sqlAt(anchor, r.daysAgo, 6, jitter(i)),
      reviewedAt: isoAt(anchor, r.daysAgo, 18, jitter(i)),
      sentAt: null,
      notes: null,
      prospectId: null,
      lastDraftJson: JSON.stringify({
        subject: r.draft.subject,
        body: r.draft.body,
        flags: [],
        sent: false,
        receiptIds: [],
        dryRun: false,
        draftedAt: isoAt(anchor, r.daysAgo, 18, jitter(i)),
      }),
      lastDraftedAt: isoAt(anchor, r.daysAgo, 18, jitter(i)),
    });
  });

  // A rejected row, so the reject filter isn't a dead chip and the ICP filter
  // visibly has teeth.
  rows.push({
    playName: "show-hn",
    payloadJson: JSON.stringify({
      postTitle: "Show HN: a Chrome extension that summarises your tabs",
      postUrl: "https://news.ycombinator.com/item?id=41200099",
      founderName: "Rick Alvarez",
      founderEmail: "rick@tabsummary.app",
      hookSummary: "Consumer browser extension, no backend workers, no queue.",
    }),
    dedupeKey: "demo-rejected-0",
    source: "show-hn",
    status: "rejected",
    foundAt: sqlAt(anchor, 2, 6, 11),
    reviewedAt: isoAt(anchor, 2, 7, 3),
    sentAt: null,
    notes: "Out of ICP — consumer extension, no background job surface.",
    prospectId: null,
    lastDraftJson: null,
    lastDraftedAt: null,
  });

  // Two already shipped, matching prospects that exist above.
  const sentRows: Array<{
    play: string;
    source: string;
    email: string;
    name: string;
    prospectId: number;
    daysAgo: number;
  }> = [
    {
      play: "show-hn",
      source: "show-hn",
      email: "elin@northport.works",
      name: "Elin Dahl",
      prospectId: 19,
      daysAgo: 1,
    },
    {
      play: "post-funding",
      source: "post-funding-auto",
      email: "ravi@stanchion.dev",
      name: "Ravi Menon",
      prospectId: 18,
      daysAgo: 2,
    },
  ];
  sentRows.forEach((r, i) => {
    rows.push({
      playName: r.play,
      payloadJson: JSON.stringify({ name: r.name, email: r.email }),
      dedupeKey: `demo-sent-${i}`,
      source: r.source,
      status: "sent",
      foundAt: sqlAt(anchor, r.daysAgo, 6, jitter(i)),
      reviewedAt: isoAt(anchor, r.daysAgo, 8, jitter(i)),
      sentAt: isoAt(anchor, r.daysAgo, 9, jitter(i)),
      notes: null,
      prospectId: r.prospectId,
      lastDraftJson: null,
      lastDraftedAt: null,
    });
  });

  return rows;
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

function buildTriggers(anchor: Date): DemoDataset["triggers"] {
  // Config values mirror each finder's defaultConfig shape in
  // packages/find/src/registry.ts, tuned to this founder's ICP.
  //
  // Enabled triggers are polled MINUTES before the anchor, not at a fixed hour.
  // The dashboard derives "next due" as last_polled_at + interval and flags
  // anything past due as overdue — and the demo scheduler is idle, so nothing
  // will ever clear that flag. Recent polls (against 6h–24h intervals) keep the
  // strip reading "due in 5h" instead of a wall of red. This is why `--now`
  // defaults to seed time: film soon after seeding.
  return [
    {
      name: "show-hn",
      lastPolledAt: isoMinutesAgo(anchor, 18),
      lastRunSummary: JSON.stringify({ scanned: 31, enqueued: 3, rejected: 12, costUsd: 0.41 }),
      enabled: 1,
      configJson: JSON.stringify({ sinceDays: 1, limit: 25, maxCostUsd: 5 }),
    },
    {
      name: "post-funding-auto",
      lastPolledAt: isoMinutesAgo(anchor, 46),
      lastRunSummary: JSON.stringify({ scanned: 18, enqueued: 1, rejected: 9, costUsd: 0.27 }),
      enabled: 1,
      configJson: JSON.stringify({
        autoRounds: ["Seed", "Series A"],
        autoIndustry: "developer tools and AI infrastructure",
        autoSinceDays: 7,
        limit: 25,
        maxCostUsd: 5,
      }),
    },
    {
      name: "hiring-signal",
      lastPolledAt: isoMinutesAgo(anchor, 190),
      lastRunSummary: JSON.stringify({ scanned: 44, enqueued: 1, rejected: 21, costUsd: 0.33 }),
      enabled: 1,
      configJson: JSON.stringify({
        roles: ["Founding Reliability Engineer", "Staff SRE", "Platform Engineer"],
        yourClaim:
          "Tracepoint gives a new reliability hire a map of the async system in week one instead of month three.",
        sinceDays: 14,
        limit: 25,
        maxCostUsd: 5,
      }),
    },
    {
      name: "podcast-guest",
      lastPolledAt: isoMinutesAgo(anchor, 320),
      lastRunSummary: JSON.stringify({ scanned: 12, enqueued: 1, rejected: 6, costUsd: 0.19 }),
      enabled: 1,
      configJson: JSON.stringify({
        podcasts: ["Latent Space", "Lenny's Podcast", "20VC"],
        sinceDays: 21,
        skipRead: false,
        limit: 25,
        maxCostUsd: 5,
      }),
    },
    {
      name: "github-stars",
      lastPolledAt: isoMinutesAgo(anchor, 125),
      lastRunSummary: JSON.stringify({ scanned: 96, enqueued: 0, rejected: 38, costUsd: 0.12 }),
      enabled: 1,
      configJson: JSON.stringify({
        repos: [
          { repo: "open-telemetry/opentelemetry-js", rel: "adjacent", label: "OTel JS" },
          {
            repo: "example/job-queue-instrumentation",
            rel: "adjacent",
            label: "queue instrumentation",
          },
        ],
        yourEdge:
          "Span context that survives retries, which OTel worker instrumentation still drops.",
        sinceDays: 30,
        limit: 25,
        maxCostUsd: 5,
      }),
    },
    {
      name: "job-change",
      lastPolledAt: isoAt(anchor, 3, 6, 30),
      lastRunSummary: JSON.stringify({ scanned: 27, enqueued: 1, rejected: 14, costUsd: 0.22 }),
      enabled: 0,
      configJson: JSON.stringify({
        personas: ["VP Engineering", "Head of Platform", "Director of Engineering"],
        sinceDays: 14,
        limit: 25,
        maxCostUsd: 5,
      }),
    },
    {
      name: "luma-events",
      lastPolledAt: isoAt(anchor, 4, 6, 15),
      lastRunSummary: JSON.stringify({ scanned: 9, enqueued: 2, rejected: 4, costUsd: 0.16 }),
      enabled: 0,
      configJson: JSON.stringify({
        topics: ["AI infrastructure", "platform engineering"],
        cities: ["San Francisco", "Berlin"],
        sinceDays: 14,
        yourEdge: "Tracing that works on background jobs, not just web requests.",
        limit: 25,
        maxCostUsd: 5,
      }),
    },
    // Deliberately left unconfigured, so the dashboard shows a real
    // "not ready" trigger with its toggle disabled and the reason attached.
    {
      name: "github-topics",
      lastPolledAt: null,
      lastRunSummary: null,
      enabled: 0,
      configJson: JSON.stringify({
        topics: [],
        vendors: [],
        directCompetitors: [],
        yourEdge: "",
        minStars: 5,
        maxAgeDays: 90,
        minVendors: 1,
        concurrency: 3,
      }),
    },
    {
      name: "breakup-revive",
      lastPolledAt: isoAt(anchor, 6, 6, 0),
      lastRunSummary: JSON.stringify({ scanned: 24, enqueued: 0, rejected: 0, costUsd: 0 }),
      enabled: 0,
      configJson: JSON.stringify({ minDays: 60, maxDays: 90, limit: 25 }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function buildRuns(anchor: Date, receipts: DemoReceipt[]): DemoDataset["runs"] {
  // Receipt ids are assigned globally while iterating PEOPLE, so a run's send
  // events must look up the actual email.send receipt per recipient — a
  // hardcoded [1]/[2] would link this run's sends to whoever's prep calls
  // happened to be recorded first. Matching is by (play, recipient), not
  // recipient alone: a prospect who was ALSO emailed by another play would
  // otherwise satisfy the lookup with the wrong play's receipt and timestamp,
  // and a run must only ever claim sends that belong to it.
  const sendReceiptIdFor = (playName: string, email: string): number => {
    const r = receipts.find(
      (x) =>
        x.callType === "email.send" &&
        x.playName === playName &&
        (x.signedReceipt as { to?: string }).to === email,
    );
    if (!r) throw new Error(`demo dataset: no ${playName} email.send receipt for ${email}`);
    return r.id;
  };

  // Single target on purpose: Elin is the only show-hn send from the day this
  // run ran. Padding the run with a prospect from another play (as an earlier
  // draft did with Ravi) makes the run claim a send with the wrong play and
  // timestamp — the play-aware lookup above now throws on that.
  const targets = [{ name: "Elin Dahl", email: "elin@northport.works", company: "Northport" }];
  const events = [
    { kind: "runStarted", runId: 1, startedAt: isoAt(anchor, 1, 9, 0) },
    { kind: "verify", total: 1, verified: 1, dropped: [] },
    { kind: "stage", stage: "drafting" },
    {
      kind: "draft",
      index: 0,
      subject: "Northport + background job traces",
      body: "Hey Elin,\n\nThe top comment on your Show HN asks how you debug a stuck run, and your answer was basically 'carefully'. That is the gap Tracepoint fills.\n\nWorth fifteen minutes?\n\nMira",
      flags: [],
    },
    { kind: "send", index: 0, receiptIds: [sendReceiptIdFor("show-hn", "elin@northport.works")] },
    { kind: "done", total: 1, sent: 1 },
  ];

  return [
    {
      playName: "show-hn",
      dryRun: 0,
      status: "done",
      startedAt: isoAt(anchor, 1, 9, 0),
      completedAt: isoAt(anchor, 1, 9, 4),
      targetCount: 1,
      draftedCount: 1,
      sentCount: 1,
      errorCount: 0,
      targetsJson: JSON.stringify(targets),
      eventsJson: JSON.stringify(events),
      prospectEmailsJson: JSON.stringify(targets.map((t) => t.email)),
    },
  ];
}

// ---------------------------------------------------------------------------
// Deliverability
// ---------------------------------------------------------------------------

function buildBounces(anchor: Date, prospects: DemoProspectRow[]): DemoDataset["bounces"] {
  const byEmail = (email: string): number => prospects.find((p) => p.email === email)?.id ?? 0;
  return [
    {
      messageId: "<demo-bounce-1@tracepoint.email>",
      recipient: "ana@driftline.ai",
      identityId: IDENTITY_SECOND,
      kind: "hard",
      statusCode: "5.1.1",
      diagnostic: "550 5.1.1 The email account that you tried to reach does not exist.",
      prospectId: byEmail("ana@driftline.ai"),
      bouncedAt: isoAt(anchor, 15, 9, 12),
      createdAt: sqlAt(anchor, 15, 9, 20),
    },
    {
      messageId: "<demo-bounce-2@tracepoint.email>",
      recipient: "piotr@grainline.dev",
      identityId: IDENTITY_SECOND,
      kind: "soft",
      statusCode: "4.2.2",
      diagnostic: "452 4.2.2 The recipient's mailbox is over its storage limit.",
      prospectId: byEmail("piotr@grainline.dev"),
      bouncedAt: isoAt(anchor, 13, 9, 30),
      createdAt: sqlAt(anchor, 13, 9, 38),
    },
  ];
}

function buildCanaries(anchor: Date): DemoDataset["canaries"] {
  return [
    {
      fromIdentity: IDENTITY_PRIMARY,
      toIdentity: IDENTITY_WARMING,
      placement: "inbox",
      labelsJson: JSON.stringify(["INBOX", "CATEGORY_PERSONAL"]),
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
      subject: "placement canary — tracepoint.email → trace-mail.dev",
      sourcePlay: "show-hn",
      // Cross-domain, which is the only configuration that yields a verdict
      // worth reporting — a same-domain canary tells you nothing about how a
      // stranger's mail server files your mail.
      sameDomain: 0,
      latencyMs: 3120,
      createdAt: sqlAt(anchor, 4, 11, 5),
    },
  ];
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

/** Everyone in the cast who replied, in the order the fixture should list them. */
function repliers(): DemoPerson[] {
  return PEOPLE.filter((p) => p.reply != null).toSorted(
    (a, b) => (a.reply?.daysAgo ?? 0) - (b.reply?.daysAgo ?? 0),
  );
}

/**
 * Thread/email ids are positional in the repliers() ordering, so any row that
 * references one (inbox_drafts, inbox_sent) must derive it from the SAME
 * ordering by email — a hardcoded "thread_demo_0001" silently attaches to
 * whichever reply happens to sort first, putting one prospect's history inside
 * another prospect's thread.
 */
function replierIndex(email: string): number {
  const i = repliers().findIndex((p) => p.email === email);
  if (i < 0) throw new Error(`demo dataset: ${email} has no reply — cannot build a thread id`);
  return i;
}

function threadIdFor(email: string): string {
  return `thread_demo_${String(replierIndex(email) + 1).padStart(4, "0")}`;
}

function inboundEmailIdFor(email: string): string {
  return `email_demo_${String(replierIndex(email) + 1).padStart(4, "0")}`;
}

function buildInboxFixture(anchor: Date): unknown {
  const emails = repliers().map((p, i) => {
    const r = p.reply as NonNullable<DemoPerson["reply"]>;
    return {
      id: inboundEmailIdFor(p.email),
      from: `${p.name} <${p.email}>`,
      subject: r.subject,
      received_at: isoAt(anchor, r.daysAgo, r.hour, jitter(i)),
      thread_id: threadIdFor(p.email),
      body: r.body,
      source_identity_id: p.identity,
      message_id: `<reply-${i + 1}@${p.email.split("@")[1] ?? "example.dev"}>`,
    };
  });

  // One unmatched message so the match filter on /inbox has both sides. It maps
  // to no prospect, which is what the "no-match" chip is for.
  emails.push({
    id: "email_demo_0099",
    from: "The Pragmatic Engineer <newsletter@example-news.dev>",
    subject: "Issue 214: what on-call actually costs",
    received_at: isoAt(anchor, 2, 7, 15),
    thread_id: "thread_demo_0099",
    body: "This week: the hidden cost of on-call rotations, and why incident review meetings keep getting cancelled.",
    source_identity_id: IDENTITY_PRIMARY,
    message_id: "<issue-214@example-news.dev>",
  });

  emails.sort((a, b) => (a.received_at < b.received_at ? 1 : -1));
  return { emails, count: emails.length, has_more: false, agent_id: "agent_demo" };
}

function buildInboxDrafts(anchor: Date): DemoDataset["inboxDrafts"] {
  // One reply half-written, so the composer opens with content rather than a
  // blank box.
  return [
    {
      threadKey: threadIdFor("dmitri@cascade.systems"),
      inboundEmailId: inboundEmailIdFor("dmitri@cascade.systems"),
      toEmail: "dmitri@cascade.systems",
      subject: "Re: reliability as the year's focus",
      identityId: IDENTITY_PRIMARY,
      body: "Hey Dmitri,\n\nNext week works. Send me two slots and I will make either one. Happy to have your SRE dig in — the retry span linking is the part that usually gets the hard questions, so I will lead with it.\n\nMira",
      updatedAt: sqlAt(anchor, 9, 10, 12),
    },
  ];
}

function buildInboxSent(anchor: Date): DemoDataset["inboxSent"] {
  return [
    {
      threadKey: threadIdFor("aisha@tidewater.build"),
      toEmail: "aisha@tidewater.build",
      subject: "Re: 'find out on Monday what broke on Saturday'",
      body: "Hey Aisha,\n\nPricing is per job, not per host — attached. For a Saturday batch run of your size it lands around $600/mo, and you can point it at that one pipeline before touching anything else.\n\nMira",
      identityId: IDENTITY_PRIMARY,
      requestId: "req_demo_reply_0001",
      sentAt: sqlAt(anchor, 17, 12, 30),
    },
  ];
}

// ---------------------------------------------------------------------------
// Interviews
// ---------------------------------------------------------------------------

function buildInterviews(anchor: Date): DemoDataset["interviews"] {
  return [
    {
      person: "Priya Shah (Northstar AI)",
      transcriptPath: null,
      jtbd: "When a nightly job fails, reconstruct what it did without re-running it.",
      painQuotesJson: JSON.stringify([
        "The traces we lose are the ones from the runs that failed.",
        "We turned sampling up after the incident and turned it back down when the bill came.",
      ]),
      createdAt: sqlAt(anchor, 19, 15, 0),
    },
    {
      person: "Kwame Mensah (Triacore)",
      transcriptPath: null,
      jtbd: "See which retry attempt actually did the damage.",
      painQuotesJson: JSON.stringify([
        "Attempt four succeeded, so as far as the dashboard is concerned nothing happened.",
      ]),
      createdAt: sqlAt(anchor, 12, 16, 30),
    },
  ];
}

// ---------------------------------------------------------------------------
// Platform RoCS rollup
// ---------------------------------------------------------------------------

/**
 * Keyed by period ("7" / "30" / "all") because the Measure page's range chips
 * pass `periodDays` through to `cadenceRocs` — a single all-time rollup would
 * show identical numbers on every chip, which reads as a broken filter on
 * camera. The demo seam in `cadenceRocs` picks the matching key.
 */
function buildRocsFixture(receipts: DemoReceipt[], anchor: Date): unknown {
  return {
    "7": rocsForWindow(receipts.filter((r) => r.createdAt >= sqlAt(anchor, 7, 0, 0))),
    "30": rocsForWindow(receipts.filter((r) => r.createdAt >= sqlAt(anchor, 30, 0, 0))),
    all: rocsForWindow(receipts),
  };
}

function rocsForWindow(receipts: DemoReceipt[]): unknown {
  // Derived from the receipts we just wrote, so the platform rollup and the
  // local ledger agree — the goalIds match, and so does the spend.
  const byGoal = new Map<
    string,
    { spend: number; count: number; value: number; tagged: boolean }
  >();
  for (const r of receipts) {
    const entry = byGoal.get(r.goalId) ?? { spend: 0, count: 0, value: 0, tagged: false };
    entry.spend += r.costUsd;
    entry.count += 1;
    const tag = r.valueTag as { type?: string; amount?: number } | null;
    if (tag) {
      entry.tagged = true;
      // Only closed revenue carries a dollar value. A booked meeting is real
      // progress but it is not money, and inventing a number for it would
      // inflate every RoCS figure on the Measure page — exactly the estimated,
      // dashboard-shaped accounting this tool exists to avoid. One value per
      // goal, not per receipt: the platform records the outcome once and fans
      // it across the goal's receipts.
      if (tag.type === "revenue" && typeof tag.amount === "number") entry.value = tag.amount;
    }
    byGoal.set(r.goalId, entry);
  }

  // Every goal with an outcome, valued or not. The zero-value rows are the
  // honest half of the picture: spend that has produced a meeting and nothing
  // banked yet.
  return Array.from(byGoal.entries())
    .filter(([, v]) => v.tagged)
    .map(([goalId, v]) => ({
      goalId,
      spend: Number(v.spend.toFixed(4)),
      value: v.value,
      pendingValue: 0,
      rocs: v.value > 0 ? Number((v.value / v.spend).toFixed(1)) : 0,
      receiptCount: v.count,
    }));
}

// ---------------------------------------------------------------------------
// Domain pool
// ---------------------------------------------------------------------------

function buildDomainsFixture(anchor: Date): unknown {
  return [
    {
      domain: "tracepoint.email",
      pool_status: "active",
      provisioning_status: "provisioned",
      warmup_score: 87,
      warmup_started_at: isoAt(anchor, 54, 12, 0),
      daily_send_limit: 50,
      daily_sent_count: 6,
      daily_sent_date: isoAt(anchor, 0, 0, 0).slice(0, 10),
      last_used_at: isoAt(anchor, 0, 9, 12),
    },
    {
      domain: "trace-mail.dev",
      pool_status: "warming",
      provisioning_status: "provisioned",
      warmup_score: 34,
      warmup_started_at: isoAt(anchor, 11, 12, 0),
      daily_send_limit: 20,
      daily_sent_count: 2,
      daily_sent_date: isoAt(anchor, 0, 0, 0).slice(0, 10),
      last_used_at: isoAt(anchor, 6, 9, 30),
    },
  ];
}
