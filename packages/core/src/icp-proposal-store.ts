import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { IcpProposalStatus, IcpProposalView } from "@oneshot-gtm/shared-types";

/**
 * Learning-loop v2 (issue #750): a periodic, rate-limited job proposes a
 * tighter ICP one-liner from accumulated human approve/reject decisions, but
 * the active ICP never changes without an explicit founder approval on
 * `/queue`. This store holds the generated proposals and a single-row
 * evaluation lease/cooldown, mirroring `ReplyLearningStore`'s claim/finish/fail
 * lease pattern for v1 (packages/core/src/reply-learning-store.ts). Its
 * tables are created by `ledger-schema.ts`'s migrations (v29), not here: this
 * store shares the Ledger's own database handle, unlike `ReplyLearningStore`
 * / `ReplyReviewStore`, which own a wholly separate sqlite file and so create
 * their own tables in their constructors.
 */

interface StateRow {
  id: 1;
  /** `Date.now()` of the last evaluation attempt (lease taken), for the cooldown. */
  attempted_ms: number;
  error: string | null;
  token: string | null;
  until_ms: number;
}

interface ProposalRow {
  id: string;
  current_icp: string;
  proposed_icp: string;
  evidence_summary: string;
  created_at: string;
  status: IcpProposalStatus;
  decided_at: string | null;
}

/** Same normalization `reply-learning-store.ts` uses for duplicate instruction text. */
const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Exported so callers can compare a freshly-proposed ICP against the current one. */
export function normalizeIcpText(s: string): string {
  return normalize(s);
}

/** Default floor for `OneShotConfig.icpProposalMinDecisions` (config.ts's DEFAULTS). */
export const DEFAULT_ICP_PROPOSAL_MIN_DECISIONS = 30;

function toView(row: ProposalRow): IcpProposalView {
  return {
    id: row.id,
    currentIcp: row.current_icp,
    proposedIcp: row.proposed_icp,
    evidenceSummary: row.evidence_summary,
    createdAt: row.created_at,
    status: row.status,
    decidedAt: row.decided_at,
  };
}

export class IcpProposalStore {
  constructor(private readonly db: Database) {}

  /** Ensures the single state row exists and returns it. */
  state(): StateRow {
    this.db.query("INSERT OR IGNORE INTO icp_proposal_state(id) VALUES(1)").run();
    return this.db.query<StateRow, []>("SELECT * FROM icp_proposal_state WHERE id=1").get()!;
  }

  /**
   * Take the evaluation lease, gated by an in-progress lease and a cooldown
   * since the last attempt (successful or not). Callers must have already
   * confirmed there is enough evidence to justify a model call: taking the
   * lease also stamps `attempted_ms`, spending the cooldown window whether or
   * not a proposal is ultimately produced (exactly like
   * `ReplyLearningStore.claim`, which reserves before checking the model's
   * response). Returns the lease token, or null when a lease is already held
   * or the cooldown hasn't elapsed.
   */
  beginEvaluation(now: number, cooldownMs: number, leaseMs: number): string | null {
    const s = this.state();
    if (s.until_ms > now) return null;
    if (s.attempted_ms && now - s.attempted_ms < cooldownMs) return null;
    const token = randomUUID();
    this.db
      .query(
        `UPDATE icp_proposal_state SET token=?, until_ms=?, attempted_ms=?
         WHERE id=1 AND until_ms<=? AND (attempted_ms=0 OR ?-attempted_ms>=?)`,
      )
      .run(token, now + leaseMs, now, now, now, cooldownMs);
    // Re-read: the guarded UPDATE above is a no-op if another connection raced
    // this one between the read and the write (its WHERE repeats both checks
    // under the write lock), so only re-reading tells us who actually won.
    return this.state().token === token ? token : null;
  }

  /** A live lease clears without producing a proposal: retried on the next cooldown. */
  fail(token: string, reason: string): void {
    this.db
      .query("UPDATE icp_proposal_state SET token=NULL, until_ms=0, error=? WHERE id=1 AND token=?")
      .run(reason, token);
  }

