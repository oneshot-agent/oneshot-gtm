import { beforeEach, expect, it, vi } from "vitest";
const complete = vi.fn();
vi.mock("@oneshot-gtm/intel", async () => ({
  ...(await vi.importActual<typeof import("@oneshot-gtm/intel")>("@oneshot-gtm/intel")),
  complete: (...args: unknown[]) => complete(...args),
}));
const { generateReplyOptions, improveReplyOption } = await import("../src/reply-options.ts");
const { buildDraftSystemPrompt, buildDraftUserPrompt, lintLinkedInDrafts, repairInstruction } =
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

it("passes learned guidance to both reply prompts with explicit directions taking priority", async () => {
  const context = { ...input, learnedPreferences: ["Use plain wording."] };
  expect(buildDraftUserPrompt(context)).toContain("Use plain wording.");
  // Since #813 approved guidance applies on email too; the caller scopes it by channel.
  expect(buildDraftUserPrompt({ ...context, channel: "email" })).toContain("Use plain wording.");
  expect(buildDraftUserPrompt({ ...context, learnedPreferences: [] })).not.toContain(
    "LEARNED WRITING PREFERENCES",
  );
  expect(buildDraftSystemPrompt("linkedin")).toContain("take priority over learned preferences");
  complete.mockResolvedValue({ content: JSON.stringify({ text: "My revision" }) });
  await improveReplyOption(context, "my edit", "original", "Keep the detail");
  const call = complete.mock.calls[0]![0];
  expect(JSON.parse(call.messages[1].content).conversationContext.learnedPreferences).toEqual([
    "Use plain wording.",
  ]);
  expect(call.messages[0].content).toContain("override learned preferences");
});

it("does not lint blank options or judge a set the founder is still filling in", () => {
  // The save route lints every edit; an emptied editor used to come back as
  // same-move plus near-duplicate pairs of blank bodies.
  const blank = lintLinkedInDrafts({ direct: "", technical: "", warm: "" }, {}, input);
  expect(blank).toEqual({ perVariant: { direct: [], technical: [], warm: [] }, set: [] });
  const partial = lintLinkedInDrafts(
    { direct: "Read https://invented.example", technical: "", warm: "  " },
    { direct: "answer" },
    input,
  );
  expect(partial.perVariant.direct).toContain("link-not-in-brief");
  expect(partial.perVariant.technical).toEqual([]);
  expect(partial.set).toEqual([]);
  // Two written options that read the same are still a duplicate pair.
  const pair = lintLinkedInDrafts(
    {
      direct: "Payments settle through Stripe under a spend cap.",
      technical: "",
      warm: "Payments settle through Stripe under a spend cap.",
    },
    { direct: "answer", warm: "ask" },
    input,
  );
  expect(pair.set).toEqual(["near-duplicate:direct+warm"]);
});

it("shows the offer we made and the classified intent only when the thread has them", () => {
  const offer = {
    offer: "Send reminders for next week's appointments at your two clinics",
    steps: "read the booking calendar, send each reminder a day ahead",
    return: "fewer no-shows, counted against last month's",
  };
  const prompt = buildDraftUserPrompt({ ...input, offer, intent: "question" });
  expect(prompt).toContain("OFFER WE MADE");
  expect(prompt).toContain(offer.offer);
  expect(prompt).toContain(`Steps: ${offer.steps}`);
  expect(prompt).toContain(`Return: ${offer.return}`);
  expect(prompt).toContain("INTENT DIRECTIVE (classified: question");
  const bare = buildDraftUserPrompt(input);
  expect(bare).not.toContain("OFFER WE MADE");
  expect(bare).not.toContain("INTENT DIRECTIVE");
  // A label with no directive adds nothing either.
  expect(buildDraftUserPrompt({ ...input, intent: "other" })).not.toContain("INTENT DIRECTIVE");
});

