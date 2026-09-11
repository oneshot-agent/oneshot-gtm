import { beforeEach, expect, it, vi } from "vitest";
const cfg = {
  productOneLiner: "an executable GTM playbook",
  productBrief: "discovery and pilots",
  icpOneLiner: "founders",
};
const complete = vi.fn();
const selectAngle = vi.fn();
vi.mock("@oneshot-gtm/core", () => ({ loadConfig: () => cfg }));
vi.mock("@oneshot-gtm/intel", () => ({
  complete,
  loadPrompt: () => "grounded alternative",
  tryParseJsonObject: (s: string, fallback: unknown) => {
    try {
      return JSON.parse(s);
    } catch {
      return fallback;
    }
  },
}));
vi.mock("@oneshot-gtm/plays", () => ({
  selectAngle,
  edgeFieldOf: (t: Record<string, unknown>) =>
    typeof t.yourEdge === "string" && t.yourEdge.trim()
      ? "yourEdge"
      : typeof t.yourClaim === "string" && t.yourClaim.trim()
        ? "yourClaim"
        : null,
  splitEdgeAngles: (s: string) =>
    s
      .split("//")
      .map((v) => v.trim())
      .filter(Boolean),
  describeTargetForAngle: () => "Founder selling to clinics",
  slopFlags: (text: string) =>
    /\b(?:isn'?t|is not|not just)\b[^.;:!?]{1,60},\s*it'?s\b/i.test(text)
      ? ["negative-parallelism"]
      : [],
}));
const { draftAngleFor } = await import("../src/api/_draft-angle.ts");
const POOL = 12;
const twelve =
  "first // second // third // fourth // fifth // sixth // seventh // eighth // ninth // tenth // eleventh // twelfth";
const base = {
  target: { email: "a@example.com", yourEdge: twelve },
  playName: "luma-events",
  rotate: false,
};
beforeEach(() => {
  cfg.productOneLiner = "an executable GTM playbook";
  selectAngle.mockReset().mockResolvedValue({ index: 0 });
  complete.mockReset().mockImplementation(async (input) => {
    const count = JSON.parse(input.messages[1].content).count;
    return {
      content: JSON.stringify({
        angles: Array.from({ length: count }, (_, i) => `Distinct argument ${i + 1}`),
      }),
    };
  });
});
it("cycles all twelve configured angles and wraps without generating alternatives", async () => {
  let previous = (await draftAngleFor(base))!;
  for (let i = 1; i <= POOL; i++) {
    previous = (await draftAngleFor({ ...base, rotate: true, previous }))!;
    expect(previous.index).toBe(i % POOL);
    expect(previous.count).toBe(POOL);
  }
  expect(complete).not.toHaveBeenCalled();
  expect(await draftAngleFor({ ...base, previous })).toEqual(previous);
});
it.each([0, 1, 2, 3, 5, 6, 11])(
  "fills %i configured angles to twelve once, then reuses the pool",
  async (count) => {
    const input = {
      ...base,
      target: { yourEdge: twelve.split(" // ").slice(0, count).join(" // ") },
      rotate: true,
    };
    const first = (await draftAngleFor(input))!;
    expect(first.pool).toHaveLength(POOL);
    expect(first.pool?.filter((a) => a.origin === "configured")).toHaveLength(count);
    expect(complete).toHaveBeenCalledTimes(1);
    const second = (await draftAngleFor({ ...input, previous: first }))!;
    expect(second.index).toBe((first.index! + 1) % POOL);
    expect(second.pool).toEqual(first.pool);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(await draftAngleFor({ ...input, rotate: false, previous: second })).toEqual(second);
  },
);
it("keeps more than twelve configured angles", async () => {
  expect(
    (
      await draftAngleFor({
        ...base,
        target: { yourEdge: twelve + " // thirteenth" },
        rotate: true,
      })
    )?.count,
  ).toBe(13);
  expect(complete).not.toHaveBeenCalled();
});
it("ordinary generation with three angles does not fill the pool", async () => {
  expect(
    (await draftAngleFor({ ...base, target: { yourEdge: "one // two // three" } }))?.count,
  ).toBe(3);
  expect(complete).not.toHaveBeenCalled();
});
it("uses the old selector choice as the starting point for legacy drafts", async () => {
  selectAngle.mockResolvedValue({ index: 2 });
  expect((await draftAngleFor({ ...base, rotate: true }))?.index).toBe(3);
});
it("uses changed order and discards removed angles", async () => {
  const previous = (await draftAngleFor(base))!;
  const reordered = {
    ...base,
    target: { yourEdge: "second // first // " + twelve.split(" // ").slice(2).join(" // ") },
    rotate: true,
    previous,
  };
  expect((await draftAngleFor(reordered))?.text).toBe("third");
  expect(
    (
      await draftAngleFor({
        ...reordered,
        target: { yourEdge: twelve.split(" // ").slice(1).join(" // ") + " // thirteenth" },
      })
    )?.text,
  ).toBe("second");
});
it("rebuilds alternatives after positioning changes", async () => {
  const input = { ...base, target: {}, rotate: true };
  const previous = (await draftAngleFor(input))!;
  cfg.productOneLiner = "updated positioning";
  expect(await draftAngleFor({ ...input, rotate: false, previous })).toBeUndefined();
  const next = (await draftAngleFor({ ...input, previous }))!;
  expect(next.fingerprint).not.toBe(previous.fingerprint);
  expect(complete).toHaveBeenCalledTimes(2);
});
it.each([
  "{}",
  "not json",
  '{"angles":[]}',
  // the right count, but two of them are the same argument
  JSON.stringify({ angles: ["same", "same", ...Array.from({ length: 10 }, (_, i) => `arg ${i}`)] }),
])("rejects incomplete or duplicate alternatives (%s)", async (content) => {
  complete.mockResolvedValue({ content });
  await expect(draftAngleFor({ ...base, target: {}, rotate: true })).rejects.toThrow(
    /12 distinct angles/,
  );
});
it("propagates provider errors without a random fallback", async () => {
  complete.mockRejectedValue(new Error("unavailable"));
  await expect(draftAngleFor({ ...base, target: {}, rotate: true })).rejects.toThrow("unavailable");
});

it("rejects a generated angle built on a negation contrast and leaves the draft unchanged", async () => {
  complete.mockImplementation(async (input) => {
    const count = JSON.parse(input.messages[1].content).count;
    const angles = Array.from({ length: count }, (_, i) => `Distinct argument ${i + 1}`);
    angles[2] =
      "The hard part isn't the engineering, it's finding the first ten teams patient enough to switch.";
    return { content: JSON.stringify({ angles }) };
  });
  await expect(
    draftAngleFor({ ...base, target: { yourEdge: "first // second" }, rotate: true }),
  ).rejects.toThrow(/negation contrast/);
});
