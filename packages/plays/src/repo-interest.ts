import { emailDomain } from "./_lib.ts";
import { type EmailPlayDef, runEmailPlay, standardEnrich } from "./_run-play.ts";
import { buildFollowUpEmail, registerSequence } from "./_cadence.ts";

const PLAY_NAME = "repo-interest";

export interface RepoInterestTarget {
  name: string;
  email: string;
  company: string;
  /** "owner/name" of the repo they starred (an adjacent/category tool, not a competitor). */
  repo: string;
  /** Display name for the repo (e.g. "MCP servers"); falls back to `repo`. */
  repoLabel?: string;
  /** One fact about how your product helps someone working in this space. */
  yourEdge: string;
  /**
   * Optional: one true line on why THIS repo is notable + the respectful
   * bridge to your offer. Used as a peer-level shared-taste nod (never
   * flattery) that also shapes how the offer is framed.
   */
  repoEdge?: string;
  /** The repo URL — founder reference only. */
  evidenceUrl?: string;
  linkedinUrl?: string;
  phone?: string;
  /** Candidate's GitHub login — kept on the payload so a future regenerate can
   *  re-fetch their repos if we ever want it. Not consumed by the prompt today. */
  candidateLogin?: string;
  /**
   * Candidate's own top public repos (sorted by recent push, forks excluded).
   * Optional context fed to the prompt — the LLM picks at most one to weave
   * as shared-taste evidence, or ignores when nothing fits. Absent / empty =
   * the prompt's no-candidate-repos path kicks in.
   */
  candidateRepos?: Array<{
    name: string;
    description: string | null;
    language: string | null;
  }>;
}

export interface RepoInterestRunOptions {
  dryRun: boolean;
  targets: RepoInterestTarget[];
  /** Per-target progress hook installed by /api/run SSE handler. */
  onProgress?: (
    index: number,
    draft: { subject: string; body: string; flags: string[]; sent: boolean; receiptIds: number[] },
  ) => void;
}

export interface RepoInterestDraft {
  target: RepoInterestTarget;
  subject: string;
  body: string;
  receiptIds: number[];
  sent: boolean;
  flags: string[];
}

const repoInterestDef: EmailPlayDef<RepoInterestTarget> = {
  playName: PLAY_NAME,
  promptName: "repo-interest-email",
  // 150 across all plays — generous safety net. The prompt-side AIM stays
  // tight (under ~90 reads tighter); the lint just stops gating drafts that
  // miss the aim by a few words. Real run-on slop still gets flagged.
  maxBodyWords: 150,
  // Two-touch: the intro plus one soft day-3 ping (no breakup). A peer who
  // starred an adjacent repo earns a single gentle nudge, not a full chase.
  enrollCadence: true,
  toEmail: (t) => t.email,
  // Enrich on preview + send (cached by email). No deepResearch — the starred
  // repo is the load-bearing signal, like stack-consolidation's vendor stack.
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
      `STARRED REPO: ${t.repoLabel ?? t.repo}`,
      `YOUR EDGE: ${t.yourEdge}`,
      ...(t.repoEdge
        ? [`WHY THIS REPO IS NOTABLE (peer nod + how your offer fits — see prompt): ${t.repoEdge}`]
        : []),
      ...(Array.isArray(t.candidateRepos) && t.candidateRepos.length > 0
        ? [
            `CANDIDATE REPOS (their public work, sorted by recent push):`,
            ...t.candidateRepos.map(
              (r) =>
                `- ${r.name}${r.language ? ` [${r.language}]` : ""}: ${r.description ?? "(no description)"}`,
            ),
          ]
        : []),
      `DOSSIER:\n${prep.dossier || "(dry-run)"}`,
    ].join("\n"),
  prospectMeta: (t) => ({
    name: t.name,
    email: t.email,
    company: t.company,
    linkedin_url: t.linkedinUrl ?? null,
    phone: t.phone ?? null,
    source: "repo-interest",
  }),
  metadata: (t) => ({ repo: t.repo }),
};

export function runRepoInterest(
  opts: RepoInterestRunOptions,
): Promise<{ drafted: RepoInterestDraft[] }> {
  return runEmailPlay(repoInterestDef, opts);
}

// Two-touch cadence: one soft day-3 ping, no breakup. Mirrors
// stack-consolidation's structure minus the final breakup step.
registerSequence({
  playName: PLAY_NAME,
  steps: [
    {
      dayOffset: 3,
      channel: "email",
      breakOnReply: true,
      label: "value follow-up",
      builder: buildFollowUpEmail({
        playName: PLAY_NAME,
        promptName: "repo-interest-followup",
        contextLines: [
          `PLAY: repo-interest. Day-3 soft nudge after the peer-to-peer intro about a repo they starred.`,
        ],
      }),
    },
  ],
});
