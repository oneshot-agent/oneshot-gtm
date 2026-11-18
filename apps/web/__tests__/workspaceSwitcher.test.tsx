import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  WorkspacePanel,
  formFocusTarget,
  type WorkspacePanelProps,
} from "../src/components/shell/WorkspaceSwitcher.tsx";

// The switcher's popover is stateless, so a static render pins its markup and
// its handlers can be called as the browser would. No DOM here: this file pins
// the decision `formFocusTarget` makes, and workspaceSwitcherFocus.test.tsx
// mounts the switcher to check where focus actually lands.

const row = (name: string, port: number, running: boolean) => ({
  name,
  home: `/h/${name}`,
  port,
  isCurrent: name === "default",
  isDefault: name === "default",
  running,
  verified: running,
});

const props = (over: Partial<WorkspacePanelProps> = {}): WorkspacePanelProps => ({
  roster: [row("default", 3030, true), row("alpha", 3031, false)],
  launching: null,
  creating: false,
  draft: null,
  createError: null,
  remoteSetup: null,
  onRowClick: () => {},
  onDraft: () => {},
  onCreate: () => {},
  onDismissSetup: () => {},
  ...over,
});

/** The first element of `type` in what the panel returns, without rendering it. */
function find(node: ReactNode, type: string): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child as ReactNode, type);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return null;
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.type === type) return el;
  return find(el.props["children"] as ReactNode, type);
}

const submit = (over: Partial<WorkspacePanelProps>) => {
  const onCreate = vi.fn();
  const form = find(WorkspacePanel(props({ ...over, onCreate })), "form")!;
  const preventDefault = vi.fn();
  (form.props["onSubmit"] as (event: unknown) => void)({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  return onCreate;
};

describe("workspace switcher panel", () => {
  it("keeps the new-workspace form out of the menu, which holds only menu items", () => {
    const html = renderToStaticMarkup(<WorkspacePanel {...props({ draft: "acme" })} />);
    const menu = /<div role="menu"[^>]*>[\s\S]*?<\/div>(?=<form)/.exec(html);
    expect(menu).not.toBeNull();
    expect(menu![0]).toContain("alpha");
    expect(menu![0]).not.toContain("<input");
    expect(html).toMatch(/<form aria-label="New workspace"/);
    // The roster's own entries are the menu's items.
    expect(menu![0].match(/role="menuitem"/g)).toHaveLength(2);
  });

  it("moves focus into the name field on open and back to the opener on close", () => {
    expect(formFocusTarget(true, false)).toBe("name");
    // A popover reopened on a kept draft focuses the field again.
    expect(formFocusTarget(true, true)).toBe("name");
    expect(formFocusTarget(false, true)).toBe("invoker");
    expect(formFocusTarget(false, false)).toBeNull();
  });

  it("blocks create while a workspace is launching and keeps the draft", () => {
    const launching = props({ draft: "acme", launching: "alpha" });
    const html = renderToStaticMarkup(<WorkspacePanel {...launching} />);
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*>Create workspace/);
    expect(html).toMatch(/<input[^>]*value="acme"/);
    // Enter in the field submits without the button: the handler refuses too.
    expect(submit({ draft: "acme", launching: "alpha" })).not.toHaveBeenCalled();
    expect(submit({ draft: "acme", creating: true })).not.toHaveBeenCalled();

    const idle = renderToStaticMarkup(<WorkspacePanel {...props({ draft: "acme" })} />);
    expect(idle).toMatch(/<button type="submit" class[^>]*>Create workspace/);
    expect(submit({ draft: "acme" })).toHaveBeenCalledWith("acme");
  });

  it("shows a member the assigned port and the host's serve step before the link", () => {
    const html = renderToStaticMarkup(
      <WorkspacePanel
        {...props({
          remoteSetup: { name: "acme", port: 4031, url: "https://host.tailnet.ts.net:4031/" },
        })}
      />,
    );
    const port = html.indexOf("Workspace acme is running on port 4031.");
    const step = html.indexOf("tailscale serve --bg --https=4031 http://127.0.0.1:4031");
    const link = html.indexOf('href="https://host.tailnet.ts.net:4031/"');
    expect(port).toBeGreaterThan(-1);
    expect(step).toBeGreaterThan(port);
    expect(link).toBeGreaterThan(step);
    expect(html).toContain("host operator");
  });
});
