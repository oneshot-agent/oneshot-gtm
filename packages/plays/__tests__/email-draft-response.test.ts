import { afterEach, describe, expect, it, vi } from "vitest";
const completeMock = vi.hoisted(() => vi.fn());
vi.mock("@oneshot-gtm/intel", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel")),
  complete: completeMock,
}));
const { draftEmailFromPrompt } = await import("../src/_lib.ts");
const opts = { promptName: "luma-events-email", inputBlock: "A developer hosting a meetup" };
afterEach(() => completeMock.mockReset());

describe("email draft response validation", () => {
  it("accepts a fenced draft without retrying", async () => {
    completeMock.mockResolvedValue({
      content: '```json\n{"subject":"meetup","body":"A useful question?"}\n```',
    });
    expect(await draftEmailFromPrompt(opts)).toEqual({
      subject: "meetup",
      body: "A useful question?",
    });
    expect(completeMock).toHaveBeenCalledTimes(1);
  });
  it.each([
    "not JSON",
    "null",
    "[]",
    "{}",
    '{"subject":123,"body":"text"}',
    '{"subject":"😀","body":"text"}',
    '{"subject":"hello","body":"😀"}',
    '{"subject":"hello","body":"  "}',
  ])("retries invalid response %s once", async (content) => {
    completeMock
      .mockResolvedValueOnce({ content })
      .mockResolvedValueOnce({ content: '{"subject":"meetup","body":"A useful question?"}' });
    expect((await draftEmailFromPrompt(opts)).subject).toBe("meetup");
    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(completeMock.mock.calls[1]![0].messages.at(-1).content).toContain("valid JSON object");
  });
  it("throws a generation error after two invalid responses instead of returning a blank draft", async () => {
    completeMock.mockResolvedValue({ content: '{"email":"unusable format"}' });
    await expect(draftEmailFromPrompt(opts)).rejects.toThrow("Draft generation failed");
    expect(completeMock).toHaveBeenCalledTimes(2);
  });
  it("does not add a retry for transport errors", async () => {
    completeMock.mockRejectedValue(new Error("Provider unavailable"));
    await expect(draftEmailFromPrompt(opts)).rejects.toThrow("Provider unavailable");
    expect(completeMock).toHaveBeenCalledTimes(1);
  });
});