  /** A completed evaluation, successful or a deliberate no-op: release the lease. */
  finish(token: string): boolean {
    return (
      this.db
        .query(
          "UPDATE icp_proposal_state SET token=NULL, until_ms=0, error=NULL WHERE id=1 AND token=?",
        )
        .run(token).changes > 0
    );
  }

  /** True when a PENDING proposal already carries this normalized text: the de-dup guard. */
  hasPendingDuplicate(proposedIcp: string): boolean {
    const rows = this.db
      .query<{ proposed_icp: string }, []>(
        "SELECT proposed_icp FROM icp_proposals WHERE status='pending'",
      )
      .all();
    const target = normalize(proposedIcp);
    return rows.some((r) => normalize(r.proposed_icp) === target);
  }

  /**
   * True when the MOST RECENT decision on this exact (normalized) text was a
   * dismissal: prevents an identical proposal from immediately recurring
   * right after the founder dismissed it, without permanently banning the
   * text (a later re-evaluation whose evidence has moved on can propose it
   * again once a different proposal has since been decided).
   */
  wasJustDismissed(proposedIcp: string): boolean {
    const target = normalize(proposedIcp);
    const rows = this.db
      .query<{ proposed_icp: string; status: IcpProposalStatus }, []>(
        "SELECT proposed_icp, status FROM icp_proposals ORDER BY created_at DESC, rowid DESC",
      )
      .all();
    const mostRecentForText = rows.find((r) => normalize(r.proposed_icp) === target);
    return mostRecentForText?.status === "dismissed";
  }

  insert(input: {
    currentIcp: string;
    proposedIcp: string;
    evidenceSummary: string;
    createdAt: string;
  }): IcpProposalView {
    const id = randomUUID();
    this.db
      .query(
        "INSERT INTO icp_proposals(id,current_icp,proposed_icp,evidence_summary,created_at,status) VALUES(?,?,?,?,?,'pending')",
      )
      .run(id, input.currentIcp, input.proposedIcp, input.evidenceSummary, input.createdAt);
    return toView(this.row(id)!);
  }

  private row(id: string): ProposalRow | null {
    return this.db.query<ProposalRow, [string]>("SELECT * FROM icp_proposals WHERE id=?").get(id);
  }

  list(status?: IcpProposalStatus): IcpProposalView[] {
    const rows = status
      ? this.db
          .query<ProposalRow, [string]>(
            "SELECT * FROM icp_proposals WHERE status=? ORDER BY created_at DESC",
          )
          .all(status)
      : this.db
          .query<ProposalRow, []>("SELECT * FROM icp_proposals ORDER BY created_at DESC")
          .all();
    return rows.map(toView);
  }

  get(id: string): IcpProposalView | null {
    const row = this.row(id);
    return row ? toView(row) : null;
  }

  /**
   * Flip a PENDING proposal to `approved` or `dismissed`, guarded against a
   * concurrent double-decision: the UPDATE's own `WHERE status='pending'`
   * runs under the write lock, so only one caller's decision can land even if
   * two requests race.
   */
  decide(
    id: string,
    status: "approved" | "dismissed",
    now: string,
  ): { view: IcpProposalView } | { error: string } {
    const existing = this.row(id);
    if (!existing) return { error: `proposal '${id}' not found` };
    const changes = this.db
      .query("UPDATE icp_proposals SET status=?, decided_at=? WHERE id=? AND status='pending'")
      .run(status, now, id).changes;
    if (changes === 0) {
      return { error: `proposal '${id}' was already ${existing.status}` };
    }
    return { view: toView(this.row(id)!) };
  }

  /**
   * Compensating action for the approval route: config.json couldn't be
   * updated after the approval was recorded, so put the proposal back to
   * pending rather than leave a recorded "approval" that never actually took
   * effect on the active ICP.
   */
  revertToPending(id: string): void {
    this.db.query("UPDATE icp_proposals SET status='pending', decided_at=NULL WHERE id=?").run(id);
  }
}
