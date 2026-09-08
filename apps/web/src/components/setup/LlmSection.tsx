import { useMemo } from "react";
import type { LlmProvider } from "@oneshot-gtm/shared-types";
import { Field, Input, Select } from "../primitives/Field.tsx";
import { validateRequired } from "../../lib/setupValidation.ts";
import { KeyStatusLine } from "./KeyStatusLine.tsx";
import { LLM_DEFAULTS, LLM_KEY } from "./constants.ts";
import { SectionShell } from "./SectionShell.tsx";
import { useConfigSection } from "./useConfigSection.ts";
import type { SectionProps } from "./types.ts";

export function LlmSection({ cfg, sources, onDirtyChange }: SectionProps) {
  const server = useMemo(
    () => ({ llmProvider: cfg.llmProvider as LlmProvider, llmModel: cfg.llmModel }),
    [cfg],
  );
  const s = useConfigSection({
    id: "llm",
    server,
    toRequest: (sent) => sent,
    validate: (v) => ({ llmModel: validateRequired(v.llmModel, "a model id") }),
    onDirtyChange,
  });

  const onProvider = (next: LlmProvider): void => {
    const prev = s.values.llmProvider;
    s.set("llmProvider", next);
    // Follow the provider with its default model unless the founder typed
    // their own — a model id from the old provider is never valid on the new one.
    const model = s.values.llmModel.trim();
    if (model.length === 0 || model === LLM_DEFAULTS[prev]) {
      s.set("llmModel", LLM_DEFAULTS[next] ?? "");
    }
  };

  return (
    <SectionShell
      {...s.shell}
      lede="Bring your own key. Swap providers freely; nothing is locked in."
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Provider">
          <Select
            value={s.values.llmProvider}
            onChange={(e) => onProvider(e.target.value as LlmProvider)}
          >
            <option value="openrouter">OpenRouter (recommended)</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </Select>
        </Field>
        <Field label="Model" error={s.errors.llmModel}>
          <Input
            value={s.values.llmModel}
            onChange={(e) => s.set("llmModel", e.target.value)}
            placeholder={LLM_DEFAULTS[s.values.llmProvider]}
            spellCheck={false}
          />
        </Field>
        <KeyStatusLine
          className="md:col-span-2"
          keys={[LLM_KEY[server.llmProvider]]}
          sources={sources}
          note={
            s.values.llmProvider !== server.llmProvider
              ? `after saving, add the ${s.values.llmProvider} key in Credentials`
              : undefined
          }
        />
      </div>
    </SectionShell>
  );
}
