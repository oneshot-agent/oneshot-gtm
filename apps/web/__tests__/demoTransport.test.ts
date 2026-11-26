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

const { getJson, api } = await import("../src/api/client.ts");
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

it("reads a saved call brief but refuses regeneration and dialing", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  fixtures.read.mockResolvedValue({ brief: { opener: "Saved" } });
  expect(await api.callBrief(7, { playName: "show-hn" })).toEqual({ brief: { opener: "Saved" } });
  expect(fixtures.read).toHaveBeenCalledWith("/calls/brief?prospectId=7&playName=show-hn");
  await expect(api.callBrief(7, { regenerate: true })).rejects.toThrow("Read-only demo");
  await expect(api.startCall({ prospectId: 7 })).rejects.toThrow("Read-only demo");
  expect(fetch).not.toHaveBeenCalled();
});
