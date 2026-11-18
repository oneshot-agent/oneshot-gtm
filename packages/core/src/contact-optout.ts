import type { Database } from "bun:sqlite";

/** Check whether an optional ledger table is available to an opt-out query. */
function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) != null;
}

/** Whether prospects carry a shared person id (only a ledger in the shared registry does). */
export function hasSharedPerson(db: Database): boolean {
  return (db.query("PRAGMA table_info(prospects)").all() as Array<{ name: string }>).some(
    (c) => c.name === "shared_person_id",
  );
}

/** The ids of `p`'s person's other rows here (legacy aliases bound to one shared person). */
const SAME_PERSON_IDS = `SELECT o.id FROM prospects o WHERE o.shared_person_id = p.shared_person_id`;

/**
 * Opt-outs override every campaign, including historical human/replied
 * signals. An unsubscribe reply or a do-not-contact call is the person's: it
 * holds every row of their shared person too.
 */
export function contactAllowedClause(db: Database): string {
  const clauses: string[] = [];
  const person = hasSharedPerson(db);
  const replyMatch = `ir.prospect_id = p.id OR lower(ir.from_email) = lower(p.email)${
    person ? ` OR ir.prospect_id IN (${SAME_PERSON_IDS})` : ""
  }`;
  if (hasTable(db, "cadence_state"))
    clauses.push(`NOT EXISTS (
    SELECT 1 FROM cadence_state c WHERE c.prospect_id = p.id AND c.status = 'unsubscribed')`);
  if (hasTable(db, "inbox_replies")) {
    const inboxReplyColumns = new Set(
      (db.query("PRAGMA table_info(inbox_replies)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    if (inboxReplyColumns.has("kind"))
      clauses.push(`NOT EXISTS (
    SELECT 1 FROM inbox_replies ir WHERE ir.kind = 'unsubscribe' AND (${replyMatch}))`);
    // Issue #663: the deliverability `kind` above is phrase-based
    // (reply-classify.ts's UNSUBSCRIBE_RE) and can miss a real "remove me"
    // request, landing it as `kind = 'human'`. The sentiment triage (issue
    // #480) reads the same reply's `intent` column correctly as
    // 'unsubscribe' in that case. Either signal is a do-not-contact: veto
    // on both, guarded separately since `intent` postdates `kind` and an
    // older ledger may have the table without the column.
    if (inboxReplyColumns.has("intent"))
      clauses.push(`NOT EXISTS (
    SELECT 1 FROM inbox_replies ir WHERE ir.intent = 'unsubscribe' AND (${replyMatch}))`);
  }
  // Asked on a call not to be contacted again (ledger-calls.ts): every
  // channel, whether or not a cadence was running to stop.
  if (hasTable(db, "calls"))
    clauses.push(`NOT EXISTS (
    SELECT 1 FROM calls cl WHERE cl.outcome = 'do_not_contact' AND (cl.prospect_id = p.id${
      person ? ` OR cl.prospect_id IN (${SAME_PERSON_IDS})` : ""
    }))`);
  // Sync may have persisted a verdict before the cadence poll consumes it.
  if (
    db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mailbox_messages'").get()
  ) {
    clauses.push(`NOT EXISTS (SELECT 1 FROM mailbox_messages m
      WHERE m.direction = 'inbound' AND json_extract(m.data, '$.kind') = 'unsubscribe'
        AND (m.prospect_id = p.id OR lower(json_extract(m.data, '$.from')) = lower(p.email)))`);
  }
  return clauses.length ? clauses.join(" AND ") : "1=1";
}

/**
 * `contactAllowedClause` for a query over many prospects: the same opt-outs,
 * read once as id and address sets instead of once per prospect. The
 * per-prospect form scans `mailbox_messages` for each row, which took over
 * two minutes across a few thousand prospects on a real ledger.
 */
export function contactAllowedSetClause(db: Database): string {
  // Each part names its column `id` / `email`: a UNION takes the first part's names.
  const ids: string[] = [];
  const emails: string[] = [];
  // Shared person ids an unsubscribe reply or a do-not-contact call holds.
  const people: string[] = [];
  const person = hasSharedPerson(db);
  if (hasTable(db, "cadence_state"))
    ids.push(`SELECT prospect_id AS id FROM cadence_state WHERE status = 'unsubscribed'`);
  if (hasTable(db, "inbox_replies")) {
    const columns = new Set(
      (db.query("PRAGMA table_info(inbox_replies)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    const saidBy = [
      ...(columns.has("kind") ? ["kind"] : []),
      ...(columns.has("intent") ? ["intent"] : []),
    ];
    const said = saidBy.map((c) => `${c} = 'unsubscribe'`).join(" OR ");
    if (said) {
      ids.push(`SELECT prospect_id AS id FROM inbox_replies WHERE ${said}`);
      emails.push(`SELECT lower(from_email) AS email FROM inbox_replies WHERE ${said}`);
      if (person)
        people.push(`SELECT o.shared_person_id AS person FROM inbox_replies ir
          JOIN prospects o ON o.id = ir.prospect_id
          WHERE ${saidBy.map((c) => `ir.${c} = 'unsubscribe'`).join(" OR ")}`);
    }
  }
  if (hasTable(db, "calls")) {
    ids.push(`SELECT prospect_id AS id FROM calls WHERE outcome = 'do_not_contact'`);
    if (person)
      people.push(`SELECT o.shared_person_id AS person FROM calls cl
        JOIN prospects o ON o.id = cl.prospect_id WHERE cl.outcome = 'do_not_contact'`);
  }
  if (hasTable(db, "mailbox_messages")) {
    const said = `direction = 'inbound' AND json_extract(data, '$.kind') = 'unsubscribe'`;
    ids.push(`SELECT prospect_id AS id FROM mailbox_messages WHERE ${said}`);
    emails.push(
      `SELECT lower(json_extract(data, '$.from')) AS email FROM mailbox_messages WHERE ${said}`,
    );
  }
  const clauses: string[] = [];
  if (ids.length)
    clauses.push(`p.id NOT IN (SELECT id FROM (${ids.join(" UNION ")}) WHERE id IS NOT NULL)`);
  if (people.length)
    clauses.push(`(p.shared_person_id IS NULL OR p.shared_person_id NOT IN (
      SELECT person FROM (${people.join(" UNION ")}) WHERE person IS NOT NULL))`);
  if (emails.length)
    clauses.push(
      `(p.email IS NULL OR lower(p.email) NOT IN (SELECT email FROM (${emails.join(" UNION ")}) WHERE email IS NOT NULL))`,
    );
  return clauses.length ? clauses.join(" AND ") : "1=1";
}

/** Cross-channel enrollment guard. The SQL clause expects the prospect alias `p`. */
export function isProspectOptedOut(db: Database, prospectId: number): boolean {
  return (
    db
      .query(`SELECT 1 FROM prospects p WHERE p.id = ? AND NOT (${contactAllowedClause(db)})`)
      .get(prospectId) != null
  );
}
