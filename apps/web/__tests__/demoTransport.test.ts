import { afterEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("../src/api/demo.ts", () => ({
  IS_DEMO: true,
  demoGet: fixtures.read,
  demoWrite: (path: string) => {
    fixtures.write(path);
    throw new Error("Read-only demo");
  },
}));

const { getJson } = await import("../src/api/client.ts");
const { mailAction } = await import("../src/components/DirectMailPanel.tsx");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("direct mail demo transport", () => {
  it("reads saved return-address and history data without contacting an API", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const snapshot = { returnAddress: null, drafts: [] };
    fixtures.read.mockResolvedValue(snapshot);
    expect(await getJson("/direct-mail")).toEqual(snapshot);
    expect(fixtures.read).toHaveBeenCalledWith("/direct-mail");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses mail mutations at the transport even when called outside disabled controls", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(mailAction("return-address", { address: {} })).rejects.toThrow("Read-only demo");
    await expect(mailAction("send", { id: "demo" })).rejects.toThrow("Read-only demo");
    expect(fixtures.write).toHaveBeenCalledWith("/direct-mail/send");
    expect(fetch).not.toHaveBeenCalled();
  });
});
