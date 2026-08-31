import {
  configDir,
  createWorkspace,
  currentWorkspaceName,
  listWorkspaces,
  loadRegistry,
  removeWorkspace,
  resolveWorkspaceHome,
  setDefaultWorkspace,
  WorkspaceError,
} from "@oneshot-gtm/core";
import { bail, c, emitJson, header, note, ok, setJsonMode, warn } from "../output.ts";

function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof WorkspaceError) bail(err.message);
    throw err;
  }
}

export async function commandWorkspaceList(opts: { json?: boolean } = {}): Promise<void> {
  setJsonMode(opts.json ?? false);
  header("oneshot-gtm workspaces");
  const reg = loadRegistry();
  const current = currentWorkspaceName();
  const rows = listWorkspaces(reg);
  for (const [name, entry] of rows) {
    const marks = [
      name === current ? c.green("current") : null,
      name === reg.default ? c.dim("default") : null,
    ]
      .filter(Boolean)
      .join(" · ");
    note(`  ${name.padEnd(18)} :${entry.port}  ${entry.home}${marks ? `  ${marks}` : ""}`);
  }
  note("");
  note(
    `Select one per run with ${c.cyan("--workspace <name>")}, or persist it with ${c.cyan("workspace use <name>")}.`,
  );

  if (opts.json) {
    emitJson({
      command: "workspace list",
      current,
      default: reg.default,
      workspaces: rows.map(([name, entry]) => ({
        name,
        port: entry.port,
        home: entry.home,
        isCurrent: name === current,
        isDefault: name === reg.default,
      })),
    });
  }
}

export async function commandWorkspaceCreate(name: string): Promise<void> {
  header(`oneshot-gtm workspace create ${name}`);
  const entry = guarded(() => createWorkspace(name));
  ok(`created ${c.cyan(name)} at ${entry.home} (dashboard port ${entry.port})`);
  note("");
  note("It's an empty install. Set it up like any other, scoped with --workspace:");
  note(`  ${c.cyan(`bun run cli -- --workspace ${name} init`)}`);
  note(`  ${c.cyan(`bun run cli -- --workspace ${name} ui`)}`);
  warn("Give it its own sending domain and Gmail account — sharing either with another");
  warn("workspace doubles the domain's daily budget and cross-wires reply detection.");
}

export async function commandWorkspaceUse(name: string): Promise<void> {
  guarded(() => setDefaultWorkspace(name));
  ok(`default workspace is now ${c.cyan(name)} — runs without --workspace use it`);
}

export async function commandWorkspaceCurrent(): Promise<void> {
  // configDir() is the home this process is actually bound to — which, under
  // an explicit ONESHOT_GTM_HOME, needn't be a registered workspace at all.
  process.stdout.write(`${currentWorkspaceName()}	${configDir()}
`);
}

export async function commandWorkspacePath(name: string): Promise<void> {
  // Bare path on stdout, for scripts: ONESHOT_GTM_HOME=$(oneshot-gtm workspace path gtm) …
  process.stdout.write(`${guarded(() => resolveWorkspaceHome(name))}\n`);
}

export async function commandWorkspaceRemove(name: string): Promise<void> {
  const entry = guarded(() => removeWorkspace(name));
  ok(`forgot workspace ${c.cyan(name)}`);
  note(`Its files were left in place — remove them yourself if you mean it: ${entry.home}`);
}
