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

const { generateRejectReason, describeCompanyForReject, describeDossierForReject } =
  await import("../src/_reject-reason.ts");

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

describe("reject evidence", () => {
  it("renders the company facts a stage judgment turns on, in a fixed order", () => {
    expect(
      describeCompanyForReject({
        name: "Magna",
        industry: "Insurance",
        founded_year: 2014,
        employee_count: 80,
        funding_stage: "series_b",
        description: "AI-native insurance for startups.",
        linkedin_url: "https://linkedin.com/company/magna",
      }),
    ).toBe(
      [
        "company: Magna",
        "industry: Insurance",
        "founded: 2014",
        "employees: 80",
        "funding stage: series_b",
        "description: AI-native insurance for startups.",
      ].join("\n"),
    );
    expect(describeCompanyForReject(null)).toBe("");
  });

  it("turns a person-research dossier into facts, keeping the experience periods", () => {
    const dossier = JSON.stringify({
      status: "completed",
      result: {
        full_name: "Bruno F",
        title: "Co-Founder & CEO",
        company: "Magna",
        summary: "Building insurance infrastructure.",
        experience: [
          { title: "Co-Founder & CEO", company: "Magna", period: "Jan 2014 - Present" },
          { title: "Engineer", company: "Big Co", period: "2010 - 2013" },
        ],
        emails: ["bruno@magna.so"],
      },
    });
    const text = describeDossierForReject(dossier);
    expect(text).toContain("title: Co-Founder & CEO");
    expect(text).toContain(
      "experience: Co-Founder & CEO at Magna (Jan 2014 - Present); Engineer at Big Co (2010 - 2013)",
    );
    expect(text).not.toContain("bruno@magna.so");
  });

  it("passes plain-text research through, bounded", () => {
    expect(describeDossierForReject("  Runs a   ten-year-old agency.  ")).toBe(
      "Runs a ten-year-old agency.",
    );
    expect(describeDossierForReject("x".repeat(5000)).length).toBe(2500);
    expect(describeDossierForReject("")).toBe("");
  });

  it("puts COMPANY and DOSSIER blocks in front of the model", async () => {
    await generateRejectReason({
      playName: "luma-events",
      payload,
      dossier: JSON.stringify({ result: { title: "CEO", company: "Magna" } }),
      company: { name: "Magna", employee_count: 80 },
    });
    const user = completeMock.mock.calls[0]![0].messages[1].content as string;
    expect(user).toContain("COMPANY:\ncompany: Magna\nemployees: 80");
    expect(user).toContain("DOSSIER:\ntitle: CEO\ncompany: Magna");
  });
});
