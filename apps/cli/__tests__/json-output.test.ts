import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainPoolEntry, EmailIdentity, IdentityCapacityView } from "@oneshot-gtm/core";
import type { FinderResult, TriggerRunOutcome } from "@oneshot-gtm/find";

/**
 * Tests for --json output on read-only commands. #99 shipped doctor,
 * identities list, find drain --dry-run and find watch --once; the
 * domains list + workspace list suites below finish the read-only surface.
 * Verifies:
 * - stdout is parseable JSON with no ANSI codes
 * - schemaVersion exists in all payloads
 * - human/progress output goes to stderr, not stdout
 * - exit codes unchanged (find watch --once still exits 1 on error)
 */

// Local type mirror since CheckResult isn't exported from @oneshot-gtm/doctor
interface CheckResult {
  name: string;
  group: string;
  severity: "ok" | "warn" | "fail";
  message: string;
  hint?: string;
}

// Track what was written to stdout/stderr separately
let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

// Doctor mocks
let doctorResults: CheckResult[] = [];

vi.mock("@oneshot-gtm/doctor", () => ({
  runDoctor: async () => doctorResults,
}));

// Find mocks
let findTriggerOutcomes: TriggerRunOutcome[] = [];
let drainResult = {
  drained: 0,
  sent: 0,
  deferred: 0,
  errors: [] as { id: string; message: string }[],
};
let csvImportResult = {
  imported: 2,
  skipped: 1,
  errors: [{ row: 3, message: "missing or invalid email" }],
  mapping: { email: "Email" },
  rowCount: 3,
};

vi.mock("@oneshot-gtm/find", () => ({
  runDueTriggers: async () => findTriggerOutcomes,
  drainQueue: async () => drainResult,
  nextSleepMs: () => 60_000,
  importCsv: async () => csvImportResult,
}));

// Identities / domains mocks
let identitiesFixture: EmailIdentity[] = [];
let capsFixture = new Map<string, IdentityCapacityView>();
let domainsFixture: DomainPoolEntry[] = [];
let configFixture: { emailIdentities?: EmailIdentity[] | null } = {};
let listDomainsThrows: Error | null = null;

// Workspace mocks
interface WorkspaceEntryLike {
  home: string;
  port: number;
  createdAt: string;
}
let workspaceRowsFixture: Array<[string, WorkspaceEntryLike]> = [];
let workspaceRegistryFixture: { default: string; workspaces: Record<string, WorkspaceEntryLike> } =
  {
    default: "default",
    workspaces: {},
  };
let currentWorkspaceFixture = "default";

vi.mock("@oneshot-gtm/core", () => ({
  loadConfig: () => configFixture,
  resolveIdentities: () => identitiesFixture,
  identityCapacities: () => capsFixture,
  listSendingDomains: async () => {
    if (listDomainsThrows) throw listDomainsThrows;
    return domainsFixture;
  },
  capGroupKey: (i: EmailIdentity) =>
    i.provider === "oneshot" ? `domain:${i.sendingDomain ?? ""}` : `id:${i.id}`,
  fromLocalpart: (s: string) => s.toLowerCase(),
  registerOneShotIdentity: () => ({ identityId: "", created: false }),
  removeIdentity: () => ({ removed: false }),
  pauseSendingDomain: async () => ({ domain: "", pool_status: "paused" }),
  resumeSendingDomain: async () => ({ domain: "", pool_status: "active" }),
  WARMUP_DEFAULTS: { maxPerDay: 40, warmup: { startPerDay: 5, incrementPerWeek: 5 } },
  // Workspace surface consumed by commandWorkspaceList
  loadRegistry: () => workspaceRegistryFixture,
  currentWorkspaceName: () => currentWorkspaceFixture,
  listWorkspaces: () => workspaceRowsFixture,
  configDir: () => "/tmp/oneshot-gtm",
  createWorkspace: () => ({ home: "", port: 0, createdAt: "" }),
  removeWorkspace: () => ({ home: "", port: 0, createdAt: "" }),
  resolveWorkspaceHome: () => "",
  setDefaultWorkspace: () => {},
  WorkspaceError: class WorkspaceError extends Error {},
}));

