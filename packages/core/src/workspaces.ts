/**
 * Named workspaces — fully isolated installs (one ONESHOT_GTM_HOME each).
 *
 * This module imports ONLY node builtins, on purpose: the CLI's bootstrap
 * shim must resolve `--workspace <name>` to a home dir BEFORE core's config.ts
 * is evaluated (it captures ONESHOT_GTM_HOME at module load), so anything
 * this file imported from core would defeat the whole point. It is exposed as
 * the `@oneshot-gtm/core/workspaces` subpath for that reason.
 *
 * Layout:
 *   ~/.oneshot-gtm                        the `default` workspace (legacy home)
 *   ~/.oneshot-gtm-workspaces/registry.json
 *   ~/.oneshot-gtm-workspaces/<name>/     every named workspace
 *
 * `ONESHOT_GTM_WORKSPACES` relocates the container (tests, demos).
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const DEFAULT_WORKSPACE = "default";
/** Port the default workspace's dashboard binds; named ones get the next free slot. */
export const BASE_PORT = 3030;

export interface WorkspaceEntry {
  /** Absolute home dir (config.json, ledger.sqlite, .env, …). */
  home: string;
  /** Dashboard port this workspace uses by default, so several can run side by side. */
  port: number;
  createdAt: string;
}

export interface WorkspaceRegistry {
  /** Which workspace `oneshot-gtm` uses when no --workspace / env is given. */
  default: string;
  workspaces: Record<string, WorkspaceEntry>;
}

export class WorkspaceError extends Error {}

export function workspacesDir(): string {
  // Absolute, so a relative override doesn't persist homes that resolve
  // differently from another working directory.
  return resolve(
    process.env["ONESHOT_GTM_WORKSPACES"]?.trim() || join(homedir(), ".oneshot-gtm-workspaces"),
  );
}

export function legacyHome(): string {
  return join(homedir(), ".oneshot-gtm");
}

function registryPath(): string {
  return join(workspacesDir(), "registry.json");
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function assertValidName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new WorkspaceError(
      `invalid workspace name '${name}' — use 1-32 lowercase letters, digits or hyphens`,
    );
  }
}

export function loadRegistry(): WorkspaceRegistry {
  const p = registryPath();
  if (!existsSync(p)) return { default: DEFAULT_WORKSPACE, workspaces: {} };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<WorkspaceRegistry>;
    return {
      default: typeof raw.default === "string" ? raw.default : DEFAULT_WORKSPACE,
      // A plain object only: an array would accept named properties and then
      // drop them on stringify — the workspace would vanish after saving.
      workspaces:
        raw.workspaces && typeof raw.workspaces === "object" && !Array.isArray(raw.workspaces)
          ? raw.workspaces
          : {},
    };
  } catch {
    throw new WorkspaceError(`workspace registry at ${p} is not valid JSON — fix or delete it`);
  }
}

