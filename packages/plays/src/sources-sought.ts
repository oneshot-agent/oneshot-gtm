import { emailDomain } from "./_lib.ts";
import { type EmailPlayDef, runEmailPlay, standardEnrich } from "./_run-play.ts";
import { sourcesSoughtMetadata } from "./_metadata.ts";
import { buildFollowUpEmail, getStep0MetadataField, registerSequence } from "./_cadence.ts";

const PLAY_NAME = "sources-sought";

export interface SourcesSoughtTarget {
  /** Contact from SAM.gov's published pointOfContact — full name, title, email. */
  name: string;
  email: string;
  agency: string;
  /** The specific SAM.gov notice number (e.g. "W912DY-26-R-0042"). */
  noticeNumber: string;
  /** "Sources Sought" or "Presolicitation" — the human label for ptype r/p. */
  noticeType: string;
  noticeTitle: string;
  noticeUrl?: string;
  /** What the agency named as the requirement, from the notice description. */
  requirementSummary?: string;
  /** One fact about how your product answers the requirement (specific, not a capability list). */
  yourEdge: string;
  phone?: string;
  /** Job title from the published POC — persisted to prospects.title. */
  title?: string;
  /**
   * The notice's response-window close date (ISO). Optional (not every
   * finder captures it), but when present the day-5 follow-up (issue #463 /
   * finding PRRT_kwDOSKzrBs6ewQdC) skips sending once it has passed instead
   * of chasing a capability conversation the notice can no longer act on.
   */
  responseDeadline?: string;
}

export interface SourcesSoughtRunOptions {
  dryRun: boolean;
  targets: SourcesSoughtTarget[];
  /** Per-target progress hook installed by /api/run SSE handler. */
  onProgress?: (
    index: number,
    draft: { subject: string; body: string; flags: string[]; sent: boolean; receiptIds: number[] },
  ) => void;
  /** Abort signal for the run — see `runEmailPlay`'s `signal`. */
  signal?: AbortSignal;
}

export interface SourcesSoughtDraft {
  target: SourcesSoughtTarget;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
}

const sourcesSoughtDef: EmailPlayDef<SourcesSoughtTarget> = {
  playName: PLAY_NAME,
  promptName: "sources-sought-email",
  maxBodyWords: 150,
  // One-touch + one follow-up: the notice has a response deadline, so a long
  // chase doesn't fit — either the capability conversation happens before the
  // solicitation is written, or the window closes.
  enrollCadence: true,
  toEmail: (t) => t.email,
  // Published POC contact — no findEmail/verifyEmail spend (gov-solicitation
  // already carries a verified address from SAM.gov). Enrich is best-effort
  // personalization only.
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
      `PROSPECT: ${t.name} at ${t.agency}`,
      `NOTICE NUMBER: ${t.noticeNumber}`,
      `NOTICE TYPE: ${t.noticeType}`,
      `NOTICE TITLE: ${t.noticeTitle}`,
      `REQUIREMENT SUMMARY: ${t.requirementSummary ?? "(not captured in the notice extract)"}`,
      `RESPONSE DEADLINE: ${t.responseDeadline ?? "(not captured in the notice extract)"}`,
      `YOUR EDGE: ${t.yourEdge}`,
      `DOSSIER:\n${prep.dossier || "(dry-run)"}`,
    ].join("\n"),
  prospectMeta: (t) => ({
    name: t.name,
    email: t.email,
    company: t.agency,
    phone: t.phone ?? null,
    source: "sources-sought",
    source_profile_url: t.noticeUrl ?? null,
  }),
  metadata: sourcesSoughtMetadata,
};

export function runSourcesSought(
  opts: SourcesSoughtRunOptions,
): Promise<{ drafted: SourcesSoughtDraft[] }> {
  return runEmailPlay(sourcesSoughtDef, opts);
}

// One-touch + one follow-up: a Sources Sought response window is weeks, not
// months — a long chase outlives the notice.
registerSequence({
  playName: PLAY_NAME,
  steps: [
    {
      dayOffset: 5,
      channel: "email",
      breakOnReply: true,
      label: "follow-up",
      builder: async (ctx) => {
        // finding PRRT_kwDOSKzrBs6ewQdC / issue #463: the follow-up asks for
        // a pre-solicitation conversation that's no longer actionable once
        // the notice's response window has closed. `responseDeadline` is
        // optional (not every finder captures it) — an unknown deadline is
        // NOT treated as expired, only a deadline that has actually passed
        // skips the send.
        const deadline = getStep0MetadataField(ctx.prospect.id, PLAY_NAME, "responseDeadline");
        if (deadline) {
          const deadlineMs = Date.parse(deadline);
          if (Number.isFinite(deadlineMs) && deadlineMs < Date.now()) return null;
        }
        return buildFollowUpEmail({
          playName: PLAY_NAME,
          promptName: "sources-sought-followup",
          contextLines: [
            `PLAY: sources-sought. Day-5 follow-up before the notice's response window closes.`,
            ...(deadline ? [`RESPONSE DEADLINE: ${deadline}`] : []),
          ],
        })(ctx);
      },
    },
  ],
});
