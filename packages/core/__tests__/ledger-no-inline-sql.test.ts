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
 * 1. `findRawDbCalls` is AST-based (via the TypeScript compiler API), not
 *    text-pattern-based: it resolves every local alias of `this.db` —
 *    `const db = this.db`, chained aliases (`const raw = db; raw.query(...)`),
 *    and destructured method aliases (`const { query } = this.db`, including
 *    renames like `const { query: q } = this.db`) — and flags a call to
 *    `.query(`/`.prepare(`/`.exec(`/`.run(` through ANY of them, regardless
 *    of what the SQL argument looks like (literal, variable, concatenation,
 *    CTE, `REPLACE INTO`, `PRAGMA`, any case). Round-2 review found the
 *    prior version of this check was a `this\.db\.` text-prefix regex, so it
 *    only caught the literal spelling `this.db.query(...)` and missed SQL
 *    executed through an aliased handle (`const db = this.db; db.query(x)`)
 *    or a destructured method reference (`const { query } = this.db;
 *    query(x)`) entirely — exactly the gap an alias-resolving AST walk
 *    closes, because it does not care what name the call site uses, only
 *    whether that name provably traces back to `this.db`.
 * 2. `noSqlKeywordsInLiterals` is the original keyword scan, kept as
 *    defense-in-depth against any indirection the AST walk doesn't name
 *    (e.g. SQL text assembled from an import rather than a local alias).
 *    Case-insensitive, and covers `WITH ... AS (` (CTE), `REPLACE INTO` /
 *    `INSERT OR REPLACE`, and `PRAGMA` (no longer exempt: `ledger.ts` has
 *    zero legitimate PRAGMA calls post-extraction, so there is nothing left
 *    to carve an exception for).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const LEDGER_PATH = join(import.meta.dirname, "../src/ledger.ts");

/**
 * Matches a SQL statement keyword or CTE opener anywhere in a line,
 * case-insensitive. `SELECT`/`INSERT`/`UPDATE ... SET`/`DELETE FROM`/
 * `CREATE TABLE` as before, plus `WITH <name> AS (` (CTE), `REPLACE INTO`,
 * `INSERT OR REPLACE`, and `PRAGMA <word>`.
 */
const SQL_VERB =
  /\b(SELECT\s|INSERT\s+(?:INTO\b|OR\s+REPLACE\b)|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|CREATE\s+TABLE\b|REPLACE\s+INTO\b|WITH\s+\w+\s+AS\s*\(|PRAGMA\s+\w)/i;

/** The four bun:sqlite entry points that execute SQL text. */
const DB_EXEC_METHODS = new Set(["query", "prepare", "exec", "run"]);

interface RawDbCallSite {
  line: number;
  text: string;
}

/**
 * Parses `source` and returns every call site that executes SQL through
 * `this.db` (or any local alias / destructured method reference of it),
 * regardless of the argument shape. This is a real alias analysis, not a
 * text match on the spelling `this.db.`: it resolves
 *
 *   const db = this.db;                    // direct alias
 *   const raw = db;                        // chained alias
 *   const { query } = this.db;             // destructured method alias
 *   const { query: q } = this.db;          // renamed destructured alias
 *
 * and flags `db.query(...)`, `raw.exec(...)`, `query(...)`, `q.run(...)`-
 * style calls made through any of them.
 */
function findRawDbCalls(source: string): RawDbCallSite[] {
  const sourceFile = ts.createSourceFile(
    "ledger.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  // Identifiers that are provably local aliases of the `this.db` object
  // itself (so `<alias>.query(...)` is equivalent to `this.db.query(...)`).
  const dbObjectAliases = new Set<string>();
  // Identifiers that are provably a destructured reference to one of
  // `this.db`'s exec methods (so calling the bare identifier is equivalent
  // to calling `this.db.<method>(...)`). Maps local name -> method name.
  const dbMethodAliases = new Map<string, string>();

  const isThisDb = (node: ts.Node): boolean =>
    ts.isPropertyAccessExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ThisKeyword &&
    node.name.text === "db";

  const isKnownDbAlias = (node: ts.Node): boolean =>
    isThisDb(node) || (ts.isIdentifier(node) && dbObjectAliases.has(node.text));

  // Fixed-point iteration over all variable declarations so declaration
  // order (including chained aliases declared before or after each other
  // in ways a single top-down pass could miss) can't hide an alias.
  const declarations: ts.VariableDeclaration[] = [];
  const visitForDecls = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, visitForDecls);
  };
  visitForDecls(sourceFile);

  let changed = true;
  let guard = 0;
  while (changed && guard < declarations.length + 5) {
    changed = false;
    guard++;
    for (const decl of declarations) {
      if (!decl.initializer) continue;
      // const alias = this.db;  OR  const alias = <known alias>;
      if (ts.isIdentifier(decl.name) && isKnownDbAlias(decl.initializer)) {
        if (!dbObjectAliases.has(decl.name.text)) {
          dbObjectAliases.add(decl.name.text);
          changed = true;
        }
      }
      // const { query, prepare: p, ... } = this.db;  OR  = <known alias>;
      if (ts.isObjectBindingPattern(decl.name) && isKnownDbAlias(decl.initializer)) {
        for (const element of decl.name.elements) {
          if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
          const sourceMethodName = element.propertyName
            ? ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : undefined
            : element.name.text;
          if (sourceMethodName && DB_EXEC_METHODS.has(sourceMethodName)) {
            const local = element.name.text;
            if (dbMethodAliases.get(local) !== sourceMethodName) {
              dbMethodAliases.set(local, sourceMethodName);
              changed = true;
            }
          }
        }
      }
    }
  }

  const offenses: RawDbCallSite[] = [];
  const lines = source.split("\n");
  const recordOffense = (node: ts.Node) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    offenses.push({ line: line + 1, text: (lines[line] ?? "").trim() });
  };

  const visitForCalls = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const receiver = callee.expression;
        const method = callee.name.text;
        if (
          DB_EXEC_METHODS.has(method) &&
          (isThisDb(receiver) || (ts.isIdentifier(receiver) && dbObjectAliases.has(receiver.text)))
        ) {
          recordOffense(node);
        }
      } else if (ts.isIdentifier(callee) && dbMethodAliases.has(callee.text)) {
        recordOffense(node);
      }
    }
    ts.forEachChild(node, visitForCalls);
  };
  visitForCalls(sourceFile);

  return offenses;
}

