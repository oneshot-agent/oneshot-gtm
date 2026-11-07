import type { Database } from "bun:sqlite";
import type { CadencePresenceInput } from "./shared-db.ts";

/**
 * This ledger's cadences as the shared `cadence_presence` table mirrors them
 * (shared-db.ts): every cadence, or only those of `prospectIds`, with the
 * prospect's email and profile URL. Ended cadences are included; the shared
 * side decides which statuses are live.
 */
export function readCadencePresence(db: Database, prospectIds?: number[]): CadencePresenceInput[] {
  const sql = `SELECT c.prospect_id AS prospectId, c.play_name AS playName, c.status AS status,
                      p.email AS email, p.linkedin_url AS linkedinUrl
               FROM cadence_state c LEFT JOIN prospects p ON p.id = c.prospect_id`;
  if (!prospectIds) return db.query(sql).all() as CadencePresenceInput[];
  return prospectIds.flatMap(
    (id) => db.query(`${sql} WHERE c.prospect_id = ?`).all(id) as CadencePresenceInput[],
  );
}
