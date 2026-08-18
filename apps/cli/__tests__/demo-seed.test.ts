import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scrubInheritedSecrets } from "../src/commands/demo.ts";
import {
  canonicalize,
  DEMO_MARKER,
  DemoSeedError,
  resetDemoHome,
  seedDemoHome,
} from "../src/demo/seed.ts";

const ANCHOR = new Date("2026-08-17T09:00:00.000Z");

let home: string;

beforeEach(() => {
  home = join(mkdtempSync(join(tmpdir(), "oneshot-gtm-demo-test-")), "demo");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function open(dir: string): Database {
  return new Database(join(dir, "ledger.sqlite"), { readonly: true });
}

function rows(db: Database, sql: string): Array<Record<string, unknown>> {
  return db.query(sql).all() as Array<Record<string, unknown>>;
}

function totalSpend(entries: Array<{ spend: number }>): number {
  return entries.reduce((a, r) => a + r.spend, 0);
}

describe("seedDemoHome", () => {
  it("writes config, secrets, fixtures and a marker", () => {
    seedDemoHome({ home, anchor: ANCHOR });

    expect(existsSync(join(home, DEMO_MARKER))).toBe(true);
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(cfg["founderName"]).toBe("Mira Vance");
    expect(cfg["icpOneLiner"]).toBeTruthy();
    expect((cfg["emailIdentities"] as unknown[]).length).toBe(3);
    // Telemetry must be off: a demo install is not a real one and must not
    // report itself as such.
    expect(cfg["telemetryEnabled"]).toBe(false);

    for (const f of ["inbox.json", "rocs-by-goal.json", "domains.json", "balance.json"]) {
      expect(existsSync(join(home, "demo", f))).toBe(true);
    }
  });

  it("chmods the secrets file to 600 and keeps the keys non-functional", () => {
    seedDemoHome({ home, anchor: ANCHOR });
    const env = join(home, ".env");
    expect(statSync(env).mode & 0o777).toBe(0o600);
    const body = readFileSync(env, "utf8");
    expect(body).toMatch(/OPENROUTER_API_KEY=/);
    expect(body).toMatch(/AGENT_PRIVATE_KEY=/);
    expect(body).toMatch(/demo/i);
  });

  it("populates every table the dashboard reads", () => {
    const { counts } = seedDemoHome({ home, anchor: ANCHOR });
    for (const table of [
      "prospects",
      "receipts",
      "sequence_events",
      "cadence_state",
      "deal_outcomes",
      "target_queue",
      "triggers",
      "runs",
      "bounces",
      "canary_results",
    ]) {
      expect(counts[table], `${table} should be seeded`).toBeGreaterThan(0);
    }
  });

  it("covers every cadence status, so each summary tile has a number behind it", () => {
    seedDemoHome({ home, anchor: ANCHOR });
    const db = open(home);
    const statuses = rows(db, "SELECT DISTINCT status FROM cadence_state").map((r) => r["status"]);
    db.close();
    expect(new Set(statuses)).toEqual(
      new Set(["active", "replied", "breakup", "completed", "bounced"]),
    );
  });

  it("covers every queue status the filter chips offer", () => {
    seedDemoHome({ home, anchor: ANCHOR });
    const db = open(home);
    const statuses = rows(db, "SELECT DISTINCT status FROM target_queue").map((r) => r["status"]);
    db.close();
    expect(new Set(statuses)).toEqual(new Set(["pending", "approved", "rejected", "sent"]));
  });

  it("backdates receipts across a 30-day window so the range filters have data", () => {
    seedDemoHome({ home, anchor: ANCHOR });
    const db = open(home);
    const [span] = rows(db, "SELECT MIN(created_at) lo, MAX(created_at) hi FROM receipts");
    const within7d = rows(
      db,
      "SELECT COUNT(*) n FROM receipts WHERE created_at >= '2026-08-10 00:00:00'",
    );
    db.close();
    // Same shape production writes via the datetime('now') column DEFAULT.
    expect(String(span?.["lo"])).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(String(span?.["hi"])).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(Number(within7d[0]?.["n"])).toBeGreaterThan(0);
  });

  it("writes ISO timestamps to the columns the app writes with toISOString()", () => {
    seedDemoHome({ home, anchor: ANCHOR });
    const db = open(home);
    const due = rows(db, "SELECT next_due_at FROM cadence_state WHERE next_due_at IS NOT NULL");
    const polled = rows(db, "SELECT last_polled_at FROM triggers WHERE last_polled_at IS NOT NULL");
    db.close();
    expect(due.length).toBeGreaterThan(0);
    for (const r of [...due, ...polled]) {
      expect(String(Object.values(r)[0])).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    }
  });

  it("value-tags only the receipts belonging to a goal with an outcome", () => {
    seedDemoHome({ home, anchor: ANCHOR });
    const db = open(home);
    const tagged = rows(db, "SELECT COUNT(*) n FROM receipts WHERE value_tag IS NOT NULL");
    const orphan = rows(
      db,
      "SELECT COUNT(*) n FROM receipts WHERE value_tag IS NOT NULL AND goal_id IS NULL",
    );
    db.close();
    expect(Number(tagged[0]?.["n"])).toBeGreaterThan(0);
    expect(Number(orphan[0]?.["n"])).toBe(0);
  });

  it("is deterministic — the same anchor reproduces the same ledger", () => {
    const a = seedDemoHome({ home, anchor: ANCHOR });
    const db1 = open(home);
    const before = JSON.stringify(rows(db1, "SELECT * FROM receipts ORDER BY id"));
    db1.close();

    const b = seedDemoHome({ home, anchor: ANCHOR });
    const db2 = open(home);
    const after = JSON.stringify(rows(db2, "SELECT * FROM receipts ORDER BY id"));
    db2.close();

    expect(after).toBe(before);
    expect(b.counts).toEqual(a.counts);
  });

  it("re-seeds in place without stacking duplicate rows", () => {
    const first = seedDemoHome({ home, anchor: ANCHOR });
    const second = seedDemoHome({ home, anchor: new Date("2026-09-01T09:00:00.000Z") });
    expect(second.counts["prospects"]).toBe(first.counts["prospects"]);

    const db = open(home);
    const n = rows(db, "SELECT COUNT(*) n FROM prospects");
    db.close();
    expect(Number(n[0]?.["n"])).toBe(first.counts["prospects"]);
  });

  it("refuses to seed into the real install", () => {
    const real = join(homedir(), ".oneshot-gtm");
    expect(() => seedDemoHome({ home: real, anchor: ANCHOR })).toThrow(DemoSeedError);
    expect(() => seedDemoHome({ home: real, anchor: ANCHOR })).toThrow(/real install/i);
  });

  it("refuses a SYMLINK to a protected install — lexical path comparison is not enough", () => {
    // ONESHOT_GTM_HOME (the vitest temp home) stands in for a protected
    // install that definitely exists. A symlink to it must be caught by the
    // canonicalized comparison, not slip past a string match.
    const protectedHome = process.env["ONESHOT_GTM_HOME"] as string;
    mkdirSync(home, { recursive: true });
    const link = join(home, "sneaky-link");
    symlinkSync(protectedHome, link);
    expect(() => seedDemoHome({ home: link, anchor: ANCHOR })).toThrow(DemoSeedError);
    expect(() => seedDemoHome({ home: link, anchor: ANCHOR })).toThrow(/ONESHOT_GTM_HOME/);
  });

  it("canonicalize follows symlinked parents of a not-yet-existing path", () => {
    mkdirSync(home, { recursive: true });
    const link = join(home, "parent-link");
    symlinkSync(home, link);
    expect(canonicalize(join(link, "new-dir"))).toBe(join(realpathSync(home), "new-dir"));
  });

  it("keys the RoCS fixture by period so the Measure range chips vary", () => {
    seedDemoHome({ home, anchor: ANCHOR });
    const rocs = JSON.parse(readFileSync(join(home, "demo", "rocs-by-goal.json"), "utf8")) as {
      "7": Array<{ spend: number }>;
      "30": Array<{ spend: number }>;
      all: Array<{ spend: number }>;
    };
    expect(rocs["all"].length).toBeGreaterThan(0);
    // The seeded history spans 30 days, so each narrower window must aggregate
    // strictly less spend — equal totals would mean the filter isn't filtering.
    expect(totalSpend(rocs["7"])).toBeLessThan(totalSpend(rocs["30"]));
    expect(totalSpend(rocs["30"])).toBeLessThanOrEqual(totalSpend(rocs["all"]));
  });

  it("attaches inbox drafts and sent history to the correct prospect's thread", () => {
    seedDemoHome({ home, anchor: ANCHOR });
    const inbox = JSON.parse(readFileSync(join(home, "demo", "inbox.json"), "utf8")) as {
      emails: Array<{ id: string; from: string; thread_id: string }>;
    };
    const threadOwner = new Map(inbox.emails.map((e) => [e.thread_id, e.from]));

    const db = open(home);
    const drafts = rows(db, "SELECT thread_key, to_email FROM inbox_drafts");
    const sent = rows(db, "SELECT thread_key, to_email FROM inbox_sent");
    db.close();

    // Every draft/sent row must live inside the thread of the prospect it
    // addresses — a mismatch shows one person's reply inside another's thread.
    for (const r of [...drafts, ...sent]) {
      const owner = threadOwner.get(String(r["thread_key"]));
      expect(
        owner,
        `thread ${String(r["thread_key"])} should exist in the inbox fixture`,
      ).toBeTruthy();
      expect(owner).toContain(String(r["to_email"]));
    }
  });

  it("links run send events to the recipients' actual email.send receipts", () => {
    seedDemoHome({ home, anchor: ANCHOR });
    const db = open(home);
    const [run] = rows(db, "SELECT events_json, prospect_emails_json FROM runs");
    const events = JSON.parse(String(run?.["events_json"])) as Array<{
      kind: string;
      receiptIds?: number[];
    }>;
    const sendIds = events.filter((e) => e.kind === "send").flatMap((e) => e.receiptIds ?? []);
    expect(sendIds.length).toBeGreaterThan(0);
    const emails = JSON.parse(String(run?.["prospect_emails_json"])) as string[];
    for (const id of sendIds) {
      const [receipt] = rows(db, `SELECT call_type, signed_receipt FROM receipts WHERE id = ${id}`);
      expect(receipt?.["call_type"]).toBe("email.send");
      const to = (JSON.parse(String(receipt?.["signed_receipt"])) as { to?: string }).to;
      expect(emails).toContain(to);
    }
    db.close();
  });

  it("refuses a non-empty directory it did not create, unless forced", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "something-important.txt"), "do not delete me");

    expect(() => seedDemoHome({ home, anchor: ANCHOR })).toThrow(/--force/);
    expect(() => seedDemoHome({ home, anchor: ANCHOR, force: true })).not.toThrow();
    // --force overwrites the install, it doesn't wipe unrelated files.
    expect(existsSync(join(home, "something-important.txt"))).toBe(true);
  });
});