// Import commands after mocks are set up
const { commandDoctor } = await import("../src/commands/doctor.ts");
const { commandFindWatch, commandFindDrain, commandFindImport } =
  await import("../src/commands/find.ts");
const { commandIdentitiesList, commandDomainsList } = await import("../src/commands/identities.ts");
const { commandWorkspaceList } = await import("../src/commands/workspace.ts");
const { CommandExit } = await import("../src/output.ts");

beforeEach(() => {
  stdoutChunks = [];
  stderrChunks = [];
  listDomainsThrows = null;
  stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(
      (
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
      ) => {
        stdoutChunks.push(String(chunk));
        if (typeof encodingOrCallback === "function") encodingOrCallback();
        else callback?.();
        return true;
      },
    );
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

/** Check if a string contains ANSI escape codes */
function hasAnsiCodes(s: string): boolean {
  return /\x1b\[|\u001b\[/.test(s);
}

describe("doctor --json", () => {
  const PASS: CheckResult = {
    name: "GitHub token",
    group: "Deliverability",
    severity: "ok",
    message: "Valid",
  };
  const WARN: CheckResult = {
    name: "X credentials",
    group: "Deliverability",
    severity: "warn",
    message: "Missing",
    hint: "Set TWITTER_USERNAME and TWITTER_PASSWORD",
  };
  const FAIL: CheckResult = {
    name: "Gmail placement",
    group: "Deliverability",
    severity: "fail",
    message: "No Gmail accounts",
  };

  it("emits valid JSON with schemaVersion on stdout", async () => {
    doctorResults = [PASS];
    await commandDoctor({ json: true });

    const stdout = stdoutChunks.join("");
    expect(stdout.trim()).toBeTruthy();
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("schemaVersion");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.command).toBe("doctor");
    expect(parsed.ok).toBe(true);
    expect(parsed.failed).toBe(0);
    expect(parsed.warned).toBe(0);
    expect(parsed.checks).toHaveLength(1);
  });

  it("stdout has no ANSI codes in --json mode", async () => {
    doctorResults = [PASS, WARN];
    await commandDoctor({ json: true });

    const stdout = stdoutChunks.join("");
    expect(hasAnsiCodes(stdout)).toBe(false);
  });

  it("human output goes to stderr, not stdout", async () => {
    doctorResults = [PASS];
    await commandDoctor({ json: true });

    const stdout = stdoutChunks.join("");
    const stderr = stderrChunks.join("");

    // Stdout should be ONLY the JSON document
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(() => JSON.parse(stdout)).not.toThrow();

    // Human headers/progress should be on stderr
    expect(stderr).toContain("doctor");
  });

  it("exit code unchanged on failure", async () => {
    doctorResults = [FAIL];
    const err = await commandDoctor({ json: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandExit);
    expect((err as InstanceType<typeof CommandExit>).code).toBe(1);

    // JSON still emitted before bail
    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.failed).toBe(1);
  });

  it("includes all check fields in JSON payload", async () => {
    doctorResults = [PASS, WARN, FAIL];
    const err = await commandDoctor({ json: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandExit); // fails due to FAIL

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed.checks).toHaveLength(3);
    expect(parsed.checks[0]).toMatchObject({
      name: "GitHub token",
      group: "Deliverability",
      severity: "ok",
      message: "Valid",
    });
    expect(parsed.checks[1]).toMatchObject({
      name: "X credentials",
      severity: "warn",
      hint: "Set TWITTER_USERNAME and TWITTER_PASSWORD",
    });
  });

  it("warnings go to stderr, stdout is still clean JSON", async () => {
    doctorResults = [WARN];
    await commandDoctor({ json: true });

    const stdout = stdoutChunks.join("");
    const stderr = stderrChunks.join("");

    // Stdout should be ONLY the JSON document, parseable with no extra lines
    expect(stdout.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.warned).toBe(1);

    // Warning detail should be on stderr
    expect(stderr).toContain("Missing");
  });
});

describe("find watch --once --json", () => {
  const RESULT: FinderResult = {
    source: "stub",
    candidates: 5,
    droppedIcp: 1,
    droppedDuplicate: 1,
    droppedEnrichment: 0,
    enqueued: 3,
    costUsd: 0.25,
  };

  it("emits valid JSON with schemaVersion", async () => {
    findTriggerOutcomes = [
      { name: "trigger-a", fired: true, result: RESULT, nextDueInMs: 3600_000, duration_ms: 1234 },
    ];
    await commandFindWatch({ once: true, quiet: true, json: true });

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("schemaVersion", 1);
    expect(parsed.command).toBe("find watch");
    expect(parsed.ok).toBe(true);
    expect(parsed.errored).toBe(0);
    expect(parsed.triggers).toHaveLength(1);
    expect(parsed.triggers[0]).toMatchObject({
      name: "trigger-a",
      fired: true,
      nextDueInMs: 3600_000,
      durationMs: 1234,
    });
  });

  it("stdout has no ANSI codes", async () => {
    findTriggerOutcomes = [
      { name: "trigger-a", fired: true, result: RESULT, nextDueInMs: 3600_000 },
    ];
    await commandFindWatch({ once: true, quiet: true, json: true });

    const stdout = stdoutChunks.join("");
    expect(hasAnsiCodes(stdout)).toBe(false);
  });

  it("exits 1 on error, JSON still emitted", async () => {
    findTriggerOutcomes = [
      { name: "trigger-a", fired: true, result: RESULT, nextDueInMs: 3600_000 },
      { name: "trigger-b", fired: true, error: "API 403", nextDueInMs: 3600_000 },
    ];
    const err = await commandFindWatch({ once: true, quiet: true, json: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CommandExit);
    expect((err as InstanceType<typeof CommandExit>).code).toBe(1);

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.errored).toBe(1);
    expect(parsed.triggers[1]).toMatchObject({
      name: "trigger-b",
      fired: true,
      error: "API 403",
    });
  });

  it("includes finder result fields in trigger payload", async () => {
    const richResult: FinderResult = {
      source: "github-stars",
      candidates: 12,
      droppedIcp: 3,
      droppedRole: 2,
      droppedDuplicate: 1,
      droppedEnrichment: 1,
      droppedLowSignal: 1,
      enqueued: 4,
      costUsd: 0.5,
      halted: "budget cap",
    };
    findTriggerOutcomes = [{ name: "gh", fired: true, result: richResult, nextDueInMs: 7200_000 }];
    await commandFindWatch({ once: true, quiet: true, json: true });

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed.triggers[0].result).toMatchObject({
      source: "github-stars",
      candidates: 12,
      enqueued: 4,
      droppedIcp: 3,
      droppedRole: 2,
      droppedDuplicate: 1,
      droppedEnrichment: 1,
      droppedLowSignal: 1,
      costUsd: 0.5,
      halted: "budget cap",
    });
  });
});

describe("find drain --dry-run --json", () => {
  it("emits valid JSON with schemaVersion", async () => {
    drainResult = { drained: 10, sent: 0, deferred: 10, errors: [] };
    await commandFindDrain({ play: "demo", dryRun: true, json: true });

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("schemaVersion", 1);
    expect(parsed.command).toBe("find drain");
    expect(parsed.play).toBe("demo");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.drained).toBe(10);
    expect(parsed.sent).toBe(0);
    expect(parsed.deferred).toBe(10);
  });

  it("stdout has no ANSI codes", async () => {
    drainResult = { drained: 5, sent: 5, deferred: 0, errors: [] };
    await commandFindDrain({ play: "demo", dryRun: false, json: true });

    const stdout = stdoutChunks.join("");
    expect(hasAnsiCodes(stdout)).toBe(false);
  });

  it("includes error details in JSON", async () => {
    drainResult = {
      drained: 2,
      sent: 1,
      deferred: 0,
      errors: [{ id: "row-123", message: "Enrichment failed" }],
    };
    await commandFindDrain({ play: "demo", dryRun: false, json: true });

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toMatchObject({ id: "row-123", message: "Enrichment failed" });
  });
});

describe("find import --json schema", () => {
  it("emits the stable import result shape", async () => {
    await commandFindImport({
      csv: "ROADMAP.md",
      play: "profile-intro",
      dryRun: true,
      json: true,
    });

    const parsed = JSON.parse(stdoutChunks.join(""));
    expect(parsed).toEqual({
      schemaVersion: 1,
      imported: 2,
      skipped: 1,
      errors: [{ row: 3, message: "missing or invalid email" }],
    });
  });
});

describe("identities list --json", () => {
  // Two identities on the same sending domain: they share a cap group, so the
  // human line reports the shared domain usage and the JSON carries
  // domainSentToday alongside each identity's own count.
  const ONESHOT_A: EmailIdentity = {
    id: "oneshot:jn@tracepoint.email",
    provider: "oneshot",
    sendingDomain: "tracepoint.email",
    mailbox: "jn",
    maxPerDay: 50,
    warmup: null,
  };
  const ONESHOT_B: EmailIdentity = {
    id: "oneshot:nic@tracepoint.email",
    provider: "oneshot",
    sendingDomain: "tracepoint.email",
    mailbox: "nic",
    maxPerDay: 50,
    warmup: null,
  };
  const GMAIL: EmailIdentity = {
    id: "gmail:jn@freebutter.ai",
    provider: "gmail",
    address: "jn@freebutter.ai",
    maxPerDay: null,
    warmup: null,
  };

  const CAPS = new Map<string, IdentityCapacityView>([
    [ONESHOT_A.id, { capToday: 50, domainSentToday: 9, identitySentToday: 6, remaining: 41 }],
    [ONESHOT_B.id, { capToday: 50, domainSentToday: 9, identitySentToday: 3, remaining: 41 }],
    // Uncapped: capToday must land as null in JSON, "∞" in the human line.
    [
      GMAIL.id,
      {
        capToday: Number.POSITIVE_INFINITY,
        domainSentToday: 2,
        identitySentToday: 2,
        remaining: Number.POSITIVE_INFINITY,
      },
    ],
  ]);

  const ACTIVE_DOMAIN: DomainPoolEntry = {
    domain: "tracepoint.email",
    pool_status: "active",
    provisioning_status: "provisioned",
    warmup_score: 87,
    warmup_started_at: "2026-07-06T12:00:00.000Z",
    daily_send_limit: 50,
    daily_sent_count: 9,
    daily_sent_date: "2026-08-29",
    last_used_at: "2026-08-29T09:12:00.000Z",
  };
  const WARMING_DOMAIN: DomainPoolEntry = {
    domain: "trace-mail.dev",
    pool_status: "warming",
    provisioning_status: "provisioned",
    warmup_score: null,
    warmup_started_at: null,
    daily_send_limit: 20,
    daily_sent_count: 2,
    daily_sent_date: "2026-08-29",
    last_used_at: null,
  };

  beforeEach(() => {
    identitiesFixture = [ONESHOT_A, GMAIL];
    capsFixture = CAPS;
    domainsFixture = [ACTIVE_DOMAIN];
    configFixture = { emailIdentities: [ONESHOT_A, GMAIL] };
  });

  it("emits valid JSON with schemaVersion", async () => {
    await commandIdentitiesList({ json: true });

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("schemaVersion", 1);
    expect(parsed.command).toBe("identities list");
    expect(parsed.identities).toHaveLength(2);
    expect(parsed.domains).toHaveLength(1);
  });

  it("stdout has no ANSI codes", async () => {
    identitiesFixture = [ONESHOT_A, ONESHOT_B, GMAIL];
    domainsFixture = [ACTIVE_DOMAIN, WARMING_DOMAIN];
    await commandIdentitiesList({ json: true });

    const stdout = stdoutChunks.join("");
    expect(hasAnsiCodes(stdout)).toBe(false);
  });

  it("human output goes to stderr, not stdout", async () => {
    await commandIdentitiesList({ json: true });

    const stdout = stdoutChunks.join("");
    const stderr = stderrChunks.join("");

    // Stdout should be ONLY the JSON document
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(() => JSON.parse(stdout)).not.toThrow();

    // Human headers/rows should be on stderr
    expect(stderr).toContain("Sender identities");
    expect(stderr).toContain("Provisioned domains");
    expect(stderr).toContain("jn@tracepoint.email");
  });

  it("includes all identity and domain fields in JSON payload", async () => {
    identitiesFixture = [ONESHOT_A, ONESHOT_B, GMAIL];
    domainsFixture = [ACTIVE_DOMAIN, WARMING_DOMAIN];
    configFixture = { emailIdentities: null }; // legacy (auto-derived) pool
    await commandIdentitiesList({ json: true });

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);

    expect(parsed.identities).toHaveLength(3);
    expect(parsed.identities[0]).toMatchObject({
      id: "oneshot:jn@tracepoint.email",
      provider: "oneshot",
      address: "jn@tracepoint.email",
      sentToday: 6,
      capToday: 50,
      domainSentToday: 9,
      legacy: true,
    });
    expect(parsed.identities[1]).toMatchObject({
      address: "nic@tracepoint.email",
      sentToday: 3,
      domainSentToday: 9,
    });
    // Uncapped identity: Infinity isn't JSON, so capToday is null.
    expect(parsed.identities[2]).toMatchObject({
      id: "gmail:jn@freebutter.ai",
      provider: "gmail",
      address: "jn@freebutter.ai",
      sentToday: 2,
      capToday: null,
      legacy: true,
    });

    expect(parsed.domains).toHaveLength(2);
    expect(parsed.domains[0]).toMatchObject({
      domain: "tracepoint.email",
      poolStatus: "active",
      warmupScore: 87,
      dailySent: 9,
      dailyLimit: 50,
    });
    expect(parsed.domains[1]).toMatchObject({
      domain: "trace-mail.dev",
      poolStatus: "warming",
      warmupScore: null,
      dailySent: 2,
      dailyLimit: 20,
    });
  });
});

