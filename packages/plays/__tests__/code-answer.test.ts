import { beforeEach, describe, expect, it, vi } from "vitest";
const complete = vi.fn();
vi.mock("@oneshot-gtm/intel", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel")),
  complete: (...args: unknown[]) => complete(...args),
}));
const { answerFromCode, disclosureViolations, pathsForPicker, pickCodeFiles } =
  await import("../src/code-answer.ts");

// The two model steps of answers from your code: the file pick keeps only
// real paths, and the answer passes a deterministic disclosure check with
// one corrective turn.

const reply = (content: unknown) => ({
  content: typeof content === "string" ? content : JSON.stringify(content),
});
const SOURCES = [{ path: "src/approve.ts", content: "export function approve() {}" }];

beforeEach(() => complete.mockReset());

describe("disclosureViolations", () => {
  it("passes plain behaviour", () => {
    expect(
      disclosureViolations(
        "When two people approve the same item at once, only the first approval goes through and the second sees it already approved.",
      ),
    ).toEqual([]);
  });

  it.each([
    ["The handler in src/api/approve.ts checks it.", "source path"],
    ["It reads APPROVAL_TIMEOUT_MS before retrying.", "environment or config identifier"],
    ["A row lock in the database makes the second write wait.", "internal implementation detail"],
    ["Use `approve()` twice.", "code in the answer"],
    ["See https://example.com/docs for details.", "link"],
    ["The token is abc0123456789def0123456789ghi0123456789.", "credential-shaped string"],
  ])("flags %s", (text, flag) => {
    expect(disclosureViolations(text)).toContain(flag);
  });

  it("allows internals words under a looser disclosure level, never paths", () => {
    expect(
      disclosureViolations("Writes are serialized by a database lock.", { strict: false }),
    ).toEqual([]);
    expect(disclosureViolations("See src/db.ts.", { strict: false })).toContain("source path");
  });
});

describe("pickCodeFiles", () => {
  it("keeps only listed paths, deduplicated, at most eight", async () => {
    const paths = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
    complete.mockResolvedValueOnce(
      reply({ files: ["src/f1.ts", "./src/f2.ts", "src/invented.ts", "src/f1.ts", ...paths] }),
    );
    const out = await pickCodeFiles({ question: "q?", brief: "b", paths, readme: "# R" });
    expect(out).toEqual([
      "src/f1.ts",
      "src/f2.ts",
      "src/f0.ts",
      "src/f3.ts",
      "src/f4.ts",
      "src/f5.ts",
      "src/f6.ts",
      "src/f7.ts",
    ]);
    const call = complete.mock.calls[0]![0] as {
      messages: Array<{ content: string }>;
      temperature: number;
    };
    expect(call.temperature).toBe(0);
    expect(call.messages[1]!.content).toContain("FILES:\nsrc/f0.ts");
    expect(call.messages[1]!.content).toContain("README:\n# R");
  });

  it("trims a huge path list to implementation code first", () => {
    const tests = Array.from(
      { length: 4000 },
      (_, i) => `packages/app/__tests__/case-${i}.test.ts`,
    );
    const out = pathsForPicker(["src/core.ts", ...tests]);
    expect(out).toContain("src/core.ts");
    expect(out.length).toBeLessThan(tests.length);
  });
});

describe("answerFromCode", () => {
  const input = {
    question: "What happens on a double approve?",
    disclosure: "behaviour",
    strict: true,
    sources: SOURCES,
  };

  it("returns a clean answer", async () => {
    complete.mockResolvedValueOnce(
      reply({ answered: true, note: "Only the first approval counts." }),
    );
    expect(await answerFromCode(input)).toEqual({
      answered: true,
      answer: "Only the first approval counts.",
      rewritten: false,
    });
    const call = complete.mock.calls[0]![0] as {
      messages: Array<{ content: string }>;
      maxTokens: number;
    };
    expect(call.maxTokens).toBe(800);
    expect(call.messages[1]!.content).toContain("----- src/approve.ts -----");
    expect(call.messages[1]!.content).toContain("DISCLOSURE LEVEL: behaviour");
  });

  it("rewrites once on a disclosure violation", async () => {
    complete
      .mockResolvedValueOnce(
        reply({ answered: true, note: "A database row lock serializes approvals." }),
      )
      .mockResolvedValueOnce(reply({ answered: true, note: "Only the first approval counts." }));
    expect(await answerFromCode(input)).toEqual({
      answered: true,
      answer: "Only the first approval counts.",
      rewritten: true,
    });
    const second = complete.mock.calls[1]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(second.messages).toHaveLength(4);
    expect(second.messages[3]!.content).toContain("internal implementation detail");
  });

  it("is unresolved when the rewrite still breaks the rules", async () => {
    complete
      .mockResolvedValueOnce(reply({ answered: true, note: "A mutex guards it." }))
      .mockResolvedValueOnce(reply({ answered: true, note: "A mutex still guards it." }));
    const out = await answerFromCode(input);
    expect(out.answered).toBe(false);
    expect(!out.answered && out.why).toContain("disclosure");
  });

  it("passes on the model's why when the source does not settle it", async () => {
    complete.mockResolvedValueOnce(
      reply({ answered: false, why: "retries are not in the source" }),
    );
    expect(await answerFromCode(input)).toEqual({
      answered: false,
      why: "retries are not in the source",
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
