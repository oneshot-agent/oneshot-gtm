import { describe, expect, it } from "vitest";
import { LINKEDIN_TEMPLATE_SLOTS, linkedinTemplatesOf, linkedinWriterOf } from "@oneshot-gtm/core";
import { DEFAULT_LINKEDIN_TEMPLATES, LINKEDIN_TEMPLATE_FIELDS } from "@oneshot-gtm/shared-types";
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
  });

  it("is null when the workspace has the model write", () => {
    expect(
      templatedLinkedIn("note", { linkedin: { writer: "model" } }, { name: "Dana" }),
    ).toBeNull();
  });
});
