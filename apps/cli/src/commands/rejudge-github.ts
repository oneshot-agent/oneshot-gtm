import { rejudgeGitHubStarsRows } from "@oneshot-gtm/find";
import { header, note, ok, warn } from "../output.ts";

/**
 * Re-judge live github-stars queue rows from their public GitHub evidence
 * (bio, site, account maturity, own repos, profile README on bare profiles).
 *
 * The free counterpart to `research-queue` for people whose only footprint is
 * GitHub, where paid person research usually comes back unavailable. Costs
 * one classifier call per row (two when a bio'd, emailed row also meets the
 * person gate) and 1–3 GitHub API calls.
 */

export interface RejudgeGitHubOpts {
  status?: string;
  id?: number;
  limit?: number;
  concurrency?: number;
  dryRun: boolean;
  rejectApproved: boolean;
  refresh: boolean;
  verbose: boolean;
}

export async function commandRejudgeGitHub(opts: RejudgeGitHubOpts): Promise<void> {
  const status = (opts.status ?? "live").trim().toLowerCase();
  if (status !== "pending" && status !== "approved" && status !== "live") {
    throw new Error(`--status must be pending, approved or live (got "${opts.status}")`);
  }
  header(
    `rejudge-github${opts.dryRun ? " (dry run)" : ""}: ${status} github-stars rows` +
      `${opts.rejectApproved ? ", rejecting approved rows that fail" : ""}`,
  );
  const result = await rejudgeGitHubStarsRows({
    status,
    dryRun: opts.dryRun,
    rejectApproved: opts.rejectApproved,
    refresh: opts.refresh,
    ...(opts.id !== undefined ? { id: opts.id } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    onRow: (r) => {
      if (opts.verbose || opts.dryRun) {
        note(
          `#${r.id} @${r.login ?? "?"} ${r.verdict}${r.statusChanged ? " → rejected" : ""}: ${r.reason}`,
        );
      }
    },
  });
  ok(
    `considered ${result.considered}  judged ${result.judged}  pass ${result.pass}  ` +
      `reject ${result.reject}  skipped ${result.skipped}  moved to rejected ${result.statusChanged}  ` +
      `README reads ${result.readmeReads}`,
  );
  if (result.reject > result.statusChanged && !opts.dryRun && status !== "pending") {
    warn(
      "Approved rows that failed were annotated, not moved. Re-run with --reject-approved to move them.",
    );
  }
}
