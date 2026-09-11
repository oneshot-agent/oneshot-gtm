import { afterEach, beforeEach, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import { contactAllowedClause, isProspectOptedOut } from "../src/contact-optout.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE prospects (id INTEGER PRIMARY KEY, email TEXT);
    INSERT INTO prospects VALUES (1, 'person@example.com'), (2, 'other@example.com');
    CREATE TABLE inbox_replies (prospect_id INTEGER, from_email TEXT, kind TEXT);
    CREATE TABLE cadence_state (prospect_id INTEGER, status TEXT);
    CREATE TABLE mailbox_messages (prospect_id INTEGER, direction TEXT, data TEXT);
  `);
});
afterEach(() => db.close());

it("an opt-out vetoes a previous human reply in enrollment selection", () => {
  db.exec(
    `INSERT INTO inbox_replies VALUES (1, 'person@example.com', 'human'), (1, 'alternate@example.com', 'unsubscribe')`,
  );
  expect(isProspectOptedOut(db, 1)).toBe(true);
  expect(db.query(`SELECT p.id FROM prospects p WHERE ${contactAllowedClause(db)}`).all()).toEqual([
    { id: 2 },
  ]);
});

it("matches opt-outs by email when the reply is not yet associated", () => {
  db.exec(`INSERT INTO inbox_replies VALUES (NULL, 'PERSON@example.com', 'unsubscribe')`);
  expect(isProspectOptedOut(db, 1)).toBe(true);
});

it("blocks a synced opt-out before the cadence poll processes it", () => {
  db.query("INSERT INTO mailbox_messages VALUES (1, 'inbound', ?)").run(
    JSON.stringify({ kind: "unsubscribe", from: "alternate@example.com" }),
  );
  expect(isProspectOptedOut(db, 1)).toBe(true);
  expect(isProspectOptedOut(db, 2)).toBe(false);
});

it("retains suppression through the terminal cadence status", () => {
  db.exec(`INSERT INTO cadence_state VALUES (1, 'unsubscribed')`);
  expect(isProspectOptedOut(db, 1)).toBe(true);
});

it("does not interpret ordinary human replies or auto replies as opt-outs", () => {
  db.exec(
    `INSERT INTO inbox_replies VALUES (1, 'person@example.com', 'human'), (1, 'person@example.com', 'auto')`,
  );
  expect(isProspectOptedOut(db, 1)).toBe(false);
});

it("supports older ledgers without reply classification tables", () => {
  db.exec("DROP TABLE inbox_replies; DROP TABLE mailbox_messages; DROP TABLE cadence_state");
  expect(isProspectOptedOut(db, 1)).toBe(false);
});
