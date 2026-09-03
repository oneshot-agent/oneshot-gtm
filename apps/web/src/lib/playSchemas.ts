/**
 * Per-play form schemas for the /run page — the fields a founder fills in (or
 * that get hydrated from an approved queue row) before dispatching a play.
 *
 * Lives in lib/ rather than inside the route so it can be unit-tested and so
 * other pages can reason about it without importing a route module (which drags
 * the whole table into the entry bundle).
 *
 * The key set must match RUNNABLE_PLAYS in @oneshot-gtm/shared-types — the
 * server's run gate keys off that list, and playSchemas.test.ts pins the two
 * together so a play can never be runnable-but-formless (or vice versa).
 */
export interface FieldSpec {
  key: string;
  label: string;
  type: "text" | "email" | "number" | "url" | "textarea";
  required?: boolean;
  placeholder?: string;
  hint?: string;
}

export interface PlaySchema {
  fields: FieldSpec[];
  defaultRow: Record<string, string>;
  description: string;
  /** Extra non-target options surfaced as form fields above the rows. */
  extras?: FieldSpec[];
}

/**
 * Required fields left blank on a target row, by label — used to block
 * dispatch before `/api/run` instead of relying on native `required`
 * validation, which never fires here: /run's rows render outside a `<form>`
 * (submit is a plain button onClick, not a form submit event), so the
 * `required` attribute on each `<Input>`/`<Textarea>` is decorative only.
 * `submit()` strips blank fields before POSTing, so an unenforced required
 * field reaches the play as `undefined` — e.g. sources-sought dispatching
 * with a blank `agency` or `yourEdge` produces a malformed institutional
 * outreach email.
 */
export function missingRequiredFields(schema: PlaySchema, row: Record<string, string>): string[] {
  return schema.fields
    .filter((f) => f.required && (row[f.key] ?? "").trim().length === 0)
    .map((f) => f.label);
}

