import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Circle, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client.ts";
import { openWorkspace } from "../../lib/openWorkspace.ts";
import { createAndOpenWorkspace } from "../../lib/createWorkspace.ts";
import { cn } from "../../lib/cn.ts";
import { workspaceHue } from "../../lib/workspaceHue.ts";

/**
 * Workspace identity chip + switcher.
 *
 * Sits in the sidebar masthead. The chip ALWAYS names the workspace this
 * dashboard serves: including "default", which the old header suppressed and
 * left the founder unable to tell installs apart. Clicking opens a roster of
 * every registered workspace; each is its own server on its own port, so
 * "switch" means opening that server's tab: auto-starting it first when it
 * isn't running (the launch endpoint spawns it detached; see
 * apps/server/src/api/workspace.ts for the no-supervision trade-off).
 */

function WorkspaceDot({ name, isDefault }: { name: string; isDefault: boolean }) {
  if (isDefault || name === "default") {
    return <span className="h-[6px] w-[6px] rounded-full bg-ink-muted" />;
  }
  return (
    <span
      className="h-[6px] w-[6px] rounded-full"
      style={{ background: `oklch(0.72 0.14 ${workspaceHue(name)})` }}
    />
  );
}

/** Roster refresh: fast while a launch is in flight, lazy otherwise. */
const IDLE_MS = 60_000;
const LAUNCHING_MS = 1_000;

export function WorkspaceSwitcher() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [launching, setLaunching] = useState<string | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const ws = useQuery({
    queryKey: ["workspace"],
    queryFn: api.workspace,
    refetchInterval: launching ? LAUNCHING_MS : IDLE_MS,
  });

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = ws.data?.current;
  const roster = ws.data?.workspaces ?? [];

  const onRowClick = async (row: (typeof roster)[number]) => {
    if (row.isCurrent || row.running) setOpen(false);
    await openWorkspace(row, {
      onLaunchStart: () => setLaunching(row.name),
      onSettled: () => {
        setLaunching(null);
        void queryClient.invalidateQueries({ queryKey: ["workspace"] });
      },
    });
  };

  return (
    <div ref={rootRef} className="relative mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="switch workspace"
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-2 py-0.5",
          "font-mono text-[11px] transition-colors",
          "border-ink-rule text-ink-cream-2 hover:bg-ink-surface/80",
        )}
        title={current ? `${current.home} · :${current.port}` : "workspace"}
      >
        <WorkspaceDot name={current?.name ?? "default"} isDefault={current?.name === "default"} />
        <span className="text-ink-cream">{current?.name ?? "…"}</span>
        <span className="text-ink-faint">:{current?.port ?? ""}</span>
      </button>

      {open && (
        <div
          className={cn(
            "absolute left-0 top-full z-50 mt-1 w-[204px]",
            "rounded-[var(--radius-sm)] border border-ink-rule bg-ink-bg shadow-lg",
            "p-1",
          )}
          role="menu"
        >
          <div className="ln-eyebrow px-2 pb-1 pt-1.5" style={{ fontSize: 9.5 }}>
            Workspaces
          </div>
          {roster.map((row) => (
            <button
              key={row.name}
              type="button"
              role="menuitem"
              onClick={() => void onRowClick(row)}
              disabled={creating || (launching !== null && launching !== row.name)}
              className={cn(
                "flex w-full items-center gap-2 rounded-[var(--radius-xs)] px-2 py-1.5 text-left",
                "font-mono text-[11.5px] transition-colors hover:bg-ink-surface/80",
                "disabled:opacity-50",
              )}
            >
              <WorkspaceDot name={row.name} isDefault={row.name === "default"} />
              <span className="text-ink-cream">{row.name}</span>
              <span className="text-ink-faint">:{row.port}</span>
              <span className="ml-auto flex items-center gap-1 text-ink-faint">
                {launching === row.name ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-label="starting" />
                ) : row.isCurrent ? (
                  <Check className="h-3 w-3 text-[color:var(--ink-receipt)]" aria-label="current" />
                ) : row.running ? (
                  <span
                    className="h-[6px] w-[6px] rounded-full bg-[color:var(--ink-signal)]"
                    aria-label="running"
                  />
                ) : (
                  <Circle className="h-2.5 w-2.5 opacity-50" aria-label="stopped" />
                )}
              </span>
            </button>
          ))}
          {newName === null ? (
            <button
              type="button"
              role="menuitem"
              className="w-full px-2 py-1.5 text-left text-xs text-ink-cream hover:bg-ink-surface/80"
              disabled={launching !== null}
              onClick={() => {
                setNewName("");
                setCreateError(null);
              }}
            >
              New workspace
            </button>
          ) : (
            <form
              className="border-t border-ink-rule mt-1 p-2 space-y-2 text-xs"
              onSubmit={(event) => {
                event.preventDefault();
                if (creating) return;
                setCreating(true);
                setCreateError(null);
                void createAndOpenWorkspace(newName)
                  .then(() => {
                    setNewName(null);
                    setOpen(false);
                  })
                  .catch((err: unknown) => {
                    setCreateError((err as Error).message);
                  })
                  .finally(() => {
                    setCreating(false);
                    void queryClient.invalidateQueries({ queryKey: ["workspace"] });
                  });
              }}
            >
              <label className="block text-ink-cream">
                Workspace name
                <input
                  className="mt-1 w-full rounded border border-ink-rule bg-ink-bg p-1 text-ink-cream"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  required
                  pattern="[a-z0-9][a-z0-9-]{0,31}"
                  maxLength={32}
                  title="1–32 lowercase letters, digits or hyphens; start with a letter or digit"
                  disabled={creating}
                />
              </label>
              {createError && (
                <p role="alert" className="text-ink-cream-2">
                  {createError}
                </p>
              )}
              <button
                type="submit"
                disabled={creating}
                className="text-ink-cream disabled:opacity-50"
              >
                {creating ? "Starting workspace…" : "Create workspace"}
              </button>
              <button
                type="button"
                disabled={creating}
                onClick={() => setNewName(null)}
                className="ml-2 text-ink-faint"
              >
                Cancel
              </button>
            </form>
          )}
          <div className="border-t border-ink-rule mt-1 px-2 py-1.5 text-[10px] text-ink-faint">
            click a stopped workspace to start + open it
          </div>
        </div>
      )}
    </div>
  );
}
