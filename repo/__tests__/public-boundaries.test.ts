import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const privatePaths = [
  "launch/draft.md",
  "output/prospects.csv",
  "ops/deploy.ts",
  "sdk/src/client.ts",
  "vendor/oneshot-sdk.tgz",
  ".claude/settings.local.json",
  "CLAUDE.local.md",
  ".env",
  ".oneshot-gtm/config.json",
  ".oneshot-gtm-workspaces/acme/config.json",
  ".oneshot-gtm-shared/shared.sqlite",
  "config.json",
  "gmail-tokens.json",
  "mailbox-connections.json",
  "events.jsonl",
  "events.1.jsonl",
  "ledger.sqlite",
  "ledger.sqlite-wal",
  "examples/prospects.private.json",
];

const forbidden =
  /^(?:launch|output|ops|sdk|vendor|\.claude)\/|(?:^|\/)\.oneshot-gtm(?:-workspaces|-shared|-demo[^/]*)?\/|^(?:CLAUDE\.local\.md|config\.json)$|(?:^|\/)(?:\.env(?:\.(?!example$)[^/]+)?|gmail-tokens\.json|mailbox-connections\.json|events(?:\.\d+)?\.jsonl)$|\.(?:sqlite(?:-wal|-shm|-journal)?|db(?:-journal)?|tgz|private\.json|local\.json)$/;

describe("public repository boundaries", () => {
  it("does not track SDK internals or runtime workspace data", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    expect(tracked.filter((path) => forbidden.test(path))).toEqual([]);
  });

  it("ignores representative private files without relying on global Git ignores", () => {
    const ignored = execFileSync(
      "git",
      ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "--stdin"],
      { cwd: root, input: privatePaths.join("\n") + "\n", encoding: "utf8" },
    )
      .trim()
      .split("\n");
    expect(ignored).toEqual(privatePaths);
  });
});
