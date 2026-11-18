import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceInfo } from "@oneshot-gtm/shared-types";
import { Check, Circle, Loader2 } from "lucide-react";
import { type Ref, useEffect, useRef, useState } from "react";
import { api } from "../../api/client.ts";
import { openWorkspace } from "../../lib/openWorkspace.ts";
import {
  WORKSPACE_NAME_PATTERN,
  createAndOpenWorkspace,
  servePortCommand,
  type RemoteWorkspaceSetup,
} from "../../lib/createWorkspace.ts";
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

type RosterRow = WorkspaceInfo["workspaces"][number];

/**
 * Where focus goes when the new-workspace form opens or closes: into the name
 * field, then back to the control that opened it. Null leaves focus alone.
 */
export function formFocusTarget(
  formOpen: boolean,
  formWasOpen: boolean,
): "name" | "invoker" | null {
  if (formOpen) return "name";
  return formWasOpen ? "invoker" : null;
}

export interface WorkspacePanelProps {
  roster: RosterRow[];
  /** The workspace a launch is starting, if any. */
  launching: string | null;
  creating: boolean;
  /** The new-workspace form's name; null while the form is closed. */
  draft: string | null;
  createError: string | null;
  /** A workspace created from a member's address, waiting for its port to be served. */
  remoteSetup: RemoteWorkspaceSetup | null;
  nameRef?: Ref<HTMLInputElement>;
  newButtonRef?: Ref<HTMLButtonElement>;
  onRowClick: (row: RosterRow) => void;
  /** Open the form (""), edit its name, or close it (null). */
  onDraft: (draft: string | null) => void;
  onCreate: (name: string) => void;
  onDismissSetup: () => void;
}

/**
 * The switcher's popover: the roster menu, then the new-workspace form. The
 * form is a sibling of the menu, not a child: a `role="menu"` may hold only
 * menu items, and a text field inside one is unreachable to a screen reader's
 * menu navigation. Stateless, so its markup and handlers can be tested.
 */
