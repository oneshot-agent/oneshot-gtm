import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_LINKEDIN_TEMPLATES, LINKEDIN_TEMPLATE_FIELDS } from "@oneshot-gtm/shared-types";
import { LinkedInTemplatesSection } from "../src/components/setup/LinkedInTemplatesSection.tsx";
import type { SetupCfg } from "../src/components/setup/types.ts";
import {
  linkedinSectionErrors,
  linkedinSectionRequest,
  linkedinSectionValues,
  linkedinTemplateExample,
} from "../src/lib/linkedinTemplates.ts";

// The /setup section for LinkedIn copy: one template per step, the shipped
// default as its placeholder, and a live example filled with sample values.

const noop = () => {};
const render = (linkedin?: SetupCfg["linkedin"]) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <LinkedInTemplatesSection cfg={{ linkedin } as SetupCfg} sources={{}} onDirtyChange={noop} />
    </QueryClientProvider>,
  );
const escape = (s: string) => s.replaceAll("'", "&#x27;");
const field = (step: string) => LINKEDIN_TEMPLATE_FIELDS.find((f) => f.step === step)!;

describe("LinkedInTemplatesSection", () => {
  it("renders every step with its default as the placeholder and its placeholders listed", () => {
    const html = render();
    for (const f of LINKEDIN_TEMPLATE_FIELDS) {
      expect(html).toContain(f.label);
      expect(html).toContain(`placeholder="${escape(DEFAULT_LINKEDIN_TEMPLATES[f.step])}"`);
    }
    expect(html).toContain("Placeholders: {first_name}, {evidence}.");
    expect(html).toContain("Templates (default)");
  });

  it("shows the live example of the default, and of the saved text, with its count", () => {
    const html = render({ templates: { friendNote: "Hello {first_name}, good to meet." } });
    expect(html).toContain("Default, e.g.: Hi Dana, saw you starred acme/widgets.");
    expect(html).toContain("e.g.: Hello Dana, good to meet.");
    expect(html).toContain(`· ${"Hello Dana, good to meet.".length} / 300 characters`);
  });

  it("flags an example over the step's limit and a placeholder it can't fill", () => {
    const over = linkedinTemplateExample(field("note"), `Hi {first_name}. ${"a".repeat(300)}`);
    expect(over).toMatchObject({ over: true, usesDefault: false });
    expect(linkedinTemplateExample(field("note"), "Hi {nickname}")).toEqual({
      missing: ["nickname"],
      usesDefault: false,
    });
  });
});

describe("LinkedIn section request", () => {
  it("flattens the saved settings, blanks for unset steps", () => {
    const values = linkedinSectionValues({ writer: "model", templates: { note: "Hi." } });
    expect(values.writer).toBe("model");
    expect(values.note).toBe("Hi.");
    expect(values.friendNote).toBe("");
    expect(linkedinSectionValues(undefined).writer).toBe("template");
  });

  it("sends only the dirty keys, nested under linkedin.templates", () => {
    expect(linkedinSectionRequest({ note: "Hi {first_name}.", friendNote: "" })).toEqual({
      linkedin: { templates: { note: "Hi {first_name}.", friendNote: "" } },
    });
    expect(linkedinSectionRequest({ writer: "model" })).toEqual({ linkedin: { writer: "model" } });
    expect(linkedinSectionRequest({})).toEqual({});
  });

  it("validates each step with the server's rules", () => {
    const values = { ...linkedinSectionValues(), noteFallback: "Hi {offer}", note: "Hi {x}" };
    const errors = linkedinSectionErrors(values);
    expect(errors.noteFallback).toMatch(/\{offer\} can't be used/);
    expect(errors.note).toMatch(/unknown placeholder \{x\}/);
    expect(errors.friendNote).toBeNull();
  });
});
