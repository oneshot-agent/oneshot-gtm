import { useMemo } from "react";
import { DEFAULT_LINKEDIN_TEMPLATES, LINKEDIN_TEMPLATE_FIELDS } from "@oneshot-gtm/shared-types";
import {
  linkedinSectionErrors,
  linkedinSectionRequest,
  linkedinSectionValues,
  linkedinTemplateExample,
  placeholderList,
  type LinkedInWriterChoice,
} from "../../lib/linkedinTemplates.ts";
import { Field, Select, Textarea } from "../primitives/Field.tsx";
import { SectionShell } from "./SectionShell.tsx";
import { useConfigSection } from "./useConfigSection.ts";
import type { SectionProps } from "./types.ts";

/**
 * LinkedIn notes and messages from fixed text per step. Each step shows the
 * shipped default as its placeholder (a blank step sends that), and a live
 * example filled with sample values, counted against the step's limit.
 */
export function LinkedInTemplatesSection({ cfg, onDirtyChange }: SectionProps) {
  const server = useMemo(() => linkedinSectionValues(cfg.linkedin), [cfg]);
  const s = useConfigSection({
    id: "linkedin-copy",
    server,
    toRequest: linkedinSectionRequest,
    validate: linkedinSectionErrors,
    onDirtyChange,
  });
  const byModel = s.values.writer === "model";

  return (
    <SectionShell
      {...s.shell}
      lede="The text of every LinkedIn note and message, in place of model-written copy. A blank step uses the default shown in it."
    >
      <Field
        label="Written by"
        hint={
          byModel
            ? "The model writes each note and message. The templates below are kept, unused."
            : "Each note and message is the template for its step, filled in."
        }
      >
        <Select
          value={s.values.writer}
          onChange={(e) => s.set("writer", e.target.value as LinkedInWriterChoice)}
        >
          <option value="template">Templates (default)</option>
          <option value="model">Model</option>
        </Select>
      </Field>
      {LINKEDIN_TEMPLATE_FIELDS.map((field) => {
        const example = linkedinTemplateExample(field, s.values[field.step]);
        return (
          <div key={field.step} className="flex flex-col gap-1">
            <Field
              label={field.label}
              hint={`${field.hint} ${placeholderList(field)}.`}
              error={s.errors[field.step]}
            >
              <Textarea
                value={s.values[field.step]}
                onChange={(e) => s.set(field.step, e.target.value)}
                placeholder={DEFAULT_LINKEDIN_TEMPLATES[field.step]}
                rows={3}
              />
            </Field>
            {"text" in example ? (
              <div className="font-mono text-[11px] text-ink-faint">
                <span>
                  {example.usesDefault ? "Default, e.g.: " : "e.g.: "}
                  {example.text}
                </span>{" "}
                <span className={example.over ? "text-[color:var(--ink-blocked-2)]" : undefined}>
                  · {example.length} / {field.limit} characters
                </span>
              </div>
            ) : (
              <div className="font-mono text-[11px] text-[color:var(--ink-blocked-2)]">
                can't fill {example.missing.map((m) => `{${m}}`).join(", ")}
              </div>
            )}
          </div>
        );
      })}
    </SectionShell>
  );
}
