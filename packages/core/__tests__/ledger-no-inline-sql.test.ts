/**
 * Architecture guard (issue #751): `ledger.ts` is the compatibility facade
 * over the domain stores extracted to `ledger-*.ts` (receipts, cache,
 * delivery-health, inbox, queue, cadence, prospects, direct-mail, runs,
 * triggers, meetings, outcomes, sending, spend, markers, admin, system).
 * No domain-specific SQL statement or transaction body should live inline
 * in `ledger.ts` again: every read/write belongs in the store that owns its
 * table. `ledger.ts` itself needs zero direct SQL after the extraction
 * (round-1 correction confirmed even the shared-identity resolution moved
 * out to `ledger-prospects.ts`): the only `this.db` surface it still calls
 * is the generic `transaction()` escape hatch and `close()`.
 *
 * Two independent checks, deliberately overlapping:
 *
 * 1. `noRawDbCalls` is structural, not text-pattern-based: it bans calling
 *    `.query(`/`.prepare(`/`.exec(`/`.run(` on `this.db` (or a destructured
 *    alias of it) at all, regardless of whether the SQL is a literal, a
 *    variable, a concatenation, a CTE, `REPLACE INTO`, `PRAGMA`, or
 *    lower-cased keywords. Round-1 review found the prior version of this
 *    file only ran a keyword regex, which is exactly the class of gap a
 *    structural "is this API even called" check can't have: it doesn't
 *    look at the SQL text at all, so there is nothing for a differently-cased
 *    or differently-shaped statement to slip past.
 * 2. `noSqlKeywordsInLiterals` is the original keyword scan, kept as
 *    defense-in-depth against a hypothetical destructured `{ query } =
 *    getDb()` or similar indirection that `noRawDbCalls` wouldn't name-match.
 *    Broadened per the round-1 finding: case-insensitive (was
 *    uppercase-only, so a reintroduced `select`/`update ... set` slipped
 *    through), and covers `WITH ... AS (` (CTE), `REPLACE INTO` /
 *    `INSERT OR REPLACE`, and `PRAGMA` (no longer exempt: `ledger.ts` has
 *    zero legitimate PRAGMA calls post-extraction, so there is nothing left
 *    to carve an exception for; the pre-round-1 exemption comment referred
 *    to `ledger-admin.ts`, a different file, and never applied here).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LEDGER_PATH = join(import.meta.dirname, "../src/ledger.ts");

/**
 * Matches a SQL statement keyword or CTE opener anywhere in a line,
 * case-insensitive. `SELECT`/`INSERT`/`UPDATE ... SET`/`DELETE FROM`/
 * `CREATE TABLE` as before, plus `WITH <name> AS (` (CTE), `REPLACE INTO`,
 * `INSERT OR REPLACE`, and `PRAGMA <word>`.
 */
const SQL_VERB =
  /\b(SELECT\s|INSERT\s+(?:INTO\b|OR\s+REPLACE\b)|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|CREATE\s+TABLE\b|REPLACE\s+INTO\b|WITH\s+\w+\s+AS\s*\(|PRAGMA\s+\w)/i;

/**
 * `this.db.query(...)`, `.prepare(...)`, `.exec(...)`, or `.run(...)` — the
 * four bun:sqlite entry points that execute SQL text. Also matches a
 * destructured local alias (`const { query, prepare, exec, run } = this.db`)
 * used the same way, since that is the obvious way to dodge a `this.db.`
 * prefix check while keeping the exact same capability.
 */
const RAW_DB_CALL = /\bthis\.db\s*\.\s*(query|prepare|exec|run)\s*\(/;

describe("ledger.ts has no inline SQL (issue #751)", () => {
  it("never calls this.db.query/prepare/exec/run directly (structural, content-agnostic)", () => {
    const source = readFileSync(LEDGER_PATH, "utf8");
    const offendingLines = source
      .split("\n")
      .map((line, i) => ({ line, num: i + 1 }))
      .filter(({ line }) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return false;
        return RAW_DB_CALL.test(line);
      });
    expect(
      offendingLines,
      `ledger.ts must not call this.db.query/prepare/exec/run directly, ` +
        `no matter what argument shape (literal, variable, CTE, PRAGMA, any case): ` +
        `move the call into the owning ledger-*.ts store. Offending lines:\n` +
        offendingLines.map((o) => `  ${o.num}: ${o.line.trim()}`).join("\n"),
    ).toEqual([]);
  });

  it("contains no SQL statement keywords outside comments (case-insensitive, CTE/REPLACE/PRAGMA included)", () => {
    const source = readFileSync(LEDGER_PATH, "utf8");
    const offendingLines = source
      .split("\n")
      .map((line, i) => ({ line, num: i + 1 }))
      .filter(({ line }) => {
        const trimmed = line.trim();
        // Doc comments are allowed to mention SQL verbs in prose (e.g.
        // "SELECT + UPDATE in one transaction"); only a real statement,
        // which appears inside a backtick/quote literal, is disallowed.
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return false;
        return SQL_VERB.test(line) && /[`"']/.test(line);
      });
    expect(
      offendingLines,
      `ledger.ts must not contain inline SQL; move it to the owning ledger-*.ts store. ` +
        `Offending lines:\n${offendingLines.map((o) => `  ${o.num}: ${o.line.trim()}`).join("\n")}`,
    ).toEqual([]);
  });

  it("SQL_VERB catches lowercase, CTE, REPLACE INTO, and PRAGMA reintroductions (regex self-test)", () => {
    for (const sample of [
      'this.db.query("select * from prospects").get();',
      'this.db.query("update prospects set name=? where id=?").run(name, id);',
      "const q = `WITH ranked AS (SELECT 1) SELECT * FROM ranked`;",
      'this.db.exec("REPLACE INTO prospects(id) VALUES (1)");',
      'this.db.exec("INSERT OR REPLACE INTO prospects(id) VALUES (1)");',
      'this.db.query("PRAGMA table_info(prospects)").all();',
    ])
      expect(SQL_VERB.test(sample), `expected SQL_VERB to match: ${sample}`).toBe(true);
  });

  it("RAW_DB_CALL catches this.db.query/prepare/exec/run regardless of argument shape", () => {
    for (const sample of [
      "this.db.query(sql).run(...args);",
      "this.db.prepare(buildStatement()).run();",
      'this.db.exec("PRAGMA optimize");',
      "this.db.run(someVariable);",
    ])
      expect(RAW_DB_CALL.test(sample), `expected RAW_DB_CALL to match: ${sample}`).toBe(true);
  });
});
