import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The reject-box fallback: one small isolated call that never throws, never
// runs without an ICP, respects the model's null, and can never hand a human
// the machine-decision prefix.

let icpOneLiner: string | null = "founders who own their own customer acquisition";
const completeMock = vi.fn();
const logMock = vi.fn();

vi.mock("@oneshot-gtm/core", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/core")>("@oneshot-gtm/core");
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), icpOneLiner }),
    logEvent: logMock,
  };
});
vi.mock("@oneshot-gtm/intel", async () => {
  const actual = await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel");
  return { ...actual, loadPrompt: () => "system", complete: completeMock };
});

const { generateRejectReason } = await import("../src/_reject-reason.ts");

const payload = { company: "Acme", title: "Recruiter", productOneLiner: "Staffing for clinics" };

beforeEach(() => {
  icpOneLiner = "founders who own their own customer acquisition";
  completeMock.mockReset();
  logMock.mockReset();
  completeMock.mockResolvedValue({
    content: JSON.stringify({
      rejectReason: " Recruiter, not the person who buys outbound tooling. ",
    }),
    provider: "t",
    model: "t",
  });
});
afterEach(() => vi.restoreAllMocks());

describe("generateRejectReason", () => {
  it("returns the normalized sentence and logs it", async () => {
    const reason = await generateRejectReason({ playName: "luma-events", payload });
    expect(reason).toBe("Recruiter, not the person who buys outbound tooling.");
    expect(completeMock).toHaveBeenCalledTimes(1);
    const user = completeMock.mock.calls[0]![0].messages[1].content as string;
    expect(user).toContain("ICP: founders who own");
    expect(user).toContain("PLAY: luma-events");
    expect(logMock).toHaveBeenCalledWith(
      "reject_reason.generated",
      expect.objectContaining({ play: "luma-events" }),
    );
  });

  it("makes no call without an ICP", async () => {
    icpOneLiner = "";
    expect(await generateRejectReason({ playName: "show-hn", payload })).toBeNull();
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("respects the model's null — no mismatch means an empty box, not an invented one", async () => {
    completeMock.mockResolvedValue({ content: '{"rejectReason":null}', provider: "t", model: "t" });
    expect(await generateRejectReason({ playName: "show-hn", payload })).toBeNull();
    expect(logMock).not.toHaveBeenCalledWith("reject_reason.generated", expect.anything());
  });

  it("never returns the machine-decision prefix, whatever the model says", async () => {
    completeMock.mockResolvedValue({
      content: '{"rejectReason":"auto: role — recruiter"}',
      provider: "t",
      model: "t",
    });
    expect(await generateRejectReason({ playName: "show-hn", payload })).toBeNull();
  });

  it("swallows a provider failure and logs it", async () => {
    completeMock.mockRejectedValue(new Error("upstream 503"));
    expect(await generateRejectReason({ playName: "show-hn", payload })).toBeNull();
    expect(logMock).toHaveBeenCalledWith(
      "error.swallowed",
      expect.objectContaining({ kind: "reject-reason", message_120: "upstream 503" }),
      "warn",
    );
  });
});
