#!/usr/bin/env bun
/**
 * Regenerate STATUS.md's date, versions, and test counts with `bun run status:stamp`.
 * Preserve the hand-maintained check summary and remaining content.
 * Run on main to avoid count conflicts between branches. A failing suite prevents
 * stamping; unchanged results leave the file untouched.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const STATUS_PATH = join(REPO_ROOT, "STATUS.md");

// Captures everything after "**N tests / M files** · " up to the trailing
// period, e.g. "typecheck + oxlint + oxfmt pass (38 lint warnings, 0 errors)."
const STAMP_LINE =
  /^Last verified \*\*[^*]+\*\* · Bun \S+ · OneShot SDK \S+ · \*\*[\d,]+ tests \/ [\d,]+ files\*\* · (.+)$/m;

function run(cmd: string[]): string {
  return execFileSync(cmd[0]!, cmd.slice(1), { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

interface VitestJsonReport {
  numTotalTests: number;
  numFailedTests: number;
  success: boolean;
  testResults: unknown[];
}

function runVitestJson(): VitestJsonReport {
  const reportDir = mkdtempSync(join(tmpdir(), "status-stamp-"));
  const reportPath = join(reportDir, "vitest-report.json");
  try {
    // `--bun` matches CI (ci.yml): bun:sqlite doesn't exist under plain Node.
    run(["bun", "--bun", "run", "test", "--", "--reporter=json", `--outputFile=${reportPath}`]);
  } catch (err) {
    // Vitest can write a report even when it exits non-zero.
    let detail = (err as Error).message;
    try {
      const partial = JSON.parse(readFileSync(reportPath, "utf8")) as VitestJsonReport;
      detail = `${partial.numFailedTests}/${partial.numTotalTests} tests failed`;
    } catch {
      // Use the raw error if Vitest could not write a report.
    }
    rmSync(reportDir, { recursive: true, force: true });
    console.error(`Test suite is red (${detail}). Fix it before stamping STATUS.md.`);
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as VitestJsonReport;
  rmSync(reportDir, { recursive: true, force: true });
  return report;
}

const status = readFileSync(STATUS_PATH, "utf8");
const match = status.match(STAMP_LINE);
if (!match) {
  throw new Error(
    "STATUS.md's verification stamp line no longer matches the expected shape. " +
      "Update STAMP_LINE in scripts/status-stamp.ts alongside the format change.",
  );
}
const trailer = match[1]!;

const report = runVitestJson();
if (!report.success) {
  console.error(
    `Test suite is red (${report.numFailedTests}/${report.numTotalTests} tests failed). ` +
      "Fix it before stamping STATUS.md.",
  );
  process.exit(1);
}
const testCount = report.numTotalTests;
const fileCount = report.testResults.length;

const bunVersion = run(["bun", "--version"]);

const serverPkg = JSON.parse(readFileSync(join(REPO_ROOT, "apps/server/package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};
const sdkVersion = serverPkg.dependencies?.["@oneshot-agent/sdk"];
if (!sdkVersion) {
  throw new Error(
    "apps/server/package.json no longer declares a pinned @oneshot-agent/sdk version. " +
      "Update scripts/status-stamp.ts to read the version from wherever it moved.",
  );
}

const today = new Date().toISOString().slice(0, 10);

const newLine =
  `Last verified **${today}** · Bun ${bunVersion} · OneShot SDK ${sdkVersion} · ` +
  `**${testCount} tests / ${fileCount} files** · ${trailer}`;

const updated = status.replace(STAMP_LINE, newLine);

if (updated === status) {
  console.log(`STATUS.md is already current: ${testCount} tests / ${fileCount} files.`);
} else {
  writeFileSync(STATUS_PATH, updated);
  console.log(
    `Stamped STATUS.md: ${testCount} tests / ${fileCount} files ` +
      `(Bun ${bunVersion}, OneShot SDK ${sdkVersion}, ${today}).`,
  );
}
