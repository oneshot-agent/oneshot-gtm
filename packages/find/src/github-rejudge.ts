import { getLedger, logEvent, parallelMap, type QueueRow } from "@oneshot-gtm/core";
import { icpFilter, qualifyPerson, resolveIcp } from "./_filter.ts";
import { buildGitHubEvidence } from "./_github-evidence.ts";
import { fetchGitHubUser } from "./_github-user.ts";
import { githubStarsLogin } from "./queue-contact.ts";

const SOURCE_PREFIX = "find:github-stars:";
const PLAYS = ["repo-interest", "competitor-switch"] as const;

export interface GitHubRejudgeOpts {
  /** Which live rows to consider. Default "live" (pending + approved). */
  status?: "pending" | "approved" | "live";
  /** Re-judge exactly this row (still github-stars and live only). */
  id?: number;
  /** Max rows judged this run, oldest first. */
  limit?: number;
  concurrency?: number;
  /** Judge and report; write nothing. */
  dryRun?: boolean;
  /**
   * Approved rows are a human decision; a reject verdict only annotates them
   * unless this is set, in which case they move to rejected like pending rows.
   */
  rejectApproved?: boolean;
  /** Re-judge rows that already carry a GitHub re-judge. */
  refresh?: boolean;
  /** ICP override (tests / workspaces); defaults to the configured ICP. */
  icp?: string | null;
  onRow?: (row: GitHubRejudgeRow) => void;
}

export interface GitHubRejudgeRow {
  id: number;
  login: string | null;
  verdict: "pass" | "reject" | "skipped";
  reason: string;
  statusChanged: boolean;
}

export interface GitHubRejudgeResult {
  considered: number;
  judged: number;
  pass: number;
  reject: number;
  skipped: number;
  statusChanged: number;
  readmeReads: number;
}

function payloadOf(row: QueueRow): Record<string, unknown> {
  try {
    const p = JSON.parse(row.payload_json) as unknown;
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function selectRows(opts: GitHubRejudgeOpts): QueueRow[] {
  const ledger = getLedger();
  if (opts.id != null) {
    const row = ledger.getQueueRow(opts.id);
    return row && row.source.startsWith(SOURCE_PREFIX) ? [row] : [];
  }
  const statuses =
    opts.status === "pending" || opts.status === "approved"
      ? [opts.status]
      : (["pending", "approved"] as const);
  const rows: QueueRow[] = [];
  for (const playName of PLAYS) {
    for (const status of statuses) {
      rows.push(
        ...ledger
          .listQueue({ playName, status, limit: 1_000_000 })
          .filter((r) => r.source.startsWith(SOURCE_PREFIX) && !r.sent_at && !r.send_started_at),
      );
    }
  }
  return rows
    .filter((r) => opts.refresh || !payloadOf(r)["githubRejudgedAt"])
    .toSorted((a, b) => a.id - b.id)
    .slice(0, opts.limit ?? Number.POSITIVE_INFINITY);
}

/**
 * Re-run the github-stars ICP decision on existing queue rows from the
 * evidence GitHub itself publishes (bio, site, account maturity, own repos,
 * profile README on bare profiles) — no paid research. Built for rows the
 * gate judged on a bare star, or that a human re-opened in bulk.
 *
 * Writes the evidence and verdict onto the payload. A reject moves a pending
 * row to rejected; an approved row only with `rejectApproved`. A transient
 * GitHub or classifier failure skips the row and never rejects it.
 */
export async function rejudgeGitHubStarsRows(
  opts: GitHubRejudgeOpts = {},
): Promise<GitHubRejudgeResult> {
  const ledger = getLedger();
  const icp = opts.icp === undefined ? resolveIcp() : opts.icp;
  const rows = selectRows(opts);
  const result: GitHubRejudgeResult = {
    considered: rows.length,
    judged: 0,
    pass: 0,
    reject: 0,
    skipped: 0,
    statusChanged: 0,
    readmeReads: 0,
  };
  const report = (r: GitHubRejudgeRow): void => {
    if (r.verdict === "skipped") result.skipped++;
    else {
      result.judged++;
      result[r.verdict]++;
    }
    if (r.statusChanged) result.statusChanged++;
    opts.onRow?.(r);
  };

  await parallelMap(rows, opts.concurrency ?? 3, async (row) => {
    const payload = payloadOf(row);
    const login =
      githubStarsLogin(row) ??
      (typeof payload["candidateLogin"] === "string" ? payload["candidateLogin"] : null);
    const skip = (reason: string): void =>
      report({ id: row.id, login, verdict: "skipped", reason, statusChanged: false });
    if (!login) return skip("no GitHub login on row");

    const user = await fetchGitHubUser(login);
    if (!user) return skip("GitHub profile unavailable");
    const evidence = await buildGitHubEvidence(user);
    if (evidence.readReadme) result.readmeReads++;
    const repo = row.source.slice(SOURCE_PREFIX.length);
    const name = user.name ?? (typeof payload["name"] === "string" ? payload["name"] : login);

    const filter = await icpFilter({
      icp,
      candidate: {
        title: name,
        url: `https://github.com/${login}`,
        summary: `${evidence.text}\nStarred: ${repo}`,
      },
    });
    if (filter.match === null) return skip("ICP classifier unavailable");
    let verdict: "pass" | "reject" = filter.match ? "pass" : "reject";
    let reason = filter.reason ?? (filter.match ? "fits" : "does not fit the ICP");

    // A reachable person with a self-description also gets the person gate,
    // judged on the bio. Only a clear reject overrides the pass.
    if (verdict === "pass" && user.bio && typeof payload["email"] === "string") {
      const person = await qualifyPerson({
        icp,
        person: {
          name,
          company: user.company?.trim() ?? null,
          roleText: user.bio,
          evidence: `starred ${repo}`,
        },
      });
      if (person.verdict === "reject") {
        verdict = "reject";
        reason = person.reason ?? reason;
      }
    }

    if (opts.dryRun) {
      return report({ id: row.id, login, verdict, reason, statusChanged: false });
    }
    const patched = ledger.patchLiveQueuePayload({
      id: row.id,
      patch: {
        githubEvidence: evidence.text,
        icpVerdict: verdict,
        icpVerdictReason: reason,
        githubRejudgedAt: new Date().toISOString(),
      },
    });
    if (!patched) return skip("row no longer live");

    let statusChanged = false;
    if (verdict === "reject") {
      const note = `auto: ICP — re-judged from GitHub: ${reason}`.slice(0, 320);
      if (row.status === "pending" || (row.status === "approved" && opts.rejectApproved)) {
        ledger.setQueueStatus({
          id: row.id,
          status: "rejected",
          notes: note,
          decidedBy: "machine",
        });
        statusChanged = true;
      } else {
        ledger.setQueueNotes({
          id: row.id,
          notes: [row.notes, `re-judged from GitHub: ${reason}`].filter(Boolean).join(" — "),
        });
      }
    }
    logEvent("github_rejudge.row", {
      queue_id: row.id,
      verdict,
      status_changed: statusChanged,
      readme: evidence.readReadme,
    });
    report({ id: row.id, login, verdict, reason, statusChanged });
  });

  return result;
}