describe("scrubInheritedSecrets", () => {
  // The CLI parent has already run core's applySecretsToEnv() by the time
  // `demo ui` executes, so process.env carries the REAL install's credentials.
  // The child server only fills BLANK vars from the demo .env — an unscrubbed
  // inherited key would shadow the placeholder and hand the "demo" a live
  // wallet. This is the regression test for that leak.
  it("removes every stored secret plus the env-only tokens", () => {
    const env: NodeJS.ProcessEnv = {
      OPENROUTER_API_KEY: "sk-or-real",
      OPENAI_API_KEY: "sk-real",
      ANTHROPIC_API_KEY: "sk-ant-real",
      CDP_API_KEY_ID: "real",
      CDP_API_KEY_SECRET: "real",
      CDP_WALLET_SECRET: "real",
      AGENT_PRIVATE_KEY: "0xreal",
      GMAIL_CLIENT_ID: "real",
      GMAIL_CLIENT_SECRET: "real",
      GMAIL_REFRESH_TOKEN: "real",
      GITHUB_TOKEN: "ghp_real",
      LUMA_SESSION_COOKIE: "real",
    };
    scrubInheritedSecrets(env);
    expect(Object.keys(env)).toEqual([]);
  });

  it("leaves non-secret vars alone", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/Users/someone",
      PORT: "3030",
      ONESHOT_GTM_HOME: "/tmp/x",
      AGENT_PRIVATE_KEY: "0xreal",
    };
    scrubInheritedSecrets(env);
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/someone",
      PORT: "3030",
      ONESHOT_GTM_HOME: "/tmp/x",
    });
  });
});

describe("resetDemoHome", () => {
  it("removes a seeded home", () => {
    seedDemoHome({ home, anchor: ANCHOR });
    resetDemoHome(home);
    expect(existsSync(home)).toBe(false);
  });

  it("refuses a directory without the marker", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "ledger.sqlite"), "not really a ledger");
    expect(() => resetDemoHome(home)).toThrow(DemoSeedError);
    expect(existsSync(home)).toBe(true);
  });

  it("is a no-op on a path that doesn't exist", () => {
    expect(() => resetDemoHome(join(home, "nope"))).not.toThrow();
  });
});
