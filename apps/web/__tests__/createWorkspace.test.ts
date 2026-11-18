import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), roster: vi.fn(), warning: vi.fn() }));
vi.mock("../src/api/client.ts", () => ({
  api: { workspaceCreate: mocks.create, workspaceWithin: mocks.roster },
}));
vi.mock("sonner", () => ({ toast: { warning: mocks.warning } }));
const { createAndOpenWorkspace, isLoopbackHost, servePortCommand } =
  await import("../src/lib/createWorkspace.ts");
/** The roster as the server reports the new workspace's row. */
const roster = (row: { port?: number; running?: boolean; verified?: boolean }) => ({
  workspaces: [{ name: "acme", port: 4031, running: false, verified: false, ...row }],
});
const browseFrom = (href: string) => vi.stubGlobal("window", { open, location: { href, assign } });
const win = { location: { href: "" }, close: vi.fn(), closed: false, opener: {} as unknown };
const open = vi.fn(() => win);
const assign = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  win.location.href = "";
  open.mockReturnValue(win);
  browseFrom("http://localhost:3030/queue?filter=x#top");
  mocks.create.mockResolvedValue({ name: "acme", port: 4031, persistent: true, warning: null });
  mocks.roster.mockResolvedValue(roster({}));
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
    mocks.roster.mockResolvedValue(roster({ running: true, verified: true }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await promise).toBeNull();
    expect(win.location.href).toBe("http://localhost:4031/");
    expect(win.opener).toBeNull();
  });

  it.each([
    ["an older build or unnamed server holds the port", { running: true, verified: false }],
    [
      "this dashboard shares the name on its own port",
      { port: 3030, running: true, verified: true },
    ],
  ])("does not open the workspace when %s", async (_case, row) => {
    mocks.roster.mockResolvedValue(roster(row));
    const result = expect(createAndOpenWorkspace("acme")).rejects.toThrow(
      "was created but is not answering yet",
    );
    await vi.runAllTimersAsync();
    await result;
    expect(win.location.href).toBe("");
    expect(assign).not.toHaveBeenCalled();
  });

  it("on a member's address reserves no tab and returns the port to serve instead of opening it", async () => {
    browseFrom("https://host.tailnet.ts.net:3030/queue?filter=x#top");
    mocks.roster.mockResolvedValue(roster({ running: true, verified: true }));
    expect(await createAndOpenWorkspace("acme")).toEqual({
      name: "acme",
      port: 4031,
      // The host the member browses to is kept; only the port changes.
      url: "https://host.tailnet.ts.net:4031/",
    });
    expect(open).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(servePortCommand(4031)).toBe("tailscale serve --bg --https=4031 http://127.0.0.1:4031");
  });

  it("treats only the host machine's own addresses as local", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "app.localhost"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["host.tailnet.ts.net", "dashboard.local", "100.64.0.7"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  it("shows the reboot warning and navigates in the current tab if popups are blocked", async () => {
    open.mockReturnValue(null as never);
    mocks.create.mockResolvedValue({
      name: "acme",
      port: 4031,
      persistent: false,
      warning: "This server won't survive a reboot.",
    });
    mocks.roster.mockResolvedValue(roster({ running: true, verified: true }));
    await createAndOpenWorkspace("acme");
    expect(mocks.warning).toHaveBeenCalledWith("This server won't survive a reboot.", {
      duration: Infinity,
    });
    expect(assign).toHaveBeenCalledWith("http://localhost:4031/");
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

  it("ends a roster request that never answers at the startup deadline", async () => {
    // Pending until its signal aborts, as a stalled fetch is.
    mocks.roster.mockImplementation(
      (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const result = expect(createAndOpenWorkspace("acme")).rejects.toThrow(
      "was created but is not answering yet",
    );
    await vi.advanceTimersByTimeAsync(149_999);
    expect(win.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(mocks.roster).toHaveBeenCalledOnce();
    expect(win.close).toHaveBeenCalledOnce();
  });

  it("still reports a roster failure that is not the deadline", async () => {
    mocks.roster.mockRejectedValue(new Error("500 Internal Server Error: /workspace"));
    await expect(createAndOpenWorkspace("acme")).rejects.toThrow("500 Internal Server Error");
    expect(win.close).toHaveBeenCalledOnce();
  });
});
