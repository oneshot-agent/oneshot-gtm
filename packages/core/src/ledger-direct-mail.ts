import type { Database } from "bun:sqlite";
import type { DirectMailDraft, PostalAddress } from "./direct-mail.ts";

/**
 * Direct-mail persistence over a raw Database handle: mailpiece drafts
 * (`direct_mail_drafts`), the shared postal-address book keyed by an
 * arbitrary string (`direct_mail_addresses`, also used by non-mail callers
 * such as `setQueueProspectId`'s best-effort seeding), per-address metadata
 * (`mail_address_metadata`), per-step mail preparations
 * (`mail_preparations`), and the receipt-id ↔ local-receipt-id join used to
 * make a mail-order webhook idempotent (`direct_mail_receipts`). Extracted
 * from `Ledger` (issue #751); `Ledger` delegates every method here unchanged.
 *
 * `recordMailReceipt` needs to mint a new receipt row on a cache miss, which
 * lives in `ledger-receipts.ts`'s `ReceiptStore`; rather than import that
 * store (and risk a cycle), the caller passes a `recordReceipt` callback,
 * mirroring the pattern `ProspectStore` already uses for its mail-address
 * accessors.
 */

export function getDirectMail(db: Database, id: string): DirectMailDraft | null {
  const row = db.query("SELECT data FROM direct_mail_drafts WHERE id=?").get(id) as {
    data: string;
  } | null;
  return row ? JSON.parse(row.data) : null;
}

export function listDirectMail(db: Database): DirectMailDraft[] {
  return (
    db.query("SELECT data FROM direct_mail_drafts ORDER BY rowid DESC").all() as {
      data: string;
    }[]
  ).map((r) => JSON.parse(r.data));
}

export function findDirectMail(
  db: Database,
  prospect: number,
  play: string,
  enrollment: string,
  step: number,
): DirectMailDraft | null {
  const row = db
    .query(
      "SELECT data FROM direct_mail_drafts WHERE prospect_id=? AND play_name=? AND enrollment=? AND step_index=?",
    )
    .get(prospect, play, enrollment, step) as { data: string } | null;
  return row ? JSON.parse(row.data) : null;
}

export function saveDirectMail(db: Database, draft: DirectMailDraft): void {
  db.transaction(() => {
    const previous = getDirectMail(db, draft.id);
    if (previous && previous.revision !== draft.revision)
      throw new Error("Mailpiece changed; refresh before retrying");
    const next = { ...draft, revision: (draft.revision ?? 0) + 1 };
    db.query(
      "INSERT INTO direct_mail_drafts(id,prospect_id,play_name,enrollment,step_index,data) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
    ).run(
      next.id,
      next.prospectId,
      next.playName,
      next.enrollment,
      next.stepIndex,
      JSON.stringify(next),
    );
    draft.revision = next.revision;
  }).immediate();
}

export function deleteDirectMail(db: Database, id: string): void {
  db.query(
    "DELETE FROM direct_mail_drafts WHERE id=? AND coalesce(json_extract(data,'$.started'),0)=0",
  ).run(id);
}

export function getMailPreparation(
  db: Database,
  prospectId: number,
  playName: string,
  enrollment: string,
  stepIndex: number,
): import("./direct-mail.ts").MailPreparation | null {
  const row = db
    .query(
      "SELECT data FROM mail_preparations WHERE prospect_id=? AND play_name=? AND enrollment=? AND step_index=?",
    )
    .get(prospectId, playName, enrollment, stepIndex) as { data: string } | null;
  return row ? JSON.parse(row.data) : null;
}

export function saveMailPreparation(
  db: Database,
  prospectId: number,
  playName: string,
  enrollment: string,
  stepIndex: number,
  data: import("./direct-mail.ts").MailPreparation,
): void {
  db.query(
    "INSERT INTO mail_preparations VALUES(?,?,?,?,?) ON CONFLICT(prospect_id,play_name,enrollment,step_index) DO UPDATE SET data=excluded.data",
  ).run(prospectId, playName, enrollment, stepIndex, JSON.stringify(data));
}

export function deleteMailPreparation(
  db: Database,
  prospectId: number,
  playName: string,
  enrollment: string,
  stepIndex: number,
): void {
  db.query(
    "DELETE FROM mail_preparations WHERE prospect_id=? AND play_name=? AND enrollment=? AND step_index=?",
  ).run(prospectId, playName, enrollment, stepIndex);
}

export function setMailAddresses(
  db: Database,
  prospect: number,
  to: PostalAddress,
  from: PostalAddress,
): void {
  const put = db.query(
    "INSERT INTO direct_mail_addresses(key,address) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET address=excluded.address",
  );
  db.transaction(() => {
    put.run(`prospect:${prospect}`, JSON.stringify(to));
    put.run("return", JSON.stringify(from));
  }).immediate();
}

export function getMailAddress(db: Database, key: string): PostalAddress | null {
  const row = db.query("SELECT address FROM direct_mail_addresses WHERE key=?").get(key) as {
    address: string;
  } | null;
  return row ? JSON.parse(row.address) : null;
}

export function setMailAddress(
  db: Database,
  key: string,
  address: PostalAddress,
  source = "manual",
): void {
  db.transaction(() => {
    db.query(
      "INSERT INTO direct_mail_addresses VALUES (?,?) ON CONFLICT(key) DO UPDATE SET address=excluded.address",
    ).run(key, JSON.stringify(address));
    setMailAddressMetadata(db, key, { source, collectedAt: new Date().toISOString() });
  }).immediate();
}

export function setMailAddressMetadata(
  db: Database,
  key: string,
  data: Record<string, unknown>,
): void {
  db.query(
    "INSERT INTO mail_address_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
  ).run(key, JSON.stringify(data));
}

export function getMailAddressMetadata(db: Database, key: string): Record<string, unknown> | null {
  const row = db.query("SELECT data FROM mail_address_metadata WHERE key=?").get(key) as {
    data: string;
  } | null;
  return row ? JSON.parse(row.data) : null;
}

export function recordMailReceipt(
  db: Database,
  receipt: string,
  input: { signedReceipt?: unknown },
  recordReceipt: (input: never) => number,
): number {
  return db
    .transaction(() => {
      const previous = db
        .query("SELECT local_id FROM direct_mail_receipts WHERE receipt_id=?")
        .get(receipt) as { local_id: number } | null;
      if (previous) {
        if (input.signedReceipt)
          db.query("UPDATE receipts SET signed_receipt=? WHERE id=?").run(
            JSON.stringify(input.signedReceipt),
            previous.local_id,
          );
        return previous.local_id;
      }
      const id = recordReceipt(input as never);
      db.query("INSERT INTO direct_mail_receipts(receipt_id,local_id) VALUES (?,?)").run(
        receipt,
        id,
      );
      return id;
    })
    .immediate();
}
