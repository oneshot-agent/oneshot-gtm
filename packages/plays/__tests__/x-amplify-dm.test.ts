import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { XAmplifyDmTarget } from "../src/x-amplify-dm.ts";

// The whole mechanism of the manual play: `sent` is ALWAYS false, so drain
// persists the draft and the row stays visible for the hand-send + Mark sent
// flow. A true here would silently flip rows to sent with nothing dispatched.

let completeImpl: (input: unknown) => Promise<{ content: string }> = async () => ({
  content: "hand-typed dm text",
});
const completeInputs: Array<{ messages: Array<{ role: string; content: string }> }> = [];

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ founderName: "Founder", productOneLiner: "an MIT GTM agent" }),
    logEvent: () => {},
  };
});
vi.mock("@oneshot-gtm/intel", () => ({
  loadPrompt: () => "dm system prompt",
  complete: async (input: { messages: Array<{ role: string; content: string }> }) => {
    completeInputs.push(input);
    return completeImpl(input);
  },
}));

const { runXAmplifyDm, MANUAL_PLAYS } = await import("../src/x-amplify-dm.ts");

function target(over: Partial<XAmplifyDmTarget> = {}): XAmplifyDmTarget {
  return {
    name: "Some One",
    handle: "someone",
    twitterUrl: "https://x.com/someone",
    dmOpen: true,
    engine: "xapi",
    seedHandle: "iamdevloper",
    tweetUrl: "https://x.com/iamdevloper/status/1",
    tweetText: "a tweet",
    mode: "retweet",
    ...over,
  };
}

beforeEach(() => {
  completeImpl = async () => ({ content: "hand-typed dm text" });
  completeInputs.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe("runXAmplifyDm", () => {
  it("drafts DM text and NEVER marks it sent", async () => {
    const { drafted } = await runXAmplifyDm({ dryRun: false, targets: [target()] });
    expect(drafted).toHaveLength(1);
    expect(drafted[0]!.sent).toBe(false);
    expect(drafted[0]!.receiptIds).toEqual([]);
    expect(drafted[0]!.body).toBe("hand-typed dm text");
    expect(drafted[0]!.subject).toBe("X DM → @someone");
  });

  it("labels closed-DM targets as replies and tells the prompt so", async () => {
    const { drafted } = await runXAmplifyDm({
      dryRun: false,
      targets: [target({ dmOpen: false })],
    });
    expect(drafted[0]!.subject).toBe("X reply → @someone");
    expect(completeInputs[0]!.messages[1]!.content).toContain("reply to post under their repost");
  });

  it("passes the launch date through and omits the line when absent", async () => {
    await runXAmplifyDm({ dryRun: false, targets: [target({ launchDate: "2026-09-23" })] });
    expect(completeInputs[0]!.messages[1]!.content).toContain("LAUNCH_DATE: 2026-09-23");
    completeInputs.length = 0;
    await runXAmplifyDm({ dryRun: false, targets: [target()] });
    expect(completeInputs[0]!.messages[1]!.content).not.toContain("LAUNCH_DATE");
  });

  it("a per-target failure comes back as an errorDraft, still unsent", async () => {
    completeImpl = async () => {
      throw new Error("provider down");
    };
    const { drafted } = await runXAmplifyDm({ dryRun: false, targets: [target()] });
    expect(drafted[0]!.sent).toBe(false);
    expect(drafted[0]!.flags[0]).toMatch(/error: provider down/);
  });

  it("registers itself as the manual X play", () => {
    expect(MANUAL_PLAYS["x-amplify-dm"]).toEqual({ channel: "x" });
  });
});
