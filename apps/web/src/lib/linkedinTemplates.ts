import {
  DEFAULT_LINKEDIN_TEMPLATES,
  LINKEDIN_TEMPLATE_FIELDS,
  renderLinkedInTemplate,
  templateProblems,
  type LinkedInTemplateField,
  type LinkedInTemplateStep,
  type LinkedInTemplateValues,
  type SetupRequest,
} from "@oneshot-gtm/shared-types";

export type LinkedInWriterChoice = "template" | "model";

/** The Setup section's draft: who writes, plus one flat text per step. */
export type LinkedInSectionValues = { writer: LinkedInWriterChoice } & Record<
  LinkedInTemplateStep,
  string
>;

/** The values the live example under each template is filled with. */
export const LINKEDIN_TEMPLATE_SAMPLE: LinkedInTemplateValues = {
  first_name: "Dana",
  evidence: "you starred acme/widgets",
  offer: "an example offer",
};

/** The saved settings, flattened to primitives for the section draft. */
export function linkedinSectionValues(saved?: {
  writer?: LinkedInWriterChoice;
  templates?: Partial<Record<LinkedInTemplateStep, string>>;
}): LinkedInSectionValues {
  const out = { writer: saved?.writer === "model" ? "model" : "template" } as LinkedInSectionValues;
  for (const f of LINKEDIN_TEMPLATE_FIELDS) out[f.step] = saved?.templates?.[f.step] ?? "";
  return out;
}

/**
 * The dirty keys as the nested request. Only the steps that changed go out;
 * a blank one reaches the server as "" and removes that step's text.
 */
export function linkedinSectionRequest(sent: Partial<LinkedInSectionValues>): SetupRequest {
  const linkedin: NonNullable<SetupRequest["linkedin"]> = {};
  if (sent.writer !== undefined) linkedin.writer = sent.writer;
  const templates: Partial<Record<LinkedInTemplateStep, string>> = {};
  for (const f of LINKEDIN_TEMPLATE_FIELDS) {
    const value = sent[f.step];
    if (value !== undefined) templates[f.step] = value;
  }
  if (Object.keys(templates).length > 0) linkedin.templates = templates;
  return Object.keys(linkedin).length > 0 ? { linkedin } : {};
}

/** Per step, why its text can't be saved (the server's own check). */
export function linkedinSectionErrors(
  values: LinkedInSectionValues,
): Partial<Record<keyof LinkedInSectionValues, string | null>> {
  const out: Partial<Record<keyof LinkedInSectionValues, string | null>> = {};
  for (const f of LINKEDIN_TEMPLATE_FIELDS) {
    const text = values[f.step].trim();
    out[f.step] = text ? templateProblems(f.step, text).join("; ") || null : null;
  }
  return out;
}

export type LinkedInTemplateExample =
  | { text: string; length: number; over: boolean; usesDefault: boolean }
  | { missing: string[]; usesDefault: boolean };

/** The step's text (or its default when blank) filled with the sample values. */
export function linkedinTemplateExample(
  field: LinkedInTemplateField,
  value: string,
): LinkedInTemplateExample {
  const own = value.trim();
  const usesDefault = own.length === 0;
  const rendered = renderLinkedInTemplate(
    usesDefault ? DEFAULT_LINKEDIN_TEMPLATES[field.step] : own,
    LINKEDIN_TEMPLATE_SAMPLE,
  );
  if ("missing" in rendered) return { missing: rendered.missing, usesDefault };
  return {
    text: rendered.text,
    length: rendered.text.length,
    over: rendered.text.length > field.limit,
    usesDefault,
  };
}

/** "Placeholders: {first_name}, {evidence}" for a step's hint. */
export function placeholderList(field: LinkedInTemplateField): string {
  return `Placeholders: ${field.placeholders.map((p) => `{${p}}`).join(", ")}`;
}