export function WorkspacePanel(props: WorkspacePanelProps) {
  const { roster, launching, creating, draft, createError, remoteSetup } = props;
  // One operation at a time: a launch already holds a reserved tab.
  const createBlocked = creating || launching !== null;
  return (
    <div
      className={cn(
        "absolute left-0 top-full z-50 mt-1 w-[204px]",
        "rounded-[var(--radius-sm)] border border-ink-rule bg-ink-bg shadow-lg",
        "p-1",
      )}
    >
      <div role="menu" aria-label="Workspaces">
        <div className="ln-eyebrow px-2 pb-1 pt-1.5" style={{ fontSize: 9.5 }}>
          Workspaces
        </div>
        {roster.map((row) => (
          <button
            key={row.name}
            type="button"
            role="menuitem"
            onClick={() => props.onRowClick(row)}
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
        {draft === null && (
          <button
            ref={props.newButtonRef}
            type="button"
            role="menuitem"
            className="w-full px-2 py-1.5 text-left text-xs text-ink-cream hover:bg-ink-surface/80"
            disabled={launching !== null}
            onClick={() => props.onDraft("")}
          >
            New workspace
          </button>
        )}
      </div>
      {draft !== null && (
        <form
          aria-label="New workspace"
          className="border-t border-ink-rule mt-1 p-2 space-y-2 text-xs"
          onSubmit={(event) => {
            event.preventDefault();
            // Enter in the name field submits without the button, so its
            // disabled state is not enough. The draft stays for afterwards.
            if (createBlocked) return;
            props.onCreate(draft);
          }}
        >
          <label className="block text-ink-cream">
            Workspace name
            <input
              ref={props.nameRef}
              className="mt-1 w-full rounded border border-ink-rule bg-ink-bg p-1 text-ink-cream"
              value={draft}
              onChange={(event) => props.onDraft(event.target.value)}
              required
              pattern={WORKSPACE_NAME_PATTERN}
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
            disabled={createBlocked}
            className="text-ink-cream disabled:opacity-50"
          >
            {creating ? "Starting workspace…" : "Create workspace"}
          </button>
          <button
            type="button"
            disabled={creating}
            onClick={() => props.onDraft(null)}
            className="ml-2 text-ink-faint"
          >
            Cancel
          </button>
        </form>
      )}
      {remoteSetup && (
        <div
          role="status"
          className="border-t border-ink-rule mt-1 p-2 space-y-2 text-xs text-ink-cream"
        >
          <p>
            {remoteSetup.running === null
              ? `Workspace ${remoteSetup.name} was created on port ${remoteSetup.port}. Checking that it answers…`
              : remoteSetup.running
                ? `Workspace ${remoteSetup.name} is running on port ${remoteSetup.port}.`
                : `Workspace ${remoteSetup.name} was created on port ${remoteSetup.port} but is not answering yet. Start it from the list above.`}
          </p>
          <p className="text-ink-cream-2">
            It opens from this address once the host operator serves that port on the host machine:
          </p>
          <code className="block break-all font-mono text-[10.5px]">
            {servePortCommand(remoteSetup.port)}
          </code>
          <a href={remoteSetup.url} target="_blank" rel="noreferrer" className="underline">
            Open {remoteSetup.name}
          </a>
          {/* The settled check shows the step again, so it is dismissable only then. */}
          {remoteSetup.running !== null && (
            <button type="button" onClick={props.onDismissSetup} className="ml-2 text-ink-faint">
              Dismiss
            </button>
          )}
        </div>
      )}
      <div className="border-t border-ink-rule mt-1 px-2 py-1.5 text-[10px] text-ink-faint">
        click a stopped workspace to start + open it
      </div>
    </div>
  );
}

export function WorkspaceSwitcher() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [launching, setLaunching] = useState<string | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [remoteSetup, setRemoteSetup] = useState<RemoteWorkspaceSetup | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const formWasOpen = useRef(false);

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
      if (e.key !== "Escape") return;
      // The panel unmounts under the focused control, so the chip takes focus.
      // An outside click does not: its target keeps the focus it took.
      if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Opening the form unmounts the button that was focused: move focus into
  // the name field, and back to that button when the form closes. `open` is a
  // dependency so a popover reopened on a kept draft focuses the field again.
  const formOpen = newName !== null;
  // New workspace is disabled during a launch and a disabled button cannot
  // take focus; the chip always can.
  const focusOpener = () => {
    const button = newButtonRef.current;
    (button && !button.disabled ? button : triggerRef.current)?.focus();
  };
  useEffect(() => {
    const target = formFocusTarget(formOpen, formWasOpen.current);
    if (target === "name") nameRef.current?.focus();
    if (target === "invoker") focusOpener();
    formWasOpen.current = formOpen;
  }, [formOpen, open]);

  const current = ws.data?.current;
  const roster = ws.data?.workspaces ?? [];

  const onRowClick = async (row: (typeof roster)[number]) => {
    // The row being started stays clickable. A second launch of it would
    // settle on its own and unblock creation while the other still runs.
    if (launching !== null) return;
    if (row.isCurrent || row.running) setOpen(false);
    await openWorkspace(row, {
      onLaunchStart: () => setLaunching(row.name),
      onSettled: () => {
        setLaunching(null);
        void queryClient.invalidateQueries({ queryKey: ["workspace"] });
      },
    });
  };

  const onCreate = (name: string) => {
    setCreating(true);
    setCreateError(null);
    // A member sees the port and serve step while the new server is still checked.
    void createAndOpenWorkspace(name, setRemoteSetup)
      .then((setup) => {
        setNewName(null);
        // A member's address: keep the popover open on the setup step.
        if (setup) setRemoteSetup(setup);
        else setOpen(false);
      })
      .catch((err: unknown) => {
        setCreateError((err as Error).message);
      })
      .finally(() => {
        setCreating(false);
        void queryClient.invalidateQueries({ queryKey: ["workspace"] });
      });
  };

  return (
    <div ref={rootRef} className="relative mt-1.5">
      <button
        ref={triggerRef}
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
        <WorkspacePanel
          roster={roster}
          launching={launching}
          creating={creating}
          draft={newName}
          createError={createError}
          remoteSetup={remoteSetup}
          nameRef={nameRef}
          newButtonRef={newButtonRef}
          onRowClick={(row) => void onRowClick(row)}
          onDraft={(draft) => {
            // Opening the form starts a new attempt: drop the last one's messages.
            if (newName === null && draft !== null) {
              setCreateError(null);
              setRemoteSetup(null);
            }
            setNewName(draft);
          }}
          onCreate={onCreate}
          onDismissSetup={() => {
            // Dismiss unmounts under its own focus.
            focusOpener();
            setRemoteSetup(null);
          }}
        />
      )}
    </div>
  );
}
