import { emailDomain } from "./_lib.ts";
import { type EmailPlayDef, runEmailPlay, standardEnrich } from "./_run-play.ts";

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
  /** The repo URL — founder reference only. */
  evidenceUrl?: string;
  linkedinUrl?: string;
  phone?: string;
}

export interface RepoInterestRunOptions {
  dryRun: boolean;
  targets: RepoInterestTarget[];
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
  maxBodyWords: 90,
  // One-touch: a cold interest signal doesn't earn a multi-touch chase, so no
  // cadence enroll (mirrors show-hn / podcast-guest).
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
