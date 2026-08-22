import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BASE_PORT,
  createWorkspace,
  DEFAULT_WORKSPACE,
  extractWorkspaceFlag,
  legacyHome,
  listWorkspaces,
  loadRegistry,
  portForHome,
  removeWorkspace,
  resolveWorkspaceHome,
  resolveWorkspaceSelection,
  setDefaultWorkspace,
  WorkspaceError,
  workspaceNameForHome,
} from "../src/workspaces.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oneshot-ws-"));
  process.env["ONESHOT_GTM_WORKSPACES"] = dir;
});
afterEach(() => {
  delete process.env["ONESHOT_GTM_WORKSPACES"];
  rmSync(dir, { recursive: true, force: true });
});

describe("registry", () => {
  it("starts with only the implicit default pointing at the legacy home", () => {
    const all = listWorkspaces();
    expect(all).toHaveLength(1);
    expect(all[0]?.[0]).toBe(DEFAULT_WORKSPACE);
    expect(all[0]?.[1].home).toBe(legacyHome());
    expect(loadRegistry().default).toBe(DEFAULT_WORKSPACE);
  });

  it("creates a workspace under the container with the next free port", () => {
    const a = createWorkspace("gtm");
    const b = createWorkspace("sdk");
    expect(a.home).toBe(join(dir, "gtm"));
    expect(a.port).toBe(3031);
    expect(b.port).toBe(3032);
    expect(resolveWorkspaceHome("sdk")).toBe(b.home);
  });

  it("rejects bad names, duplicates and the reserved default", () => {
    expect(() => createWorkspace("Bad Name")).toThrow(WorkspaceError);
    createWorkspace("gtm");
    expect(() => createWorkspace("gtm")).toThrow(/already exists/);
    expect(() => createWorkspace("default")).toThrow(/built-in/);
  });

  it("use/remove update the default and never delete files", () => {
    const e = createWorkspace("gtm");
    setDefaultWorkspace("gtm");
    expect(loadRegistry().default).toBe("gtm");
    const removed = removeWorkspace("gtm");
    expect(removed.home).toBe(e.home);
    expect(loadRegistry().default).toBe(DEFAULT_WORKSPACE);
    expect(() => removeWorkspace("default")).toThrow(WorkspaceError);
  });

  it("maps a home back to its workspace name, following symlink-free canonical paths", () => {
    const e = createWorkspace("gtm");
    expect(workspaceNameForHome(e.home)).toBe("gtm");
    expect(workspaceNameForHome(`${e.home}/`)).toBe("gtm");
    expect(workspaceNameForHome(join(dir, "nope"))).toBeNull();
  });
});

describe("selection (what the bootstrap shim does)", () => {
  it("flag > env > registry default", () => {
    createWorkspace("gtm");
    createWorkspace("sdk");
    setDefaultWorkspace("sdk");
    const reg = loadRegistry();
    expect(
      resolveWorkspaceSelection({
        flag: "gtm",
        envWorkspace: "sdk",
        envHome: undefined,
        registry: reg,
      }).name,
    ).toBe("gtm");
    expect(
      resolveWorkspaceSelection({
        flag: null,
        envWorkspace: "gtm",
        envHome: undefined,
        registry: reg,
      }).name,
    ).toBe("gtm");
    expect(
      resolveWorkspaceSelection({
        flag: null,
        envWorkspace: undefined,
        envHome: undefined,
        registry: reg,
      }).name,
    ).toBe("sdk");
  });

  it("an explicit ONESHOT_GTM_HOME wins, and conflicts with --workspace", () => {
    const reg = loadRegistry();
    const sel = resolveWorkspaceSelection({
      flag: null,
      envWorkspace: undefined,
      envHome: join(dir, "elsewhere"),
      registry: reg,
    });
    expect(sel.home).toBe(join(dir, "elsewhere"));
    expect(() =>
      resolveWorkspaceSelection({
        flag: "gtm",
        envWorkspace: undefined,
        envHome: join(dir, "elsewhere"),
        registry: reg,
      }),
    ).toThrow(/conflicts/);
  });

  it("an unknown name is a legible error listing what exists", () => {
    createWorkspace("gtm");
    expect(() =>
      resolveWorkspaceSelection({
        flag: "nope",
        envWorkspace: undefined,
        envHome: undefined,
        registry: loadRegistry(),
      }),
    ).toThrow(/no workspace named 'nope' \(known: default, gtm\)/);
  });
});

describe("extractWorkspaceFlag", () => {
  it("strips --workspace in both spellings and leaves the rest of argv intact", () => {
    expect(extractWorkspaceFlag(["--workspace", "gtm", "ui", "--port", "4"])).toEqual({
      flag: "gtm",
      argv: ["ui", "--port", "4"],
    });
    expect(extractWorkspaceFlag(["ui", "--workspace=sdk"])).toEqual({ flag: "sdk", argv: ["ui"] });
    expect(extractWorkspaceFlag(["-w", "gtm", "doctor"])).toEqual({
      flag: "gtm",
      argv: ["doctor"],
    });
    expect(extractWorkspaceFlag(["doctor"])).toEqual({ flag: null, argv: ["doctor"] });
  });

  it("rejects a missing name", () => {
    expect(() => extractWorkspaceFlag(["--workspace"])).toThrow(/needs a name/);
    expect(() => extractWorkspaceFlag(["--workspace", "--port"])).toThrow(/needs a name/);
  });
});

describe("second-round review findings (#37)", () => {
  it("an empty ONESHOT_GTM_WORKSPACE falls back to the registry default", () => {
    expect(
      resolveWorkspaceSelection({
        flag: null,
        envWorkspace: "  ",
        envHome: undefined,
        registry: loadRegistry(),
      }).name,
    ).toBe(DEFAULT_WORKSPACE);
  });

  it("unregistered homes are identified by canonical path, not basename", () => {
    const reg = loadRegistry();
    const a = resolveWorkspaceSelection({
      flag: null,
      envWorkspace: undefined,
      envHome: join(dir, "a", "gtm"),
      registry: reg,
    });
    const b = resolveWorkspaceSelection({
      flag: null,
      envWorkspace: undefined,
      envHome: join(dir, "b", "gtm"),
      registry: reg,
    });
    expect(a.name).not.toBe(b.name);
    expect(a.name.startsWith("home:")).toBe(true);
  });

  it("a relative ONESHOT_GTM_WORKSPACES is stored absolute", () => {
    process.env["ONESHOT_GTM_WORKSPACES"] = "./rel-ws-" + process.pid;
    try {
      const e = createWorkspace("gtm");
      expect(e.home.startsWith("/")).toBe(true);
    } finally {
      rmSync(resolve("./rel-ws-" + process.pid), { recursive: true, force: true });
    }
  });

  it("portForHome keys on the home, so a same-basename unregistered home gets the fallback", () => {
    const e = createWorkspace("gtm");
    expect(portForHome(e.home)).toBe(e.port);
    expect(portForHome(join(dir, "elsewhere", "gtm"))).toBe(BASE_PORT);
  });
});