export const PLAY_SCHEMAS: Record<string, PlaySchema> = {
  "show-hn": {
    description:
      "One-touch founder-to-founder reply to a recent Show HN post. References a specific comment thread.",
    fields: [
      { key: "founderName", label: "Founder name", type: "text", required: true },
      { key: "founderEmail", label: "Founder email", type: "email", required: true },
      {
        key: "postTitle",
        label: "Show HN title",
        type: "text",
        required: true,
        placeholder: "Show HN: Acme — open-source durable workflows",
      },
      { key: "postUrl", label: "Show HN URL", type: "url", required: true },
      {
        key: "hookSummary",
        label: "Hook (specific comment thread / detail to reference)",
        type: "textarea",
        required: true,
      },
    ],
    defaultRow: {
      founderName: "",
      founderEmail: "",
      postTitle: "",
      postUrl: "",
      hookSummary: "",
    },
  },
  "job-change": {
    description:
      "Triggered by a prospect starting a new role at a target company. Day-0 only here; cadence engine fires the day-5 follow-up automatically.",
    fields: [
      { key: "name", label: "Prospect name", type: "text", required: true },
      { key: "email", label: "Prospect email", type: "email", required: true },
      { key: "newRole", label: "New role", type: "text", required: true },
      { key: "newCompany", label: "New company", type: "text", required: true },
      { key: "previousRole", label: "Previous role", type: "text" },
      { key: "previousCompany", label: "Previous company", type: "text" },
      { key: "linkedinUrl", label: "LinkedIn URL (optional)", type: "url" },
    ],
    defaultRow: {
      name: "",
      email: "",
      newRole: "",
      newCompany: "",
      previousRole: "",
      previousCompany: "",
      linkedinUrl: "",
    },
  },
  "accelerator-batch": {
    description:
      "Founder-to-founder outreach within or across accelerator batches (YC, On Deck, SPC, Antler, Techstars).",
    fields: [
      { key: "name", label: "Prospect name", type: "text", required: true },
      { key: "email", label: "Prospect email", type: "email", required: true },
      { key: "company", label: "Company", type: "text", required: true },
      {
        key: "cohort",
        label: "Cohort tag",
        type: "text",
        required: true,
        placeholder: "e.g. yc-w26 · tx-s26 · antler-ldn-12",
      },
      { key: "launchUrl", label: "Launch URL (optional)", type: "url" },
      { key: "productOneLiner", label: "Their product one-liner", type: "text" },
      { key: "linkedinUrl", label: "LinkedIn URL (optional)", type: "url" },
    ],
    defaultRow: {
      name: "",
      email: "",
      company: "",
      cohort: "",
      launchUrl: "",
      productOneLiner: "",
      linkedinUrl: "",
    },
    extras: [
      {
        key: "senderCohort",
        label: "Your cohort tag (sender)",
        type: "text",
        required: true,
        placeholder: "e.g. yc-w23 · od-2 · (leave blank)",
      },
      {
        key: "freeForCohortOffer",
        label: "Free-for-cohort offer (optional)",
        type: "text",
        placeholder: "e.g. Free for your batch through demo day — reply with your cohort.",
      },
    ],
  },
  "post-funding": {
    description:
      "Triggered by a recent funding announcement. Day-0 here; cadence engine fires the day-9 follow-up and day-18 breakup automatically.",
    fields: [
      { key: "name", label: "Founder name", type: "text", required: true },
      { key: "email", label: "Founder email", type: "email", required: true },
      { key: "company", label: "Company", type: "text", required: true },
      {
        key: "round",
        label: "Round",
        type: "text",
        required: true,
        placeholder: "Seed / Series A / Series B",
      },
      {
        key: "amountUsd",
        label: "Amount (USD)",
        type: "number",
        required: true,
        placeholder: "5000000",
      },
      { key: "leadInvestor", label: "Lead investor (optional)", type: "text" },
      { key: "sourceUrl", label: "Announcement URL", type: "url", required: true },
      { key: "linkedinUrl", label: "LinkedIn URL (optional)", type: "url" },
    ],
    defaultRow: {
      name: "",
      email: "",
      company: "",
      round: "",
      amountUsd: "",
      leadInvestor: "",
      sourceUrl: "",
      linkedinUrl: "",
    },
  },
  "hiring-signal": {
    description:
      "Triggered by a job post at a target company. One-touch email to the hiring manager with your ramp-time claim.",
    fields: [
      { key: "name", label: "Hiring manager name", type: "text", required: true },
      { key: "email", label: "Hiring manager email", type: "email", required: true },
      { key: "company", label: "Company", type: "text", required: true },
      { key: "jobTitle", label: "Job title they're hiring for", type: "text", required: true },
      { key: "jobPostUrl", label: "Job post URL (optional)", type: "url" },
      {
        key: "yourClaim",
        label: "Your ramp-time claim",
        type: "textarea",
        required: true,
        placeholder:
          "We cut new-hire ramp time by ~30% on the team they're hiring for — happy to share how.",
      },
    ],
    defaultRow: {
      name: "",
      email: "",
      company: "",
      jobTitle: "",
      jobPostUrl: "",
      yourClaim: "",
    },
  },
  "podcast-guest": {
    description:
      "One-touch reply to a recent podcast guest referencing a specific moment from the episode.",
    fields: [
      { key: "name", label: "Guest name", type: "text", required: true },
      { key: "email", label: "Guest email", type: "email", required: true },
      { key: "company", label: "Guest company", type: "text", required: true },
      {
        key: "podcast",
        label: "Podcast",
        type: "text",
        required: true,
        placeholder: "Latent Space",
      },
      { key: "episodeTitle", label: "Episode title", type: "text", required: true },
      {
        key: "hookQuote",
        label: "Specific quote or moment",
        type: "textarea",
        required: true,
      },
      {
        key: "bridge",
        label: "Why the moment matters to your work (one sentence)",
        type: "text",
      },
    ],
    defaultRow: {
      name: "",
      email: "",
      company: "",
      podcast: "",
      episodeTitle: "",
      hookQuote: "",
      bridge: "",
    },
  },
  "competitor-switch": {
    description:
      "Migration-honesty pitch to a prospect using a vendor you replace. Cites a specific evidence URL or claim, includes one yourEdge fact.",
    fields: [
      { key: "name", label: "Prospect name", type: "text", required: true },
      { key: "email", label: "Prospect email", type: "email", required: true },
      { key: "company", label: "Company", type: "text", required: true },
      {
        key: "competitor",
        label: "Competitor (incumbent)",
        type: "text",
        required: true,
        placeholder: "e.g. Salesforce · QuickBooks · Mailchimp",
      },
      {
        key: "yourEdge",
        label: "Your edge (one sentence)",
        type: "textarea",
        required: true,
        hint: "One specific advantage, not a feature list. e.g. 'setup takes an afternoon, not a quarter'.",
      },
      {
        key: "evidenceUrl",
        label: "Evidence URL (optional)",
        type: "url",
        placeholder: "https://...",
      },
      {
        key: "evidenceText",
        label: "Evidence text (optional — paste a quote/snippet)",
        type: "textarea",
      },
      { key: "linkedinUrl", label: "LinkedIn URL (optional)", type: "url" },
    ],
    defaultRow: {
      name: "",
      email: "",
      company: "",
      competitor: "",
      yourEdge: "",
      evidenceUrl: "",
      evidenceText: "",
      linkedinUrl: "",
    },
  },
  "stack-consolidation": {
    description:
      "Consolidation-honesty pitch to a developer whose repo wires up several separate API vendors. One SDK collapses the sprawl; cites the detected stack and one yourEdge fact.",
    fields: [
      { key: "name", label: "Prospect name", type: "text", required: true },
      { key: "email", label: "Prospect email", type: "email", required: true },
      { key: "company", label: "Company", type: "text", required: true },
      {
        key: "vendorStack",
        label: "Vendor stack (comma-separated)",
        type: "textarea",
        required: true,
        placeholder: "e.g. auth0, stripe, sendgrid, datadog",
        hint: "API vendors detected in their repo. Comma-separated.",
      },
      {
        key: "yourEdge",
        label: "Your edge (one sentence)",
        type: "textarea",
        required: true,
        hint: "One specific way you collapse the sprawl. e.g. 'one integration replaces three separate vendors'.",
      },
      {
        key: "evidenceUrl",
        label: "Repo URL (optional)",
        type: "url",
        placeholder: "https://github.com/...",
      },
      { key: "linkedinUrl", label: "LinkedIn URL (optional)", type: "url" },
    ],
    defaultRow: {
      name: "",
      email: "",
      company: "",
      vendorStack: "",
      yourEdge: "",
      evidenceUrl: "",
      linkedinUrl: "",
    },
  },
  "repo-interest": {
    description:
      "Complementary intro to someone who starred a repo in your space (an adjacent tool, not a competitor). References the repo + one fact about how your product helps. One touch, no follow-up.",
    fields: [
      { key: "name", label: "Prospect name", type: "text", required: true },
      { key: "email", label: "Prospect email", type: "email", required: true },
      { key: "company", label: "Company", type: "text", required: true },
      {
        key: "repo",
        label: "Repo they starred (owner/name)",
        type: "text",
        required: true,
        placeholder: "e.g. modelcontextprotocol/servers",
      },
      {
        key: "yourEdge",
        label: "Your edge (one sentence)",
        type: "textarea",
        required: true,
        hint: "How your product helps someone working in this space. e.g. 'one SDK for the tools they're already wiring up'.",
      },
      {
        key: "evidenceUrl",
        label: "Repo URL (optional)",
        type: "url",
        placeholder: "https://github.com/...",
      },
      { key: "linkedinUrl", label: "LinkedIn URL (optional)", type: "url" },
    ],
    defaultRow: {
      name: "",
      email: "",
      company: "",
      repo: "",
      yourEdge: "",
      evidenceUrl: "",
      linkedinUrl: "",
    },
  },
  "luma-events": {
    description:
      "Forward-looking pitch to a publicly-visible attendee of an upcoming Luma event. Hook references the specific event + city + date. One touch, no follow-up.",
    fields: [
      { key: "name", label: "Attendee name", type: "text", required: true },
      { key: "email", label: "Attendee email", type: "email", required: true },
      { key: "company", label: "Company (optional)", type: "text" },
      {
        key: "attendeeBio",
        label: "Attendee bio / role (optional)",
        type: "text",
        placeholder: 'e.g. "Founder @ AcmeAI"',
      },
      {
        key: "eventTitle",
        label: "Event title",
        type: "text",
        required: true,
        placeholder: "e.g. SF AI Builders Meetup",
      },
      {
        key: "eventDate",
        label: "Event date (ISO)",
        type: "text",
        required: true,
        placeholder: "2026-06-10",
        hint: "ISO date or datetime; prompt humanizes to 'tomorrow' / 'next Tuesday'.",
      },
      {
        key: "eventCity",
        label: "Event city",
        type: "text",
        required: true,
        placeholder: "San Francisco",
      },
      {
        key: "eventUrl",
        label: "Luma event URL",
        type: "url",
        required: true,
        placeholder: "https://luma.com/...",
      },
      {
        key: "yourEdge",
        label: "Your edge (one sentence)",
        type: "textarea",
        required: true,
        hint: "How your product helps people going to events like this. e.g. 'a teardown of how X handles Y for hosts/attendees'.",
      },
      { key: "linkedinUrl", label: "LinkedIn URL (optional)", type: "url" },
    ],
    defaultRow: {
      name: "",
      email: "",
      company: "",
      attendeeBio: "",
      eventTitle: "",
      eventDate: "",
      eventCity: "",
      eventUrl: "",
      yourEdge: "",
      linkedinUrl: "",
    },
  },
  "sources-sought": {
    description:
      "Cites a specific SAM.gov Sources Sought / Presolicitation notice and asks the published point of contact for a capability conversation before the requirement is written. Procedural register, not founder-to-founder.",
    fields: [
      { key: "name", label: "Point of contact name", type: "text", required: true },
      { key: "email", label: "Point of contact email", type: "email", required: true },
      { key: "agency", label: "Agency", type: "text", required: true },
      {
        key: "noticeNumber",
        label: "Notice number",
        type: "text",
        required: true,
        placeholder: "e.g. W912DY-26-R-0042",
      },
      {
        key: "noticeType",
        label: "Notice type",
        type: "text",
        required: true,
        placeholder: "Sources Sought / Presolicitation",
      },
      { key: "noticeTitle", label: "Notice title", type: "text", required: true },
      {
        key: "requirementSummary",
        label: "Requirement summary (optional)",
        type: "textarea",
      },
      {
        key: "yourEdge",
        label: "Your edge (one sentence)",
        type: "textarea",
        required: true,
        hint: "One concrete capability fact relevant to the requirement.",
      },
      { key: "noticeUrl", label: "Notice URL (optional)", type: "url" },
    ],
    defaultRow: {
      name: "",
      email: "",
      agency: "",
      noticeNumber: "",
      noticeType: "",
      noticeTitle: "",
      requirementSummary: "",
      yourEdge: "",
      noticeUrl: "",
    },
  },
  "civic-pilot": {
    description:
      "Cites a specific council/county agenda item and its meeting date, and proposes a pilot sized under the micro-purchase threshold or bought off a cooperative purchasing vehicle (Sourcewell, NASPO ValuePoint, OMNIA). Procedural register.",
    fields: [
      { key: "name", label: "Official name", type: "text", required: true },
      { key: "email", label: "Official email", type: "email", required: true },
      { key: "city", label: "City / county", type: "text", required: true },
      { key: "agendaItemTitle", label: "Agenda item title", type: "text", required: true },
      {
        key: "meetingDate",
        label: "Meeting date (ISO)",
        type: "text",
        required: true,
        placeholder: "2026-06-10",
      },
      {
        key: "purchasingVehicle",
        label: "Purchasing vehicle",
        type: "text",
        required: true,
        placeholder: "e.g. Sourcewell / NASPO ValuePoint / OMNIA",
      },
      {
        key: "yourEdge",
        label: "Your edge (one sentence)",
        type: "textarea",
        required: true,
        hint: "How your product fits the agenda item's stated need.",
      },
      { key: "agendaUrl", label: "Agenda URL (optional)", type: "url" },
    ],
    defaultRow: {
      name: "",
      email: "",
      city: "",
      agendaItemTitle: "",
      meetingDate: "",
      purchasingVehicle: "",
      yourEdge: "",
      agendaUrl: "",
    },
  },
  "design-partner-loi": {
    description:
      "An ask-ladder pitch to an enterprise, government or hardware buyer: a scoped design-partner conversation first, stepping up to a pilot slot then a non-binding LOI on later touches. Never for an owner-operator buyer — see free-pilot/discovery-interview instead.",
    fields: [
      { key: "name", label: "Prospect name", type: "text", required: true },
      { key: "email", label: "Prospect email", type: "email", required: true },
      { key: "company", label: "Company", type: "text", required: true },
      {
        key: "buyerType",
        label: "Buyer type",
        type: "text",
        required: true,
        placeholder: "enterprise / government / hardware",
        hint: "Never 'owner-operator' or a main-street label — the play refuses to draft for those.",
      },
      {
        key: "yourEdge",
        label: "Your edge (one sentence)",
        type: "textarea",
        required: true,
        hint: "One fact about how your product fits this buyer's evaluation criteria.",
      },
      { key: "linkedinUrl", label: "LinkedIn URL (optional)", type: "url" },
    ],
    defaultRow: {
      name: "",
      email: "",
      company: "",
      buyerType: "",
      yourEdge: "",
      linkedinUrl: "",
    },
  },
  "discovery-interview": {
    description:
      "Asks a main-street owner-operator for ten minutes to learn how they handle one specific thing today. No pitch, no product link, no calendar link, no price — the email exists to earn a reply, not a meeting.",
    fields: [
      { key: "name", label: "Owner name", type: "text", required: true },
      { key: "email", label: "Owner email", type: "email", required: true },
      { key: "company", label: "Business name", type: "text", required: true },
      {
        key: "businessType",
        label: "Business type",
        type: "text",
        required: true,
        placeholder: "e.g. family-owned taqueria · HVAC contractor · two-chair dental practice",
      },
      {
        key: "topic",
        label: "What you want to learn (one sentence)",
        type: "textarea",
        required: true,
        placeholder: "e.g. how they schedule appointments today",
      },
      { key: "linkedinUrl", label: "LinkedIn URL (optional)", type: "url" },
    ],
    defaultRow: {
      name: "",
      email: "",
      company: "",
      businessType: "",
      topic: "",
      linkedinUrl: "",
    },
  },
  "free-pilot": {
    description:
      'The main-street close: set it up for them free, they keep it if it works. Plain language — no "design partner", "pilot program", or "LOI".',
    fields: [
      { key: "name", label: "Owner name", type: "text", required: true },
      { key: "email", label: "Owner email", type: "email", required: true },
      { key: "company", label: "Business name", type: "text", required: true },
      {
        key: "businessType",
        label: "Business type",
        type: "text",
        required: true,
        placeholder: "e.g. family-owned taqueria · HVAC contractor · two-chair dental practice",
      },
      {
        key: "yourEdge",
        label: "Your edge (one sentence)",
        type: "textarea",
        required: true,
        hint: "The concrete thing you set up for them free, in hours or dollars terms. e.g. 'saves about 5 hours a week of phone tag on scheduling'.",
      },
      { key: "linkedinUrl", label: "LinkedIn URL (optional)", type: "url" },
    ],
    defaultRow: {
      name: "",
      email: "",
      company: "",
      businessType: "",
      yourEdge: "",
      linkedinUrl: "",
    },
  },
  "new-business": {
    description:
      "Greenfield outreach to a business whose licence or authority was issued in the last few weeks — nothing to rip out, the ask is to be the tool they start on.",
    fields: [
      { key: "name", label: "Owner name", type: "text", required: true },
      { key: "email", label: "Owner email", type: "email", required: true },
      { key: "company", label: "Business name", type: "text", required: true },
      {
        key: "businessType",
        label: "Business type",
        type: "text",
        required: true,
        placeholder: "e.g. family-owned taqueria · HVAC contractor · two-chair dental practice",
      },
      {
        key: "licenseType",
        label: "Licence / authority type",
        type: "text",
        required: true,
        placeholder: "e.g. food service permit · contractor licence · motor carrier authority",
      },
      {
        key: "issuedAgo",
        label: "Issued (plain words)",
        type: "text",
        required: true,
        placeholder: "e.g. 3 weeks ago · this month",
      },
      {
        key: "yourEdge",
        label: "Your edge (one sentence)",
        type: "textarea",
        required: true,
        hint: "The concrete thing that helps a business at this exact starting point.",
      },
      { key: "linkedinUrl", label: "LinkedIn URL (optional)", type: "url" },
    ],
    defaultRow: {
      name: "",
      email: "",
      company: "",
      businessType: "",
      licenseType: "",
      issuedAgo: "",
      yourEdge: "",
      linkedinUrl: "",
    },
  },
};
