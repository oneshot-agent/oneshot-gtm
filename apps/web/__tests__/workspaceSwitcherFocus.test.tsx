// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The switcher mounted in a DOM: where focus really lands when the
// new-workspace form opens, reopens on a kept draft, and closes. This is the
// one suite that needs a document, so the environment is set for this file only.

const mocks = vi.hoisted(() => ({ workspace: vi.fn(), launch: vi.fn(), create: vi.fn() }));
vi.mock("../src/api/client.ts", () => ({
  api: { workspace: mocks.workspace, workspaceLaunch: mocks.launch },
}));
vi.mock("../src/lib/createWorkspace.ts", async (actual) => ({
  ...(await actual<typeof import("../src/lib/createWorkspace.ts")>()),
  createAndOpenWorkspace: mocks.create,
}));
const { WorkspaceSwitcher } = await import("../src/components/shell/WorkspaceSwitcher.tsx");

const row = (name: string, port: number, isCurrent: boolean) => ({
  name,
  home: `/h/${name}`,
  port,
  isCurrent,
  isDefault: isCurrent,
  running: isCurrent,
  verified: isCurrent,
});
const info = {
  current: row("default", 3030, true),
  workspaces: [row("default", 3030, true), row("alpha", 3031, false)],
};

let root: Root;
let host: HTMLElement;

const chip = () => host.querySelector<HTMLButtonElement>('button[aria-label="switch workspace"]')!;
const nameField = () =>
  host.querySelector<HTMLInputElement>('form[aria-label="New workspace"] input');
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((el) => el.textContent === label) ?? null;
const alphaRow = () =>
  [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((el) =>
    el.textContent.startsWith("alpha"),
  )!;
/** Click the stopped workspace's row; its launch stays pending until the returned call. */
const startAlpha = async () => {
  let settle!: (answer: { status: "already-running"; port: number }) => void;
  mocks.launch.mockReturnValue(new Promise((resolve) => (settle = resolve)));
  await press(alphaRow());
  return () => act(async () => settle({ status: "already-running", port: 3031 }));
};

/** A click as the browser makes it: the button takes focus, then fires. */
const press = (el: HTMLElement) =>
  act(async () => {
    el.focus();
    el.click();
  });

/** Type into the controlled field: React reads the change from the input event. */
const type = (field: HTMLInputElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.workspace.mockResolvedValue(info);
  // A launch reserves a tab; none opens here.
  vi.spyOn(window, "open").mockReturnValue(null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <WorkspaceSwitcher />
      </QueryClientProvider>,
    );
  });
  await press(chip());
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("workspace switcher focus", () => {
  it("focuses the name field when New workspace opens the form", async () => {
    expect(host.querySelector('[role="menu"]')!.textContent).toContain("alpha");
    expect(nameField()).toBeNull();

    await press(button("New workspace")!);

    expect(nameField()).not.toBeNull();
    expect(document.activeElement).toBe(nameField());
    // The form is outside the menu, wherever the menu's markup ends.
    expect(nameField()!.closest("form")!.closest('[role="menu"]')).toBeNull();
  });

  it("focuses the name field again when the popover reopens on a kept draft", async () => {
    await press(button("New workspace")!);
    await type(nameField()!, "acme");
    // Escape closes the popover and keeps the draft.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(nameField()).toBeNull();
    // The field it left is gone: the chip holds focus, not the page.
    expect(document.activeElement).toBe(chip());

    await press(chip());

    expect(nameField()!.value).toBe("acme");
    expect(document.activeElement).toBe(nameField());
  });

  it("returns focus to New workspace when the form is cancelled", async () => {
    await press(button("New workspace")!);
    expect(button("New workspace")).toBeNull();

    await press(button("Cancel")!);

    expect(nameField()).toBeNull();
    expect(button("New workspace")).not.toBeNull();
    expect(document.activeElement).toBe(button("New workspace"));
  });

  it("starts a workspace once however often its row is clicked, and blocks create until it settles", async () => {
    const settle = await startAlpha();
    await press(alphaRow());

    expect(mocks.launch).toHaveBeenCalledOnce();
    expect(button("New workspace")!.disabled).toBe(true);

    await settle();
    expect(button("New workspace")!.disabled).toBe(false);
  });
});
