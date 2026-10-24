import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { PAID_ACTIONS, PAID_LOOKUPS } from "../src/paid-cache.ts";

// The guard that keeps every paid lookup behind the one paid cache. A new
// paid wrapper fails here until someone decides whether it is a lookup (and
// wires it through withPaidCache) or an action; a new file that keeps its own
// copy of a paid result fails until it is routed through the paid cache or
// listed below with the reason it is not a paid result.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__" || name === "dist") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
    }
  };
  for (const group of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(ROOT, group))) {
      const src = join(ROOT, group, pkg, "src");
      try {
        if (statSync(src).isDirectory()) walk(src);
      } catch {
        // a package without src
      }
    }
  }
  return out.map((p) => relative(ROOT, p));
}

/** Every call type a paid wrapper records a receipt under. */
function recordedCallTypes(): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of read("packages/core/src/oneshot.ts").matchAll(/callType: "([a-z_.]+)"/g))
    found.set(m[1]!, "packages/core/src/oneshot.ts");
  for (const m of read("packages/core/src/linkedin-sdk.ts").matchAll(
    /record\(\s*result,\s*"([a-z_.]+)"/g,
  ))
    found.set(m[1]!, "packages/core/src/linkedin-sdk.ts");
  return found;
}

/**
 * Files that still use the ledger's own cache tables, and why what they keep
 * is not a raw paid result. Anything new here needs the same justification.
 */
const NOT_PAID_RESULTS: Record<string, string> = {
  "packages/core/src/ledger.ts": "the Ledger's delegating accessors",
  "packages/core/src/ledger-cache.ts": "the storage behind those accessors",
  "packages/core/src/shared-db.ts": "the shared tables themselves",
  "packages/doctor/src/check.ts": "the wallet balance, a free chain read",
  "packages/find/src/_linkedin-profile.ts":
    "the cross-process read spacing lease and the counter for charged reads that came back incomplete",
  "packages/find/src/_linkedin.ts":
    "name-to-profile-URL resolution: a match judged over search results, not one result",
  "packages/find/src/_product-research.ts":
    "the product dossier: several lookups combined by an LLM",
  "packages/find/src/_signal-verify.ts": "an LLM's verdict on a signal",
  "packages/find/src/list-page.ts":
    "an LLM's extraction of a listing page, and the no-title-match marker per company",
  "packages/find/src/local-business.ts": "how far each search has been read (a progress marker)",
  "packages/plays/src/_angles.ts": "the angle an LLM picked",
  "packages/plays/src/_linkedin-evidence.ts": "the job id of a view still running (progress)",
};

const CACHE_METHOD =
  /\.(?:getCachedEnrichment|setCachedEnrichment|setCachedEnrichmentFailure|countCachedEnrichmentSince|getProductResearchCache|setProductResearchCache|getCachedLinkedIn|setCachedLinkedIn)\(/;

describe("paid-call coverage", () => {
  it("every recorded call type is exactly one of a lookup or an action", () => {
    const lookups = new Set(Object.keys(PAID_LOOKUPS));
    const actions = new Set<string>(PAID_ACTIONS);
    const recorded = recordedCallTypes();
    expect(recorded.size).toBeGreaterThan(10);
    for (const callType of recorded.keys()) {
      const where = Number(lookups.has(callType)) + Number(actions.has(callType));
      expect(where, `${callType} must be in exactly one of PAID_LOOKUPS / PAID_ACTIONS`).toBe(1);
    }
    for (const callType of actions) {
      expect(lookups.has(callType), `${callType} cannot be both`).toBe(false);
    }
  });

  it("every lookup is bought through withPaidCache, at its wrapper where the wrapper answers it", () => {
    const files = sourceFiles();
    const wired = new Map<string, string[]>();
    for (const file of files) {
      for (const m of read(file).matchAll(/withPaidCache(?:<[^>]*>)?\(\s*"([a-z_.]+)"/g)) {
        wired.set(m[1]!, [...(wired.get(m[1]!) ?? []), file]);
      }
    }
    const recorded = recordedCallTypes();
    for (const callType of Object.keys(PAID_LOOKUPS)) {
      expect(wired.get(callType), `${callType} is never bought through withPaidCache`).toBeTruthy();
      if (recorded.get(callType) === "packages/core/src/oneshot.ts") {
        expect(wired.get(callType), `${callType}: wire it inside its oneshot.ts wrapper`).toContain(
          "packages/core/src/oneshot.ts",
        );
      }
    }
  });

  it("no file outside the paid cache keeps its own copy of a paid result", () => {
    const users = sourceFiles().filter((file) => CACHE_METHOD.test(read(file)));
    for (const file of users) {
      expect(
        NOT_PAID_RESULTS[file],
        `${file} caches through the ledger: route a paid result through the paid cache, or list why this is not one`,
      ).toBeTruthy();
    }
    // The prefixes the old per-site caches filed paid results under.
    const oldKeys = /["'`](?:person:|newsfeed:|webread:|linkedin-view:|company:\$\{current)/;
    for (const file of users) {
      if (file.startsWith("packages/core/src/")) continue;
      expect(oldKeys.test(read(file)), `${file} writes under an old paid-result key`).toBe(false);
    }
    // And no raw wrapper result is serialised straight into a ledger cache.
    for (const file of users) {
      expect(
        /set(?:CachedEnrichment|ProductResearchCache)\([^)]*JSON\.stringify\((?:out|enr|enriched|res|read|result)\.result\)/.test(
          read(file),
        ),
        `${file} stores a wrapper's raw result in a ledger cache`,
      ).toBe(false);
    }
  });
});