export function saveRegistry(reg: WorkspaceRegistry): void {
  const p = registryPath();
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  // Write-then-rename so a reader never sees a half-written file.
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`);
  renameSync(tmp, p);
}

/**
 * A lock older than this belongs to a process that died mid-edit. Registry
 * edits are milliseconds (read JSON, write JSON, mkdir), so 30s is many orders
 * of magnitude past any live operation.
 */
const LOCK_STALE_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serialize read-modify-write of the registry across processes with an
 * exclusive lock file (O_EXCL create). Without it two `workspace create`s at
 * once read the same registry, pick the same free port and the later save
 * overwrites the earlier one — a lost workspace AND a port collision.
 *
 * The lock carries an owner token: release only unlinks OUR lock, so a
 * process that legitimately broke a stale lock can't have its replacement
 * yanked by the original owner's `finally`. Every retry checks the deadline
 * first, so a persistent filesystem error (EACCES on stat/unlink) surfaces as
 * a WorkspaceError instead of a full-CPU spin.
 */
export function withRegistryLock<T>(fn: () => T, opts: { waitMs?: number } = {}): T {
  const lock = `${registryPath()}.lock`;
  if (!existsSync(dirname(lock))) mkdirSync(dirname(lock), { recursive: true });
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + (opts.waitMs ?? 5_000);
  for (;;) {
    try {
      writeFileSync(lock, token, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (Date.now() > deadline) {
      throw new WorkspaceError(
        `workspace registry is locked (${lock}) — another command is editing it`,
      );
    }
    let stale = false;
    try {
      stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
    } catch {
      // vanished between create and stat, or unreadable — just retry
    }
    if (stale) {
      try {
        unlinkSync(lock);
      } catch {
        // someone else broke it first, or we can't — the deadline bounds us
      }
    }
    sleepSync(50);
  }
  try {
    return fn();
  } finally {
    try {
      if (readFileSync(lock, "utf8") === token) unlinkSync(lock);
    } catch {
      // already gone, or not ours
    }
  }
}

/** Every workspace incl. the implicit default, as (name, entry) — for listing and guardrails. */
export function listWorkspaces(
  reg: WorkspaceRegistry = loadRegistry(),
): Array<[string, WorkspaceEntry]> {
  const all: Array<[string, WorkspaceEntry]> = [
    [DEFAULT_WORKSPACE, { home: legacyHome(), port: BASE_PORT, createdAt: "" }],
  ];
  for (const [name, entry] of Object.entries(reg.workspaces)) {
    if (name !== DEFAULT_WORKSPACE) all.push([name, entry]);
  }
  return all;
}

/** Resolve a name to its home, or throw a legible error. */
export function resolveWorkspaceHome(
  name: string,
  reg: WorkspaceRegistry = loadRegistry(),
): string {
  if (name === DEFAULT_WORKSPACE) return legacyHome();
  const entry = Object.hasOwn(reg.workspaces, name) ? reg.workspaces[name] : undefined;
  if (!entry) {
    const known = listWorkspaces(reg)
      .map(([n]) => n)
      .join(", ");
    throw new WorkspaceError(`no workspace named '${name}' (known: ${known})`);
  }
  return entry.home;
}

export function createWorkspace(name: string): WorkspaceEntry {
  assertValidName(name);
  if (name === DEFAULT_WORKSPACE) {
    throw new WorkspaceError(`'${DEFAULT_WORKSPACE}' is the built-in workspace at ${legacyHome()}`);
  }
  return withRegistryLock(() => {
    const reg = loadRegistry();
    // hasOwn: "constructor" et al. are valid names, not inherited entries.
    if (Object.hasOwn(reg.workspaces, name)) {
      throw new WorkspaceError(`workspace '${name}' already exists`);
    }
    const home = join(workspacesDir(), name);
    // `workspace remove` leaves files behind on purpose; a new workspace must
    // never silently inherit that stale config, ledger and credentials.
    if (existsSync(home) && readdirSync(home).length > 0) {
      throw new WorkspaceError(
        `${home} already has files (a removed workspace?) — delete them first, or pick another name`,
      );
    }
    const used = new Set(listWorkspaces(reg).map(([, e]) => e.port));
    let port = BASE_PORT + 1;
    while (used.has(port)) port += 1;
    const entry: WorkspaceEntry = { home, port, createdAt: new Date().toISOString() };
    mkdirSync(home, { recursive: true });
    reg.workspaces[name] = entry;
    saveRegistry(reg);
    return entry;
  });
}

export function setDefaultWorkspace(name: string): void {
  withRegistryLock(() => {
    const reg = loadRegistry();
    resolveWorkspaceHome(name, reg); // throws if unknown
    reg.default = name;
    saveRegistry(reg);
  });
}

/** Forget a workspace. Files are NOT deleted — the path is printed for the founder to remove. */
export function removeWorkspace(name: string): WorkspaceEntry {
  if (name === DEFAULT_WORKSPACE)
    throw new WorkspaceError("the default workspace can't be removed");
  return withRegistryLock(() => {
    const reg = loadRegistry();
    const entry = Object.hasOwn(reg.workspaces, name) ? reg.workspaces[name] : undefined;
    if (!entry) throw new WorkspaceError(`no workspace named '${name}'`);
    delete reg.workspaces[name];
    if (reg.default === name) reg.default = DEFAULT_WORKSPACE;
    saveRegistry(reg);
    return entry;
  });
}

/** Symlink-following path identity, so two spellings of one dir compare equal. */
export function canonicalPath(p: string): string {
  let base = resolve(p);
  const tail: string[] = [];
  while (!existsSync(base)) {
    const parent = dirname(base);
    if (parent === base) break;
    tail.unshift(basename(base));
    base = parent;
  }
  const real = existsSync(base) ? realpathSync(base) : base;
  return tail.length > 0 ? join(real, ...tail) : real;
}

/** Name of the workspace whose home is `home`, if any (used by doctor / the masthead). */
export function workspaceNameForHome(
  home: string,
  reg: WorkspaceRegistry = loadRegistry(),
): string | null {
  const target = canonicalPath(home);
  for (const [name, entry] of listWorkspaces(reg)) {
    if (canonicalPath(entry.home) === target) return name;
  }
  return null;
}

/**
 * Dashboard port for the install at `home`: the registered port when that
 * exact home is a workspace, else BASE_PORT. Keyed by home rather than by the
 * derived name, so an unregistered ONESHOT_GTM_HOME can never borrow a
 * registered workspace's port and collide with its running dashboard.
 */
export function portForHome(home: string, reg: WorkspaceRegistry = loadRegistry()): number {
  const target = canonicalPath(home);
  for (const [, entry] of listWorkspaces(reg)) {
    if (canonicalPath(entry.home) === target) return entry.port;
  }
  return BASE_PORT;
}

/**
 * What the bootstrap shim does: decide the home for this process from
 * `--workspace` (already stripped from argv by the caller), the env, or the
 * registry default. An explicit ONESHOT_GTM_HOME wins outright — it is the
 * lower-level escape hatch — and combining it with --workspace is an error,
 * since they would disagree about where the install is.
 */
export function resolveWorkspaceSelection(input: {
  flag: string | null;
  envWorkspace: string | undefined;
  envHome: string | undefined;
  registry: WorkspaceRegistry;
}): { name: string; home: string } {
  const explicitHome = input.envHome?.trim();
  if (explicitHome) {
    if (input.flag) {
      throw new WorkspaceError(
        `--workspace '${input.flag}' conflicts with ONESHOT_GTM_HOME=${explicitHome} — set one, not both`,
      );
    }
    // An unregistered home must not collide with a registered one — or with
    // another unregistered home of the same basename — in the shared DB's
    // touch attribution, or the cross-workspace hold would treat two installs
    // as one. Identity is the canonical path.
    return {
      name:
        workspaceNameForHome(explicitHome, input.registry) ?? `home:${canonicalPath(explicitHome)}`,
      home: explicitHome,
    };
  }
  const name = input.flag ?? (input.envWorkspace?.trim() || input.registry.default);
  return { name, home: resolveWorkspaceHome(name, input.registry) };
}

/** Pull `--workspace <name>` / `--workspace=<name>` out of argv. Returns the cleaned argv. */
export function extractWorkspaceFlag(argv: string[]): { flag: string | null; argv: string[] } {
  const out: string[] = [];
  let flag: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--workspace" || a === "-w") {
      flag = argv[i + 1] ?? null;
      if (!flag || flag.startsWith("-")) {
        throw new WorkspaceError("--workspace needs a name");
      }
      i += 1;
      continue;
    }
    if (a.startsWith("--workspace=")) {
      flag = a.slice("--workspace=".length);
      if (!flag) throw new WorkspaceError("--workspace needs a name");
      continue;
    }
    out.push(a);
  }
  return { flag, argv: out };
}