it("offers the scope move and binds the brief's framing", () => {
  const system = buildDraftSystemPrompt("email");
  expect(system).toContain("  scope: turn the offer we made into the smallest first step");
  expect(system).toContain("one of the three moves must be scope");
  expect(system).toContain("BRIEF FRAMING (binding)");
  expect(system).toContain("internal tools, modules or features");
  expect(system).not.toContain("or the move needs it");
  expect(system).not.toContain("Telling an engineer");
});

it("flags a price or free claim, but not a negated one or a price the brief states", () => {
  const lint = (text: string, primaryBrief = input.primaryBrief) =>
    lintLinkedInDrafts({ direct: text, technical: "", warm: "" }, {}, { ...input, primaryBrief })
      .perVariant.direct;
  for (const text of [
    "The first week is free.",
    "We'd run it at no cost to you.",
    "The pilot costs nothing.",
    "Setup is $0.",
    "It runs at $40 a month.",
  ])
    expect(lint(text), text).toContain("price-or-free");
  for (const text of [
    "The pilot is not free, and I'd rather say so now.",
    "It isn't entirely free.",
    "Feel free to send the calendar over.",
    "That would free up your front desk.",
    "Reminders go out a day ahead.",
  ])
    expect(lint(text), text).not.toContain("price-or-free");
  expect(lint("It runs at $40 a month.", "Reminders for $40 a month.")).not.toContain(
    "price-or-free",
  );
});

it("treats a link without a scheme as a link", () => {
  const lint = (text: string) =>
    lintLinkedInDrafts({ direct: text, technical: "", warm: "" }, {}, input).perVariant.direct;
  expect(lint("The write-up is at example.com/how-it-works.")).toEqual(
    expect.arrayContaining(["link-not-in-brief", "bare-link"]),
  );
  expect(lint("See https://example.com and invented.example/page")).toContain("too-many-links");
  expect(lint("The brief's page: https://example.com")).not.toContain("link-not-in-brief");
  // A plain domain and a file extension are not links.
  for (const text of ["Best, Founder\nexample.com", "It runs on Node.js/Deno today."]) {
    expect(lint(text)).not.toContain("bare-link");
    expect(lint(text)).not.toContain("link-not-in-brief");
  }
});

it("names the price and bare-link rules in the repair turn only when they failed", () => {
  const flags = {
    perVariant: { direct: ["price-or-free"], technical: ["bare-link"], warm: [] },
    set: [],
  };
  const repair = repairInstruction(flags);
  expect(repair).toContain("free or at no cost");
  expect(repair).toContain("without https:// is still a link");
  const clean = repairInstruction({
    ...flags,
    perVariant: { ...flags.perVariant, direct: [], technical: [] },
  });
  expect(clean).not.toContain("free or at no cost");
  expect(clean).not.toContain("without https://");
});

it("keeps configured terms out of every option: told, flagged, and named in the repair", () => {
  const avoidTerms = ["Planner", "booking engine"];
  expect(buildDraftUserPrompt({ ...input, avoidTerms })).toContain(
    "NEVER USE THESE TERMS IN A REPLY (describe what the thing does instead): Planner; booking engine",
  );
  expect(buildDraftUserPrompt(input)).not.toContain("NEVER USE THESE TERMS");
  expect(buildDraftUserPrompt({ ...input, avoidTerms: [] })).not.toContain("NEVER USE THESE TERMS");
  const flags = lintLinkedInDrafts(
    {
      direct: "the planner sends reminders a day ahead.",
      technical: "Our Booking\nEngine reads your calendar.",
      warm: "Planners at your clinic would see fewer gaps; the booking page stays yours.",
    },
    { direct: "answer", technical: "scope", warm: "ask" },
    { ...input, avoidTerms },
  );
  expect(flags.perVariant.direct).toContain("avoid-term");
  expect(flags.perVariant.technical).toContain("avoid-term");
  // "Planners" is another word, and "booking page" is not the phrase.
  expect(flags.perVariant.warm).not.toContain("avoid-term");
  const repair = repairInstruction(flags, {}, avoidTerms);
  expect(repair).toContain(
    "Rewrite direct and technical without these terms: Planner; booking engine; say what it does in plain words.",
  );
  expect(repairInstruction(flags)).not.toContain("without these terms");
});
