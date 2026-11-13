import { describe, expect, it } from "vitest";
import { LINKEDIN_TEMPLATE_SLOTS, linkedinTemplatesOf, linkedinWriterOf } from "@oneshot-gtm/core";
import { DEFAULT_LINKEDIN_TEMPLATES, LINKEDIN_TEMPLATE_FIELDS } from "@oneshot-gtm/shared-types";
import { slopFlags } from "../src/_lib.ts";
import { templatedLinkedIn } from "../src/_linkedin-template.ts";

describe("LinkedIn template config", () => {
  it("names the same steps in the config, the defaults and the Setup fields", () => {
    const slots = [...LINKEDIN_TEMPLATE_SLOTS].toSorted();
    expect(Object.keys(DEFAULT_LINKEDIN_TEMPLATES).toSorted()).toEqual(slots);
    expect(LINKEDIN_TEMPLATE_FIELDS.map((f) => f.step).toSorted()).toEqual(slots);
  });

  it("reads known, non-blank steps only, and the model writer only when spelled out", () => {
    expect(
      linkedinTemplatesOf({
        linkedin: {
          templates: { note: "  hi {first_name} ", noteFallback: " ", bogus: "x", friendNote: 3 },
        },
      }),
    ).toEqual({ note: "hi {first_name}" });
    expect(linkedinTemplatesOf({})).toEqual({});
    expect(linkedinWriterOf({})).toBe("template");
    expect(linkedinWriterOf({ linkedin: { writer: "Model" } })).toBe("template");
    expect(linkedinWriterOf({ linkedin: { writer: "model" } })).toBe("model");
  });

  it("ships defaults that use no phrase the email lint bans", () => {
    for (const [step, text] of Object.entries(DEFAULT_LINKEDIN_TEMPLATES)) {
      expect(slopFlags(text), step).toEqual([]);
    }
  });
});

describe("templatedLinkedIn", () => {
  it("takes the first name from the full name and gives the evidence its subject", () => {
    expect(templatedLinkedIn("note", {}, { name: "Dana Lee", evidence: "in YC F26" })?.text).toBe(
      "Hi Dana, saw you're in YC F26. Would be good to connect.",
    );
  });

  it("drops the greeting for a handle or a company name", () => {
    expect(templatedLinkedIn("first", {}, { name: "Acme Labs" })?.text).toBe(
      "Thanks for connecting. What are you working on right now?",
    );
    // A stored username, not a name: no "hey GVillegasPM,".
    expect(templatedLinkedIn("first", {}, { name: "GVillegasPM" })?.text).toBe(
      "Thanks for connecting. What are you working on right now?",
    );
  });

  it("passes their title and company, so a founder gets the founder text", () => {
    const cfg = {
      linkedin: { templates: { firstMessageFounder: "hey {first_name}, how's {company} going?" } },
    };
    expect(
      templatedLinkedIn("first", cfg, { name: "Dana Lee", title: "Founder", company: "Acme" })
        ?.text,
    ).toBe("hey Dana, how's Acme going?");
    expect(
      templatedLinkedIn("first", cfg, { name: "Dana Lee", title: "VP Sales", company: "Acme" }),
    ).toMatchObject({ step: "firstMessage" });
  });

  it("is null when the workspace has the model write", () => {
    expect(
      templatedLinkedIn("note", { linkedin: { writer: "model" } }, { name: "Dana" }),
    ).toBeNull();
  });
});
