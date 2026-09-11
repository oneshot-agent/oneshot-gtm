import { emailDomain } from "./_lib.ts";
import { type EmailPlayDef, runEmailPlay, standardEnrich } from "./_run-play.ts";
import { discoveryInterviewMetadata } from "./_metadata.ts";
import { buildFollowUpEmail, registerSequence } from "./_cadence.ts";

const PLAY_NAME = "discovery-interview";

export interface DiscoveryInterviewTarget {
  name: string;
  email: string;
  /** The owner-operator's business (a restaurant, a plumbing company, ...). */
  company: string;
  /** e.g. "family-owned taqueria", "HVAC contractor", "two-chair dental practice". */
  businessType: string;
  /** The one specific thing you want to learn about how they run the business today. */
  topic: string;
  linkedinUrl?: string;
  phone?: string;
  /** The profile/finder URL this candidate was sourced from, if any. Persisted
   *  to the prospect row as a re-enrichment key. */
  sourceProfileUrl?: string;
  /** Job title from the person-level ICP gate — persisted to prospects.title. */
  title?: string;
}

export interface DiscoveryInterviewRunOptions {
  dryRun: boolean;
  targets: DiscoveryInterviewTarget[];
  /** Per-target progress hook installed by /api/run SSE handler. */
  onProgress?: (
    index: number,
    draft: { subject: string; body: string; flags: string[]; sent: boolean; receiptIds: number[] },
  ) => void;
  /** Abort signal for the run — see `runEmailPlay`'s `signal`. */
  signal?: AbortSignal;
  /** Explicit draft argument chosen by the user; bypasses automatic angle selection. */
  draftAngle?: string;
}

export interface DiscoveryInterviewDraft {
  target: DiscoveryInterviewTarget;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
}

const discoveryInterviewDef: EmailPlayDef<DiscoveryInterviewTarget> = {
  playName: PLAY_NAME,
  promptName: "discovery-interview-email",
  maxBodyWords: 89, // prompt caps the body under 90 words; 89 is the actual enforced ceiling
  // discovery-interview-email.md's "Hard bans (binding, no exceptions)"
  // section forbids a product link, a price, and any discount/trial framing
  // (finding: discovery-interview-email.md:9) — lintEmail() alone has no
  // check for those, only the literal string "calendly", so an offending
  // completion could reach sendDraftedEmail with an empty flags array and
  // autosend. hardBans wires hardBanFlags() into the pre-send flag set.
  hardBans: true,
  // Two-touch: one soft nudge, no breakup. An owner-operator who ignored a
  // ten-minute ask does not want a chase — mirrors repo-interest, not the
  // four-touch founder sequences.
  enrollCadence: true,
  // Server-side mirror of playSchemas.ts's required fields for this play
  // (finding: apps/web/src/lib/playSchemas.ts:417 — the client-only check
  // can be bypassed by a direct API call or a hand-edited queue row).
  requiredFields: ["name", "email", "company", "businessType", "topic"],
  toEmail: (t) => t.email,
  // Enrich on preview + send (cached by email). No deepResearch — this play
  // asks to learn, it doesn't pitch, so there's nothing to research for.
  prepare: (t) =>
    standardEnrich({
      playName: PLAY_NAME,
      enrichInput: {
        ...(t.email ? { email: t.email } : {}),
        name: t.name,
        companyDomain: emailDomain(t.email),
      },
      enrichSlice: 3500,
    }),
  buildInputBlock: (t, prep, cfg) =>
    [
      `FOUNDER: ${cfg.founderName}`,
      `PRODUCT: ${cfg.productOneLiner}`,
      `PROSPECT: ${t.name} at ${t.company}`,
      `BUSINESS TYPE: ${t.businessType}`,
      `TOPIC: ${t.topic}`,
      `DOSSIER:\n${prep.dossier || "(dry-run)"}`,
    ].join("\n"),
  prospectMeta: (t) => ({
    name: t.name,
    email: t.email,
    company: t.company,
    linkedin_url: t.linkedinUrl ?? null,
    phone: t.phone ?? null,
    source: "discovery-interview",
    source_profile_url: t.sourceProfileUrl ?? null,
  }),
  metadata: discoveryInterviewMetadata,
};

export function runDiscoveryInterview(
  opts: DiscoveryInterviewRunOptions,
): Promise<{ drafted: DiscoveryInterviewDraft[] }> {
  return runEmailPlay(discoveryInterviewDef, opts);
}

// Two-touch cadence: one soft re-ask, no breakup. An owner-operator who
// didn't reply to a ten-minute ask doesn't want a four-touch chase — mirrors
// repo-interest's shape exactly.
registerSequence({
  playName: PLAY_NAME,
  steps: [
    {
      dayOffset: 4,
      channel: "email",
      breakOnReply: true,
      label: "one more ask",
      // Prompt caps this at ≤ 30 words (discovery-interview-followup.md) —
      // enforced here, not the cadence-wide default of 100 (finding:
      // discovery-interview-followup.md:18).
      maxBodyWords: 30,
      builder: buildFollowUpEmail({
        playName: PLAY_NAME,
        promptName: "discovery-interview-followup",
        contextLines: [
          `PLAY: discovery-interview. Re-ask the same ten-minute ask; no pitch, no product link, no calendar link, no price.`,
        ],
      }),
    },
  ],
});
