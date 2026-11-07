import {
  configDir,
  createWorkspace,
  currentWorkspaceName,
  getSharedDb,
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
    await emitJson({
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
  // configDir() is the home this process is actually bound to, which, under
  // an explicit ONESHOT_GTM_HOME, needn't be a registered workspace at all.
  process.stdout.write(`${currentWorkspaceName()}	${configDir()}
`);
}

export async function commandWorkspacePath(name: string): Promise<void> {
  // Bare path on stdout, for scripts: ONESHOT_GTM_HOME=$(oneshot-gtm workspace path <name>) …
  process.stdout.write(`${guarded(() => resolveWorkspaceHome(name))}\n`);
}

export async function commandWorkspaceRemove(name: string): Promise<void> {
  const entry = guarded(() => removeWorkspace(name));
  ok(`forgot workspace ${c.cyan(name)}`);
  note(`Its files were left in place — remove them yourself if you mean it: ${entry.home}`);
}

/**
 * People in a live sequence (active or paused) here AND in another workspace,
 * grouped by play pair: the overlaps to resolve by hand. Reads the shared
 * presence table only; changes nothing.
 */
export async function commandWorkspaceOverlaps(opts: { json?: boolean } = {}): Promise<void> {
  setJsonMode(opts.json ?? false);
  const workspace = currentWorkspaceName();
  header(`oneshot-gtm workspace overlaps · ${workspace}`);
  const groups = new Map<
    string,
    {
      play: string;
      otherWorkspace: string;
      otherPlay: string;
      people: Array<{
        prospectId: number;
        email: string | null;
        linkedinSlug: string | null;
        status: string;
        otherProspectId: number;
        otherStatus: string;
      }>;
    }
  >();
  const people = new Set<number>();
  for (const { here, elsewhere } of getSharedDb().cadenceOverlaps(workspace)) {
    const key = JSON.stringify([here.play_name, elsewhere.workspace, elsewhere.play_name]);
    const group = groups.get(key) ?? {
      play: here.play_name,
      otherWorkspace: elsewhere.workspace,
      otherPlay: elsewhere.play_name,
      people: [],
    };
    group.people.push({
      prospectId: here.prospect_id,
      email: here.email,
      linkedinSlug: here.linkedin_slug,
      status: here.status,
      otherProspectId: elsewhere.prospect_id,
      otherStatus: elsewhere.status,
    });
    groups.set(key, group);
    people.add(here.prospect_id);
  }
  const pairs = [...groups.values()];
  if (pairs.length === 0) {
    ok("nobody in a live sequence here is in one in another workspace");
  } else {
    note(`${people.size} people in a live sequence here and in another workspace`);
    for (const pair of pairs) {
      note("");
      note(
        `  ${c.cyan(pair.play)} here · ${c.cyan(`${pair.otherWorkspace} ${pair.otherPlay}`)}  ${pair.people.length}`,
      );
      for (const p of pair.people) {
        const who = p.email ?? (p.linkedinSlug ? `linkedin.com/in/${p.linkedinSlug}` : "?");
        note(
          `    ${who}  ${c.dim(`#${p.prospectId} ${p.status} · there #${p.otherProspectId} ${p.otherStatus}`)}`,
        );
      }
    }
  }
  note("");
  note(
    c.dim(
      "Each workspace writes its cadences as they change and when its dashboard starts. Nothing here is changed.",
    ),
  );
  if (opts.json) {
    await emitJson({
      command: "workspace overlaps",
      workspace,
      peopleCount: people.size,
      pairs,
    });
  }
}
