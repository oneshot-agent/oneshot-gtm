// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSwitcher } from "../src/components/shell/WorkspaceSwitcher.tsx";

// The switcher on a member's address, with the real create flow and API client
// over a stubbed transport: what the member sees between the create answer and
// the readiness check, and after the check settles either way.

const SERVE = "tailscale serve --bg --https=4031 http://127.0.0.1:4031";
const row = (name: string, port: number, up: boolean) => ({
  name,
  home: `/h/${name}`,
  port,
  isCurrent: name === "default",
  isDefault: name === "default",
  running: up,
  verified: up,
});
const info = { current: row("default", 3030, true), workspaces: [row("default", 3030, true)] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let root: Root;
let host: HTMLElement;
/** Answers the readiness check's roster request, held until then. */
let releaseRoster: ((res: Response) => void) | undefined;

const status = () => host.querySelector('[role="status"]');
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((el) => el.textContent === label) ?? null;
const press = (el: HTMLElement) =>
  act(async () => {
    el.focus();
    el.click();
  });
/**
 * Run `step`, then wait for `reached`. React renders when an act scope exits,
 * so the wait is a series of short scopes, not one long one.
 */
const until = async (reached: () => void, step: () => void = () => {}) => {
  await act(async () => step());
  await vi.waitFor(async () => {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    reached();
  });
};

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
    "https://host.tailnet.ts.net:3030/queue",
  );
  vi.spyOn(window, "open");
  releaseRoster = undefined;
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    if (path === "/api/workspaces" && init?.method === "POST") {
      return json({ name: "acme", port: 4031, persistent: true, warning: null });
    }
    if (path !== "/api/workspace") throw new Error(`unexpected request: ${path}`);
    // Only the readiness check carries a signal; the switcher's own roster query has none.
    if (!init?.signal) return json(info);
    return new Promise<Response>((resolve) => (releaseRoster = resolve));
  });
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
  await press(host.querySelector<HTMLButtonElement>('button[aria-label="switch workspace"]')!);
  await press(button("New workspace")!);
  const field = host.querySelector<HTMLInputElement>('form[aria-label="New workspace"] input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "acme");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await press(button("Create workspace")!);
  // Created, and the readiness check's roster request is now held.
  await until(() => expect(releaseRoster).toBeDefined());
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a member's new workspace in the mounted switcher", () => {
  it("shows the port and serve step while the readiness check is pending, and keeps them when it fails", async () => {
    expect(status()!.textContent).toContain("Workspace acme was created on port 4031.");
    expect(status()!.textContent).toContain(SERVE);
    expect(status()!.textContent).not.toContain("is running");
    expect(status()!.querySelector("a")!.href).toBe("https://host.tailnet.ts.net:4031/");

    await until(
      () => expect(status()!.textContent).toContain("is not answering yet"),
      () => releaseRoster!(new Response("boom", { status: 500 })),
    );

    expect(status()!.textContent).toContain("port 4031");
    expect(status()!.textContent).toContain(SERVE);
    expect(status()!.textContent).not.toContain("is running");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(window.open).not.toHaveBeenCalled();
  });

  it("says the workspace is running only once its own server is verified on the port", async () => {
    expect(status()!.textContent).not.toContain("is running");

    const acme = row("acme", 4031, true);
    await until(
      () => expect(status()!.textContent).toContain("Workspace acme is running on port 4031."),
      () => releaseRoster!(json({ ...info, workspaces: [...info.workspaces, acme] })),
    );

    expect(status()!.textContent).toContain(SERVE);
    expect(button("Dismiss")).not.toBeNull();
  });
});
