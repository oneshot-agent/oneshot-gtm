/**
 * Architecture guard (issue #751): `ledger.ts` is the compatibility facade
 * over the domain stores extracted to `ledger-*.ts` (receipts, cache,
 * delivery-health, inbox, queue, cadence, prospects, direct-mail, runs,
 * triggers, meetings, outcomes, sending, spend, markers, admin, system).
 * No domain-specific SQL statement or transaction body should live inline
 * in `ledger.ts` again: every read/write belongs in the store that owns its
 * table. This scans the source text (not the AST) for SQL verb keywords
 * appearing inside a template-literal or string-literal context, which is
 * the same signal a reviewer would look for.
 *
 * `PRAGMA` statements are exempt: they configure the connection itself
 * (`journal_mode`, `busy_timeout`, `optimize`, `freelist_count`), not a
 * table, and several already live inline in `ledger-admin.ts`'s callers
 * intentionally.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LEDGER_PATH = join(import.meta.dirname, "../src/ledger.ts");

/**
 * Matches a SQL verb keyword as it would appear opening a query string:
 * `SELECT `, `INSERT INTO`, `UPDATE <table> SET`, `DELETE FROM`,
 * `CREATE TABLE`. Case-sensitive uppercase, matching this codebase's own
 * SQL style (every existing store writes SQL keywords in caps).
 */
const SQL_VERB =
  /\b(SELECT\s|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|CREATE\s+TABLE\b)/;

describe("ledger.ts has no inline SQL (issue #751)", () => {
  it("contains no SQL statement keywords outside PRAGMA or comments", () => {
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

  it("never calls a raw db.query/prepare/exec with a literal SQL string", () => {
    const source = readFileSync(LEDGER_PATH, "utf8");
    // `this.db.query(`/prepare(`/exec(` immediately followed by a
    // template-literal or string starting with a SQL verb (allowing
    // PRAGMA) is the pattern every prior inline-SQL method used.
    const inlineCallPattern =
      /this\.db\s*\.\s*(query|prepare|exec)\s*\(\s*[`"'][^`"']*\b(SELECT|INSERT|UPDATE|DELETE FROM|CREATE TABLE)\b/;
    const source_lines = source.split("\n");
    const matches: string[] = [];
    for (let i = 0; i < source_lines.length; i++) {
      const window = source_lines.slice(i, i + 3).join("\n");
      if (inlineCallPattern.test(window)) matches.push(`line ${i + 1}: ${source_lines[i]!.trim()}`);
    }
    expect(matches, `Found direct this.db SQL calls in ledger.ts:\n${matches.join("\n")}`).toEqual(
      [],
    );
  });
});
