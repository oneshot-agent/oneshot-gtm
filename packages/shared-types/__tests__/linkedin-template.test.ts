import { describe, expect, it } from "vitest";
import {
  DEFAULT_LINKEDIN_TEMPLATES,
  LINKEDIN_TEMPLATE_FIELDS,
  chooseLinkedInTemplate,
  linkedInTemplateStep,
  renderLinkedInTemplate,
  templatePlaceholders,
  templateProblems,
  type LinkedInTemplateStep,
} from "../src/index.ts";

const dana = {
  first_name: "Dana",
  evidence: "you starred acme/widgets",
  offer: "an example offer",
};

describe("renderLinkedInTemplate", () => {
  it("fills every placeholder and strips the trailing stop off a clause or an offer", () => {
    expect(
      renderLinkedInTemplate("Hi {first_name}, saw {evidence}. I'd {offer}.", {
        ...dana,
        offer: "run an example offer.",
      }),
    ).toEqual({ text: "Hi Dana, saw you starred acme/widgets. I'd run an example offer." });
  });

  it("names what is missing instead of leaving braces in the text", () => {
    expect(renderLinkedInTemplate("Hi {first_name}: {offer}.", { first_name: "Dana" })).toEqual({
      missing: ["offer"],
    });
    expect(renderLinkedInTemplate("Hi {first_name}, {mystery}.", dana)).toEqual({
      missing: ["mystery"],
    });
  });

  it("drops the opening greeting when there is no usable first name", () => {
    const none = { ...dana, first_name: null };
    expect(renderLinkedInTemplate("hey {first_name} - saw {evidence}.", none)).toEqual({
      text: "Saw you starred acme/widgets.",
    });
    expect(renderLinkedInTemplate("Hi {first_name}, would be good to connect.", none)).toEqual({
      text: "Would be good to connect.",
    });
    expect(renderLinkedInTemplate("{first_name}: quick one.", none)).toEqual({
      text: "Quick one.",
    });
    // A possessive is not a greeting: it can't be dropped either.
    expect(renderLinkedInTemplate("Hi {first_name}'s team, hello.", none)).toEqual({
      missing: ["first_name"],
    });
    // A name used past the greeting can't be dropped.
    expect(renderLinkedInTemplate("Saw {evidence}, {first_name}.", none)).toEqual({
      missing: ["first_name"],
    });
  });
});

describe("templateProblems", () => {
  it("accepts the shipped defaults for their own steps", () => {
    for (const [step, text] of Object.entries(DEFAULT_LINKEDIN_TEMPLATES))
      expect(templateProblems(step as LinkedInTemplateStep, text), step).toEqual([]);
  });

  it("refuses unknown placeholders, a value the step never has, and an over-long text", () => {
    expect(templateProblems("note", "Hi {firstname}")).toEqual(["unknown placeholder {firstname}"]);
    expect(templateProblems("noteFallback", "saw {evidence}")).toEqual([
      '{evidence} can\'t be used in "Connection request, no evidence"',
    ]);
    expect(templateProblems("note", "pitch: {offer}")).toHaveLength(1);
    expect(templateProblems("lastMessageFallback", "{offer}")).toHaveLength(1);
    expect(templateProblems("friendNote", "x".repeat(601))).toEqual(["longer than 600 characters"]);
  });

  it("refuses a mistyped placeholder instead of passing it through as text", () => {
    expect(templateProblems("note", "Hi {First_Name}")).toEqual([
      "unknown placeholder {First_Name}",
    ]);
    expect(templateProblems("note", "Hi {name2}, {first-name}")).toEqual([
      "unknown placeholder {name2}",
      "unknown placeholder {first-name}",
    ]);
    expect(renderLinkedInTemplate("Hi {First_Name}", dana)).toEqual({ missing: ["First_Name"] });
  });

  it("lists placeholders once, in order", () => {
    expect(templatePlaceholders("{offer} {first_name} {offer}")).toEqual(["offer", "first_name"]);
  });
});

describe("chooseLinkedInTemplate", () => {
  it("picks the step from what is known", () => {
    expect(linkedInTemplateStep("note", { evidence: "you starred x" })).toBe("note");
    expect(linkedInTemplateStep("note", { evidence: " " })).toBe("noteFallback");
    expect(linkedInTemplateStep("first", {})).toBe("firstMessage");
    expect(linkedInTemplateStep("first", { alreadyConnected: true })).toBe("firstMessageConnected");
    expect(linkedInTemplateStep("last", { offer: "x" })).toBe("lastMessage");
    expect(linkedInTemplateStep("last", {})).toBe("lastMessageFallback");
    expect(linkedInTemplateStep("friend", {})).toBe("friendNote");
  });

  it("uses the workspace's text, and the default when that text can't be filled", () => {
    expect(chooseLinkedInTemplate("first", { firstMessage: "yo {first_name}" }, dana)).toEqual({
      text: "yo Dana",
      step: "firstMessage",
      source: "workspace",
    });
    // The workspace's first message wants an offer this person doesn't have.
    expect(
      chooseLinkedInTemplate(
        "first",
        { firstMessage: "{first_name}: {offer}?" },
        {
          first_name: "Dana",
        },
      ),
    ).toMatchObject({ source: "default", step: "firstMessage" });
  });
});

describe("shipped defaults", () => {
  const longest = {
    first_name: "x".repeat(20),
    evidence: `you ${"x".repeat(80)}`,
    offer: "x".repeat(140),
  };

  it("fit their step's limit at the longest values", () => {
    for (const field of LINKEDIN_TEMPLATE_FIELDS) {
      const out = renderLinkedInTemplate(DEFAULT_LINKEDIN_TEMPLATES[field.step], longest);
      expect("text" in out && out.text.length, field.step).toBeLessThanOrEqual(field.limit);
    }
  });

  it("carry no pitch, link or question in a connection request", () => {
    for (const step of ["note", "noteFallback", "friendNote"] as const) {
      const text = DEFAULT_LINKEDIN_TEMPLATES[step];
      expect(text).not.toMatch(/https?:|www\.|\?/);
      expect(templatePlaceholders(text)).not.toContain("offer");
    }
  });
});
