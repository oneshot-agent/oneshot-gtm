export interface Concept {
  title: string;
  body: string;
  href?: string | null;
}

const docs = "https://docs.oneshotagent.com/oneshot-gtm/";

export const CONCEPTS = {
  rocs: {
    title: "Return on cognitive spend",
    body: "Confirmed attributed value divided by OneShot action spend. This is a value-per-dollar ratio, not total profit; unrecorded or pending outcomes can understate it.",
    href: docs + "rocs",
  },
  sql: {
    title: "Sales-qualified lead",
    body: "A prospect you have recorded as qualified for a sales conversation. Qualification is an outcome you log, not something a priority score proves.",
    href: docs + "rocs",
  },
  costMeeting: {
    title: "Cost per meeting",
    body: "Recorded action spend divided by recorded meetings in this view. A dash means there is no meeting denominator yet.",
    href: docs + "rocs",
  },
  costWon: {
    title: "Cost per win",
    body: "Recorded action spend divided by recorded wins in this view. It excludes founder time and costs outside the ledger.",
    href: docs + "rocs",
  },
  shadowScore: {
    title: "Shadow score",
    body: "Experimental priority from evidence, not a conversion probability. A shadow badge is informational; ranked review can use priority to order candidates, but never approves or sends them.",
    href: docs + "shadow-score",
  },
  personFit: {
    title: "Person fit",
    body: "How the person's role and observed capabilities fit your ICP. Missing evidence is neutral; seniority alone does not establish fit.",
    href: docs + "shadow-score",
  },
  accountFit: {
    title: "Account fit",
    body: "Evidence that the organization fits your product, such as company context, funding or hiring signals.",
    href: docs + "shadow-score",
  },
  intentStrength: {
    title: "Intent strength",
    body: "How directly the observed activity suggests a relevant need. A star or event appearance is a signal, not a buying commitment.",
    href: docs + "shadow-score",
  },
  timingFreshness: {
    title: "Timing freshness",
    body: "How recent the triggering event is. Older evidence usually carries less urgency.",
    href: docs + "shadow-score",
  },
  signalConfidence: {
    title: "Signal confidence",
    body: "How much concrete, attributable evidence supports this candidate, such as source URLs and quoted context.",
    href: docs + "shadow-score",
  },
  contactability: {
    title: "Contactability",
    body: "Available ways to reach the person, such as email, LinkedIn, phone or open DMs. Availability does not replace deliverability or suppression checks.",
    href: docs + "shadow-score",
  },
  softHold: {
    title: "Soft hold",
    body: "A draft paused for human review, for example because an event passed or another workspace contacted the person. Review the stated reason before overriding; other send checks still apply.",
    href: docs + "sending",
  },
  drain: {
    title: "Drain approved rows",
    body: "Process approved queue rows for one play. A live drain can draft and send; dry run previews. Pending rows need approval first.",
    href: docs + "finders",
  },
  breakup: {
    title: "Breakup follow-up",
    body: "The final touch in an unanswered sequence. It closes the loop and leaves the recipient room to decline or defer.",
    href: docs + "plays",
  },
  warmup: {
    title: "Warm-up ramp",
    body: "Blank cap = warm-up ramp: 10/day, +10 a week, max 50. The ramp gradually increases daily sending capacity.",
    href: docs + "sending",
  },
  pinnedRouting: {
    title: "Pinned sender routing",
    body: "The first-touch sender stays assigned to that prospect so follow-ups keep the same From address. Removing an identity blocks sends to prospects pinned to it until it's restored.",
    href: docs + "sending",
  },
  domainCaps: {
    title: "Domain-shared caps",
    body: "OneShot mailboxes on the same sending domain share a daily ramp and budget. Adding another mailbox does not create another domain allowance.",
    href: docs + "sending",
  },
  dedupe: {
    title: "Dedupe key",
    body: "A stable identifier that connects a discovered candidate to its queue row and draft. Retry and send checks use recorded state to avoid repeating an already-sent first touch.",
    href: docs + "concepts",
  },
  icpGate: {
    title: "ICP gate",
    body: "The topic gate checks the source; the person gate checks the individual's fit. A relevant repo or event does not make everyone associated with it a fit.",
    href: docs + "concepts",
  },
  enrichment: {
    title: "Enrichment retry",
    body: "enrichment failed — drafted from payload context only; retries automatically after ~3 days",
    href: docs + "finders",
  },
} satisfies Record<string, Concept>;

export type ConceptId = keyof typeof CONCEPTS;

export const PRIORITY_CONCEPTS: Readonly<Record<string, ConceptId>> = {
  "person fit": "personFit",
  "account fit": "accountFit",
  intent: "intentStrength",
  freshness: "timingFreshness",
  confidence: "signalConfidence",
  contactability: "contactability",
};

export function getConcept(
  id: string,
  registry: Readonly<Record<string, Concept>> = CONCEPTS,
): Concept | undefined {
  return Object.hasOwn(registry, id) ? registry[id] : undefined;
}
