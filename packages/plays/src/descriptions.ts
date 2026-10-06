import type { PlayDescription } from "@oneshot-gtm/shared-types";

/** Founder-facing copy shared by the API and documentation. Timing stays in the cadence registry. */
export const PLAY_DESCRIPTIONS: Record<string, PlayDescription> = {
  "show-hn": {
    whenToUse: "A founder has launched something relevant on Show HN.",
    actions: "Drafts a contextual email and sends it when run live; it does not post on HN.",
    requires: "Founder contact, launch URL and a specific observation from the launch.",
    produces: "An email draft, with a recorded send when dispatched.",
  },
  "job-change": {
    whenToUse: "A buyer has moved into a role where your product could help.",
    actions: "Drafts outreach about their new responsibilities and runs the configured follow-ups.",
    requires: "Contact, new role and company, plus your concrete product advantage.",
    produces: "An email draft, recorded sends and a follow-up cadence.",
  },
  "post-funding": {
    whenToUse: "A relevant company has announced funding and may be changing priorities.",
    actions: "Drafts funding-context outreach and sends email with the configured follow-ups.",
    requires: "Buyer contact, company, round, amount and announcement source.",
    produces: "An email draft, recorded sends and a follow-up cadence.",
  },
  "accelerator-batch": {
    whenToUse: "Your buyers are building companies in an accelerator cohort.",
    actions:
      "Drafts cohort-context email and runs the configured follow-ups without implying you share their affiliation.",
    requires: "Founder contact, company, cohort and a specific useful observation or offer.",
    produces: "Personalized email drafts and recorded cadence activity.",
  },
  concierge: {
    whenToUse: "A new signup needs guided onboarding.",
    actions: "Runs an automated voice call, with optional preparation and summary emails.",
    requires: "Name, email, phone and onboarding context; a call window is optional.",
    produces: "Call results, email drafts and receipts for dispatched actions.",
  },
  "demo-no-show": {
    whenToUse: "A prospect missed an already scheduled demo.",
    actions:
      "Sends a recovery email and, when a phone is supplied, an SMS; schedules the follow-up.",
    requires: "Contact, company, missed-demo time and a real rescheduling link.",
    produces: "Recovery message drafts, recorded sends and a follow-up cadence.",
  },
  "competitor-switch": {
    whenToUse: "A buyer has a relevant connection to a competing product.",
    actions:
      "Drafts an honest switching pitch from available evidence and sends email with configured follow-ups.",
    requires:
      "Contact, company, competitor and a specific supported advantage; usage claims need evidence.",
    produces: "A migration-focused draft and recorded outreach activity.",
  },
  "stack-consolidation": {
    whenToUse: "A repository integrates several vendors your product could consolidate.",
    actions: "Drafts email about reducing integration work and runs configured follow-ups.",
    requires: "Contact, detected vendor stack and a concrete consolidation advantage.",
    produces: "A stack-specific email draft and recorded outreach activity.",
  },
  "repo-interest": {
    whenToUse: "Someone stars an adjacent repository relevant to your product.",
    actions: "Drafts a complementary introduction, then sends email with configured follow-ups.",
    requires: "Contact, starred repository and a factual connection to what you offer.",
    produces: "An interest-based email draft and recorded outreach activity.",
  },
  "luma-events": {
    whenToUse: "An upcoming event overlaps with your buyers and location.",
    actions:
      "Drafts event-context outreach to public hosts or guests and sends through the configured motion.",
    requires: "Contact, event title, date, location, URL and your relevant offer.",
    produces: "An event-specific draft and recorded outreach; stale events are held for review.",
  },
  "hiring-signal": {
    whenToUse: "An open role reveals work your product could help a company perform.",
    actions:
      "Researches the job context, drafts email to the hiring owner and runs configured follow-ups.",
    requires: "Contact, company, job title or posting, and your supported ramp-time claim.",
    produces: "A hiring-context draft and recorded outreach activity.",
  },
  "podcast-guest": {
    whenToUse: "A podcast guest described a problem relevant to your work.",
    actions: "Drafts and sends a one-touch email anchored to a specific episode moment.",
    requires: "Guest contact, podcast, episode and an exact quotation or timestamped observation.",
    produces: "An episode-specific email draft and recorded outreach activity.",
  },
  "breakup-revive": {
    whenToUse: "An eligible past conversation has gone quiet for the selected cold window.",
    actions: "Reads prior ledger activity and drafts a fresh email to reopen the conversation.",
    requires:
      "An existing contact with outreach history; not-a-fit and do-not-contact stops stay excluded.",
    produces: "A revival draft and a recorded send when dispatched.",
  },
  "profile-intro": {
    whenToUse: "You have identified a person directly rather than through a timed signal.",
    actions: "Uses Add Prospect research to draft an introduction on the selected channel.",
    requires: "A LinkedIn or X profile, founder positioning and a reachable channel.",
    produces: "A queue row and introduction draft; API channels send, while X is posted manually.",
  },
  "x-repost-intro": {
    whenToUse: "A potential product user reposts or quotes an account you watch.",
    actions:
      "Uses the repost and buyer context to draft an adoption introduction with configured follow-ups.",
    requires: "A watched account, repost evidence, buyer fit and reachable contact.",
    produces:
      "An outreach draft and recorded activity on the selected channel; X sends are manual.",
  },
  "x-amplify": {
    whenToUse: "A relevant account could share your launch and has a reachable email.",
    actions:
      "Drafts and sends a one-touch email asking for amplification, grounded in their repost.",
    requires: "Contact, X handle and repost evidence; supply a launch date only when known.",
    produces: "An amplification email draft and a recorded send.",
  },
  "x-amplify-dm": {
    whenToUse: "You want to approach an amplifier directly on X.",
    actions: "Drafts a DM or public reply for you to copy and send by hand.",
    requires: "X handle, repost evidence and DM availability; no email is needed.",
    produces: "A manual message draft; Mark sent records your confirmed activity.",
  },
  "sources-sought": {
    whenToUse: "An agency is gathering capabilities before a procurement.",
    actions:
      "Drafts an email answering a Sources Sought or Presolicitation notice and follows the configured cadence.",
    requires: "Published contact, agency, notice details and a supported fit to the requirement.",
    produces: "A notice-specific outreach draft and recorded sends, not a submitted bid.",
  },
  "civic-pilot": {
    whenToUse: "A city or county agenda identifies a need suited to a small pilot.",
    actions:
      "Drafts email connecting the agenda item to a feasible pilot and runs configured follow-ups.",
    requires:
      "Contact, municipality, agenda item, meeting date, your advantage and a purchasing vehicle or threshold.",
    produces: "A pilot outreach draft and recorded sends, not a procurement approval.",
  },
  "design-partner-loi": {
    whenToUse: "An enterprise, government or hardware buyer could help shape a scoped pilot.",
    actions:
      "Drafts email that progresses from problem ownership toward a design-partner discussion and pilot.",
    requires: "Contact, company, eligible buyer type and your specific product advantage.",
    produces: "Drafts and recorded cadence activity, not a signed letter of intent.",
  },
  "discovery-interview": {
    whenToUse: "You need to learn how an owner-operator handles a specific problem.",
    actions: "Drafts a learning-focused email and runs configured follow-ups.",
    requires: "Contact, business, business type and the concrete topic you want to understand.",
    produces: "Interview-request drafts and recorded outreach, not completed interviews.",
  },
  "free-pilot": {
    whenToUse: "You can offer an owner-operator a concrete, small piece of work for free.",
    actions: "Drafts a practical pilot offer and sends email with configured follow-ups.",
    requires: "Contact, business type and exactly what you will set up for them.",
    produces: "Pilot-offer drafts and recorded outreach; delivery of the pilot remains yours.",
  },
  "new-business": {
    whenToUse: "A recently licensed or registered business has an immediate setup need.",
    actions: "Drafts email tied to the opening signal and runs configured follow-ups.",
    requires: "Contact, business type, license type, recency and your concrete offer.",
    produces: "Opening-context drafts and recorded outreach activity.",
  },
  "community-reply": {
    whenToUse: "Someone publicly asks for recommendations, compares tools or seeks a replacement.",
    actions: "Drafts a helpful Reddit or HN reply with your affiliation for you to post by hand.",
    requires: "Thread evidence, author handle and your verified product brief; no email needed.",
    produces:
      "A public-reply draft; Mark posted records your confirmation without starting a cadence.",
  },
};
