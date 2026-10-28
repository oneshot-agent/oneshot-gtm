import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AllowEntry,
  formatFindings,
  grams,
  isAllowed,
  scanRepo,
  scanText,
  sha256,
} from "./public-content.lib.ts";

const root = resolve(import.meta.dirname, "../..");
const here = (f: string) => resolve(import.meta.dirname, f);
const hashes = JSON.parse(readFileSync(here("identity-hashes.json"), "utf8")) as {
  identity: string[];
  emailLocal: string[];
};
const allow = (
  JSON.parse(readFileSync(here("public-content.allow.json"), "utf8")) as { entries: AllowEntry[] }
).entries;
const opts = {
  identityHashes: new Set(hashes.identity),
  emailLocalHashes: new Set(hashes.emailLocal),
};

// The whole-repo scan reads every tracked text file once; on a loaded CI
// runner that can pass Vitest's 5 s default, so only these two get longer.
const SCAN_TIMEOUT_MS = 60_000;

describe("public content guard", () => {
  let scan: ReturnType<typeof scanRepo> | undefined;
  const scanned = () => (scan ??= scanRepo(root, allow, opts));

  it(
    "finds nothing outside the allowlist in tracked files",
    () => {
      const { findings } = scanned();
      expect(findings, `\n${formatFindings(findings)}\n`).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  it(
    "every allowlist entry still matches something and gives a reason",
    () => {
      const { usedAllow } = scanned();
      const stale = allow.filter((_, i) => !usedAllow.has(i));
      expect(stale, "stale allowlist entries").toEqual([]);
      for (const a of allow) expect(a.reason.length, a.file).toBeGreaterThan(10);
    },
    SCAN_TIMEOUT_MS,
  );

  it("the identity hash lists are well-formed", () => {
    for (const h of [...hashes.identity, ...hashes.emailLocal]) {
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set(hashes.identity).size).toBe(hashes.identity.length);
    expect(hashes.identity.length).toBeGreaterThanOrEqual(11);
  });
});

describe("the scanner itself", () => {
  const rules = (file: string, line: string, o = opts) =>
    scanText(file, line, o).map((f) => f.rule);

  it("flags a real-looking mailbox in a test", () => {
    expect(rules("packages/x/__tests__/a.test.ts", 'from: "jo@realstartup.ai"')).toContain(
      "email-domain",
    );
  });

  it("flags a hashed mailbox local part on any domain", () => {
    const local = "zq-planted-local";
    const o = { ...opts, emailLocalHashes: new Set([sha256(local)]) };
    expect(rules("docs/a.md", `${local}@acme.example`, o)).toEqual(["identity-email"]);
  });

  it("flags a workspace name outside the neutral set", () => {
    expect(rules("docs/a.md", "oneshot-gtm --workspace sdk doctor")).toEqual(["workspace-name"]);
    expect(rules("docs/a.md", "~/.oneshot-gtm-workspaces/gtm/config.json")).toEqual([
      "workspace-name",
    ]);
    expect(rules("apps/x/src/a.ts", 'run(["--workspace", "sales"])')).toEqual(["workspace-name"]);
    expect(rules("docs/a.md", "ONESHOT_GTM_WORKSPACE=sdk-enterprise bun run ui")).toEqual([
      "workspace-name",
    ]);
  });

  it("flags a dashboard port above the base", () => {
    expect(rules("docs/a.md", "open http://localhost:3032/queue")).toEqual(["port"]);
    expect(rules("apps/x/__tests__/a.test.ts", "{ port: 3031 }")).toEqual(["port"]);
    expect(rules("docs/a.md", "bun run ui --port 3099")).toEqual(["port"]);
    // Fixture ports outside the registry's range are the sanctioned stand-in.
    expect(rules("apps/x/__tests__/a.test.ts", "{ port: 4031 }")).toEqual([]);
    expect(rules("docs/a.md", "http://localhost:3030/queue")).toEqual([]);
  });

  it("flags a OneShot host that is not the docs or telemetry host", () => {
    expect(
      rules("packages/x/__tests__/a.test.ts", "see https://docs.oneshotagent.com.evil.example/x"),
    ).toEqual(["oneshot-host"]);
    expect(rules("packages/x/__tests__/a.test.ts", 'sendingDomain: "oneshotagents.com"')).toEqual([
      "oneshot-host",
    ]);
  });

  it("flags pitch phrases and provenance markers in fixtures", () => {
    expect(rules("examples/a.json", '"yourEdge": "one single SDK for everything"')).toEqual([
      "pitch-phrase",
    ]);
    expect(
      rules("packages/x/__tests__/a.test.ts", "// copied verbatim from the live queue"),
    ).toEqual(["provenance"]);
  });

  it("flags a hashed identity token and a hashed two-word phrase", () => {
    const o = { ...opts, identityHashes: new Set([sha256("zqplanted"), sha256("zq planted")]) };
    expect(rules("docs/a.md", "Written by ZqPlanted.", o)).toEqual(["identity"]);
    expect(rules("docs/a.md", "zq-planted said so", o)).toEqual(["identity"]);
  });

  it("passes clean neutral lines", () => {
    for (const line of [
      'email: "mira@tracepoint.email"',
      'email: "sam@beacon.example", website: "https://beacon.example"',
      "a@x.dev and ops@city.gov and jane@gmail.com",
      "oneshot-gtm --workspace acme doctor",
      "runs without --workspace use it",
      "~/.oneshot-gtm-workspaces/<name>/config.json",
      "the dashboard listens on http://localhost:3030",
      "see https://docs.oneshotagent.com/pricing",
      "the docs live at docs.oneshotagent.com.",
      "import { z } from 'zod@3.23.8'",
    ]) {
      expect(rules("packages/x/__tests__/a.test.ts", line), line).toEqual([]);
    }
  });

  it("tokenises into single words and adjacent pairs", () => {
    expect(grams("Hi, Mira-Chen!")).toEqual(["hi", "mira", "chen", "hi mira", "mira chen"]);
  });

  it("the demo exception covers its listed domains and nothing else", () => {
    const demo = "apps/cli/src/demo/dataset.ts";
    const allowed = (line: string) =>
      scanText(demo, line, opts).every((f) => isAllowed(f, allow, line));
    expect(allowed('email: "ida@fenwick.sh"')).toBe(true);
    expect(allowed('email: "ops@realstartup.ai"')).toBe(false);
  });

  it("applies an allowlist entry only to its file, rule and line", () => {
    const [f] = scanText("README.md", "write to hello@realcorp.io");
    const entry: AllowEntry = {
      file: "README.md",
      rule: "email-domain",
      line: "hello@realcorp.io",
      reason: "a test entry",
    };
    expect(isAllowed(f!, [entry], "write to hello@realcorp.io")).toBe(true);
    expect(isAllowed({ ...f!, file: "docs/a.md" }, [entry], "write to hello@realcorp.io")).toBe(
      false,
    );
    expect(isAllowed({ ...f!, rule: "port" }, [entry], "write to hello@realcorp.io")).toBe(false);
  });
});