describe("domains list --json", () => {
  const ACTIVE_DOMAIN: DomainPoolEntry = {
    domain: "tracepoint.email",
    pool_status: "active",
    provisioning_status: "provisioned",
    warmup_score: 87,
    warmup_started_at: "2026-07-06T12:00:00.000Z",
    daily_send_limit: 50,
    daily_sent_count: 9,
    daily_sent_date: "2026-08-29",
    last_used_at: "2026-08-29T09:12:00.000Z",
  };
  const PAUSED_DOMAIN: DomainPoolEntry = {
    domain: "trace-mail.dev",
    pool_status: "paused",
    provisioning_status: "provisioned",
    warmup_score: null,
    warmup_started_at: null,
    daily_send_limit: 20,
    daily_sent_count: 0,
    daily_sent_date: "2026-08-29",
    last_used_at: null,
  };

  beforeEach(() => {
    domainsFixture = [ACTIVE_DOMAIN];
  });

  it("emits valid JSON with schemaVersion on stdout", async () => {
    await commandDomainsList({ json: true });

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("schemaVersion", 1);
    expect(parsed.command).toBe("domains list");
    expect(parsed.domains).toHaveLength(1);
  });

  it("stdout has no ANSI codes", async () => {
    domainsFixture = [ACTIVE_DOMAIN, PAUSED_DOMAIN];
    await commandDomainsList({ json: true });

    const stdout = stdoutChunks.join("");
    expect(hasAnsiCodes(stdout)).toBe(false);
  });

  it("human output goes to stderr, stdout is only the JSON document", async () => {
    await commandDomainsList({ json: true });

    const stdout = stdoutChunks.join("");
    const stderr = stderrChunks.join("");

    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(() => JSON.parse(stdout)).not.toThrow();

    // Header + rows should be on stderr
    expect(stderr).toContain("Provisioned domains");
    expect(stderr).toContain("tracepoint.email");
  });

  it("pins the domain shape", async () => {
    domainsFixture = [ACTIVE_DOMAIN, PAUSED_DOMAIN];
    await commandDomainsList({ json: true });

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed.domains).toHaveLength(2);
    expect(parsed.domains[0]).toMatchObject({
      domain: "tracepoint.email",
      poolStatus: "active",
      warmupScore: 87,
      dailySent: 9,
      dailyLimit: 50,
    });
    // warmup_score null lands as null, not dropped.
    expect(parsed.domains[1]).toMatchObject({
      domain: "trace-mail.dev",
      poolStatus: "paused",
      warmupScore: null,
      dailySent: 0,
      dailyLimit: 20,
    });
    // Always emit the boolean so consumers can distinguish this schema from the old shape.
    expect(parsed.domainsError).toBe(false);
  });

  it("empty pool emits an empty array, not an error flag", async () => {
    domainsFixture = [];
    await commandDomainsList({ json: true });

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed.domains).toEqual([]);
    expect(parsed.domainsError).toBe(false);
  });

  it("flags domainsError when the pool is unreachable", async () => {
    listDomainsThrows = new Error("pool offline");
    await commandDomainsList({ json: true });

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed.domains).toEqual([]);
    expect(parsed.domainsError).toBe(true);
  });
});

