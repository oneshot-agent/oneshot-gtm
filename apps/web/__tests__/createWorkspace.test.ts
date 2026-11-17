import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), roster: vi.fn(), warning: vi.fn() }));
vi.mock("../src/api/client.ts", () => ({
  api: { workspaceCreate: mocks.create, workspace: mocks.roster },
}));
vi.mock("sonner", () => ({ toast: { warning: mocks.warning } }));
const { createAndOpenWorkspace } = await import("../src/lib/createWorkspace.ts");
const win = { location: { href: "" }, close: vi.fn(), closed: false, opener: {} as unknown };
const open = vi.fn(() => win);
const assign = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  win.location.href = "";
  open.mockReturnValue(win);
  vi.stubGlobal("window", {
    open,
    location: { href: "http://dashboard.local:3030/queue?filter=x#top", assign },
  });
  mocks.create.mockResolvedValue({ name: "acme", port: 3031, persistent: true, warning: null });
  mocks.roster.mockResolvedValue({ workspaces: [{ name: "acme", running: false }] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("new workspace navigation", () => {
  it("reserves a tab on submit and opens the returned workspace only after its health probe succeeds", async () => {
    const promise = createAndOpenWorkspace("acme");
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(mocks.create).toHaveBeenCalledWith("acme");
    await vi.advanceTimersByTimeAsync(1000);
    expect(win.location.href).toBe("");
    mocks.roster.mockResolvedValue({ workspaces: [{ name: "acme", running: true }] });
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    expect(win.location.href).toBe("http://dashboard.local:3031/");
    expect(win.opener).toBeNull();
  });

  it("shows the reboot warning and navigates in the current tab if popups are blocked", async () => {
    open.mockReturnValue(null as never);
    mocks.create.mockResolvedValue({
      name: "acme",
      port: 3031,
      persistent: false,
      warning: "This server won't survive a reboot.",
    });
    mocks.roster.mockResolvedValue({ workspaces: [{ name: "acme", running: true }] });
    await createAndOpenWorkspace("acme");
    expect(mocks.warning).toHaveBeenCalledWith("This server won't survive a reboot.", {
      duration: Infinity,
    });
    expect(assign).toHaveBeenCalledWith("http://dashboard.local:3031/");
  });

  it("closes the reserved tab and reports rejected creation", async () => {
    mocks.create.mockRejectedValue(new Error("already exists"));
    await expect(createAndOpenWorkspace("acme")).rejects.toThrow("already exists");
    expect(win.close).toHaveBeenCalledOnce();
    expect(mocks.roster).not.toHaveBeenCalled();
  });

  it("reports a startup timeout without creating the workspace a second time", async () => {
    const result = expect(createAndOpenWorkspace("acme")).rejects.toThrow(
      "was created but is not answering yet",
    );
    await vi.runAllTimersAsync();
    await result;
    expect(win.close).toHaveBeenCalledOnce();
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(win.location.href).toBe("");
  });
});
