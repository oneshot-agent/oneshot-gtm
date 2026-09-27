import { beforeEach, describe, expect, it, vi } from "vitest";

let modelDm = "hosting gtm in git on thursday — curious how your team reviews outbound today?";
const inputs: string[] = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ founderName: "Founder", productOneLiner: "a GTM workspace" }),
  };
});
vi.mock("@oneshot-gtm/intel", () => ({
  loadPrompt: () => "x dm prompt",
  complete: async (input: { messages: Array<{ content: string }> }) => {
    inputs.push(input.messages[1]!.content);
    return { content: modelDm };
  },
}));

const { draftXDm, xHandleOf } = await import("../src/_x-first-touch.ts");

const row = (payload: Record<string, unknown> = {}) => ({
  id: 3,
  playName: "luma-events",
  payload: {
    name: "Dana Lee",
    twitterUrl: "https://x.com/dana_lee",
    eventTitle: "GTM in git",
    role: "Host",
    ...payload,
  },
  notes: null,
});

beforeEach(() => {
  modelDm = "hosting gtm in git on thursday — curious how your team reviews outbound today?";
  inputs.length = 0;
});

describe("draftXDm", () => {
  it("drafts from the row's signal, addressed to the handle", async () => {
    const dm = await draftXDm(row());
    expect(dm).toMatchObject({ subject: "X DM → @dana_lee", flags: [] });
    expect(inputs[0]).toContain("X: @dana_lee");
    expect(inputs[0]).toContain("EVENT: GTM in git (hosting)");
    expect(inputs[0]).toContain("MAX_CHARS: 280");
  });

  it("flags an over-long DM and a row with no handle", async () => {
    modelDm = "x".repeat(300);
    const dm = await draftXDm(row({ twitterUrl: undefined }));
    expect(dm.flags).toEqual(["dm-too-long: 300/280 characters", "no-x: this row has no X handle"]);
  });

  it("prefers the row's handle over its profile URL", () => {
    expect(xHandleOf({ handle: "@other", twitterUrl: "https://x.com/dana_lee" })).toBe("other");
  });
});
