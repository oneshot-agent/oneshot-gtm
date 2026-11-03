import type { Database } from "bun:sqlite";

/**
 * LinkedIn sends OneShot accepted whose outcome GTM has not read yet (a job
 * still running when the sender stopped waiting). One row per idempotency
 * key: the LinkedIn sweep resolves it from OneShot's records, and a retry
 * with the key checks the stored job instead of sending again. A row is
 * deleted once the outcome is recorded.
 */
export interface LinkedInPendingSend {
  idempotencyKey: string;
  kind: "message" | "invite";
  requestId: string;
  /** The workspace that owns the account the send went out from. */
  accountWorkspace: string;
  accountId: string;
  prospectId: number | null;
  playName: string;
  stepIndex: number | null;
  queueId: number | null;
  /** What the success path needs to record the send (text, label, the invite's row and note, ...). */
  detail: Record<string, unknown>;
  createdAt: string;
  lastCheckedAt: string | null;
  /** Times the sweep has asked OneShot. */
  checks: number;
}

interface Row {
  idempotency_key: string;
  kind: string;
  request_id: string;
  account_workspace: string;
  account_id: string;
  prospect_id: number | null;
  play_name: string;
  step_index: number | null;
  queue_id: number | null;
  detail_json: string;
  created_at: string;
  last_checked_at: string | null;
  checks: number;
}

function toPending(row: Row): LinkedInPendingSend {
  let detail: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.detail_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      detail = parsed as Record<string, unknown>;
  } catch {
    // An unreadable detail leaves the defaults; the request id still resolves.
  }
  return {
    idempotencyKey: row.idempotency_key,
    kind: row.kind === "invite" ? "invite" : "message",
    requestId: row.request_id,
    accountWorkspace: row.account_workspace,
    accountId: row.account_id,
    prospectId: row.prospect_id,
    playName: row.play_name,
    stepIndex: row.step_index,
    queueId: row.queue_id,
    detail,
    createdAt: row.created_at,
    lastCheckedAt: row.last_checked_at,
    checks: row.checks,
  };
}

export class LinkedInPendingSendStore {
  constructor(private readonly db: Database) {}

  /** Record (or refresh) a pending send. The key is the send's idempotency key. */
  record(input: Omit<LinkedInPendingSend, "createdAt" | "lastCheckedAt" | "checks">): void {
    this.db
      .prepare(
        `INSERT INTO linkedin_pending_sends(idempotency_key, kind, request_id, account_workspace,
           account_id, prospect_id, play_name, step_index, queue_id, detail_json)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO UPDATE SET request_id = excluded.request_id`,
      )
      .run(
        input.idempotencyKey,
        input.kind,
        input.requestId,
        input.accountWorkspace,
        input.accountId,
        input.prospectId,
        input.playName,
        input.stepIndex,
        input.queueId,
        JSON.stringify(input.detail),
      );
  }

  get(idempotencyKey: string): LinkedInPendingSend | null {
    const row = this.db
      .query<Row, [string]>("SELECT * FROM linkedin_pending_sends WHERE idempotency_key = ?")
      .get(idempotencyKey);
    return row ? toPending(row) : null;
  }

  /** Oldest first. */
  list(): LinkedInPendingSend[] {
    return this.db
      .query<Row, []>("SELECT * FROM linkedin_pending_sends ORDER BY created_at, idempotency_key")
      .all()
      .map(toPending);
  }

  /** A cadence's pending send, if any: what /cadences and the cadence's Send read. */
  forCadence(prospectId: number, playName: string): LinkedInPendingSend | null {
    const row = this.db
      .query<Row, [number, string]>(
        `SELECT * FROM linkedin_pending_sends WHERE prospect_id = ? AND play_name = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(prospectId, playName);
    return row ? toPending(row) : null;
  }

  markChecked(idempotencyKey: string): void {
    this.db
      .prepare(
        `UPDATE linkedin_pending_sends SET last_checked_at = datetime('now'), checks = checks + 1
         WHERE idempotency_key = ?`,
      )
      .run(idempotencyKey);
  }

  /** The outcome is recorded (or proved): the row goes. */
  clear(idempotencyKey: string): void {
    this.db
      .prepare("DELETE FROM linkedin_pending_sends WHERE idempotency_key = ?")
      .run(idempotencyKey);
  }
}
