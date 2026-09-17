import { beforeEach, expect, it, vi } from "vitest";
const complete = vi.fn();
vi.mock("@oneshot-gtm/intel", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel")),
  complete: (...args: unknown[]) => complete(...args),
}));
const { generateReplyOptions, improveReplyOption } = await import("../src/reply-options.ts");
const { buildDraftSystemPrompt, buildDraftUserPrompt, lintLinkedInDrafts } =
  await import("../src/reply-options-rules.ts");
const input = {
  channel: "linkedin" as const,
  founder: "Founder",
  founderCalendarUrl: "",
  primaryWorkspace: "test",
  primaryProduct: "Tools",
  primaryBrief: "Tools with payments. https://example.com",
  secondaryProducts: [],
  prospect: { name: "Ada", company: "", title: "", profileUrl: "" },
  dossier: "",
  priorOutreach: [],
  thread: [
    { direction: "inbound" as const, body: "How do payments work?", at: "2026-09-17T12:00:00Z" },
  ],
  casualTexture: false,
  founderVoice: "Short and plain",
  steer: "No meeting request",
};
beforeEach(() => complete.mockReset());
it("keeps three distinct moves, approved links, and commitment review for both channels", () => {
  for (const channel of ["email", "linkedin"] as const) {
    expect(buildDraftSystemPrompt(channel)).toContain(`${channel.toUpperCase()} REPLY TASK`);
    const flags = lintLinkedInDrafts(
      {
        direct: "I can offer a 20% discount.",
        technical: "Read https://invented.example",
        warm: "Read https://invented.example",
      },
      { direct: "answer", technical: "answer", warm: "answer" },
      { ...input, channel },
    );
    expect(flags.perVariant.direct).toContain("commits-terms");
    expect(flags.perVariant.technical).toContain("link-not-in-brief");
    expect(flags.set).toContain("same-move");
  }
  expect(buildDraftUserPrompt(input)).toContain("Short and plain");
  expect(buildDraftUserPrompt(input)).toContain("No meeting request");
});
it("rejects incomplete generation and leaves existing user edits to the caller", async () => {
  complete.mockResolvedValue({ content: JSON.stringify({ direct: "Only one" }) });
  await expect(generateReplyOptions(input)).rejects.toThrow("all three");
});
it("improves intentional edits without applying the humanizer or reverting to the original", async () => {
  complete.mockResolvedValue({
    content: JSON.stringify({ text: "I kept YOUR wording — as requested." }),
  });
  expect(await improveReplyOption(input, "MY edit", "original", "Keep my emphasis")).toBe(
    "I kept YOUR wording — as requested.",
  );
  const prompt = JSON.parse(complete.mock.calls[0]![0].messages[1].content);
  expect(prompt).toMatchObject({
    currentDraft: "MY edit",
    originalSuggestion: "original",
    editingFeedback: "Keep my emphasis",
  });
});