describe("ledger.ts has no inline SQL (issue #751)", () => {
  it("never executes SQL via this.db (or any alias of it) directly (structural, alias-resolving)", () => {
    const source = readFileSync(LEDGER_PATH, "utf8");
    const offendingLines = findRawDbCalls(source);
    expect(
      offendingLines,
      `ledger.ts must not execute SQL via this.db.query/prepare/exec/run, ` +
        `whether called directly, through a local alias, or through a destructured ` +
        `method reference, no matter what argument shape (literal, variable, CTE, ` +
        `PRAGMA, any case): move the call into the owning ledger-*.ts store. ` +
        `Offending lines:\n` +
        offendingLines.map((o) => `  ${o.line}: ${o.text}`).join("\n"),
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

  it("findRawDbCalls catches direct this.db calls regardless of argument shape (AST self-test)", () => {
    const source = `
      class Ledger {
        run() {
          this.db.query(sql).run(...args);
          this.db.prepare(buildStatement()).run();
          this.db.exec("PRAGMA optimize");
          this.db.run(someVariable);
        }
      }
    `;
    expect(findRawDbCalls(source).length).toBe(4);
  });

  it("findRawDbCalls catches SQL executed through an aliased db handle (AST self-test)", () => {
    const source = `
      class Ledger {
        run() {
          const db = this.db;
          db.query(dynamicallyComposedSql).run();
        }
      }
    `;
    expect(findRawDbCalls(source).length).toBe(1);
  });

  it("findRawDbCalls catches SQL executed through a chained alias of the db handle (AST self-test)", () => {
    const source = `
      class Ledger {
        run() {
          const raw = this.db;
          const handle = raw;
          handle.exec(\`REPLACE INTO prospects(id) VALUES (\${id})\`);
        }
      }
    `;
    expect(findRawDbCalls(source).length).toBe(1);
  });

  it("findRawDbCalls catches SQL executed through a destructured method alias, including renames (AST self-test)", () => {
    const source = `
      class Ledger {
        run() {
          const { query, exec: rawExec } = this.db;
          query(dynamicSql);
          rawExec(buildStatement());
        }
      }
    `;
    expect(findRawDbCalls(source).length).toBe(2);
  });

  it("findRawDbCalls does not flag the allowed this.db.transaction/close escape hatches (AST self-test)", () => {
    const source = `
      class Ledger {
        run(fn: () => void) {
          const db = this.db;
          return db.transaction(fn)();
        }
        close() {
          this.db.close();
        }
      }
    `;
    expect(findRawDbCalls(source)).toEqual([]);
  });

  it("findRawDbCalls does not flag unrelated variables named like db methods (AST self-test)", () => {
    const source = `
      class Ledger {
        run() {
          const query = buildQueryObject();
          query.run();
        }
      }
    `;
    expect(findRawDbCalls(source)).toEqual([]);
  });
});
