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
};