describe("workspace list --json", () => {
  const REGISTRY = {
    default: "gtm",
    workspaces: {
      default: { home: "/home/default", port: 3030, createdAt: "" },
      gtm: { home: "/home/gtm", port: 3031, createdAt: "2026-08-01T00:00:00.000Z" },
    },
  };
  const ROWS: Array<[string, WorkspaceEntryLike]> = [
    ["default", { home: "/home/default", port: 3030, createdAt: "" }],
    ["gtm", { home: "/home/gtm", port: 3031, createdAt: "2026-08-01T00:00:00.000Z" }],
  ];

  beforeEach(() => {
    workspaceRegistryFixture = REGISTRY;
    workspaceRowsFixture = ROWS;
    currentWorkspaceFixture = "gtm";
  });

  it("emits valid JSON with schemaVersion on stdout", async () => {
    await commandWorkspaceList({ json: true });

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("schemaVersion", 1);
    expect(parsed.command).toBe("workspace list");
    expect(parsed.workspaces).toHaveLength(2);
  });

  it("stdout has no ANSI codes", async () => {
    await commandWorkspaceList({ json: true });

    const stdout = stdoutChunks.join("");
    expect(hasAnsiCodes(stdout)).toBe(false);
  });

  it("human output goes to stderr, stdout is only the JSON document", async () => {
    await commandWorkspaceList({ json: true });

    const stdout = stdoutChunks.join("");
    const stderr = stderrChunks.join("");

    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(() => JSON.parse(stdout)).not.toThrow();

    // Header + rows should be on stderr
    expect(stderr).toContain("oneshot-gtm workspaces");
    expect(stderr).toContain("/home/gtm");
  });

  it("pins the workspace shape, current and default flags", async () => {
    await commandWorkspaceList({ json: true });

    const stdout = stdoutChunks.join("");
    const parsed = JSON.parse(stdout);
    expect(parsed.current).toBe("gtm");
    expect(parsed.default).toBe("gtm");
    expect(parsed.workspaces[0]).toMatchObject({
      name: "default",
      port: 3030,
      home: "/home/default",
      isCurrent: false,
      isDefault: false,
    });
    expect(parsed.workspaces[1]).toMatchObject({
      name: "gtm",
      port: 3031,
      home: "/home/gtm",
      isCurrent: true,
      isDefault: true,
    });
  });
});
