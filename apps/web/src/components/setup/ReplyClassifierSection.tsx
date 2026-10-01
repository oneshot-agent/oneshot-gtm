import { useMemo, useRef } from "react";
import type { SetupRequest } from "@oneshot-gtm/shared-types";
import { Field, Input, Select } from "../primitives/Field.tsx";
import { SectionShell } from "./SectionShell.tsx";
import { useConfigSection } from "./useConfigSection.ts";
import type { SectionProps } from "./types.ts";

/**
 * How inbound replies get their intent label. `llm` is the triage prompt on
 * the LLM provider above; `decisions` sends each reply to a typed decisions
 * model on OpenRouter (needs OPENROUTER_API_KEY), falling back to `llm` on any
 * failure.
 */
export function ReplyClassifierSection({ cfg, onDirtyChange }: SectionProps) {
  const server = useMemo(
    () => ({
      engine: cfg.replyClassifier?.engine ?? "llm",
      model: cfg.replyClassifier?.model ?? "",
      minConfidence: String(cfg.replyClassifier?.minConfidence ?? 0.5),
    }),
    [cfg],
  );
  // The classifier is one object: send it whole whenever any part changed,
  // read from the latest values (the hook hands toRequest only the dirty keys).
  const latest = useRef(server);
  const s = useConfigSection({
    id: "replies",
    server,
    toRequest: (): SetupRequest => {
      const v = latest.current;
      if (v.engine === "llm") return { replyClassifier: null };
      return {
        replyClassifier: {
          engine: "decisions",
          model: v.model.trim(),
          minConfidence: Number(v.minConfidence),
        },
      };
    },
    validate: (v) => {
      const n = Number(v.minConfidence);
      // Errors show only on dirty keys, so a switch to decisions alone must
      // carry the missing-model error on engine too.
      const needsModel = v.engine === "decisions" && !v.model.trim();
      return {
        engine: needsModel ? "Set a decisions model id below." : null,
        model: needsModel ? "Needs a model id." : null,
        minConfidence:
          v.minConfidence.trim() === "" || !Number.isFinite(n) || n < 0 || n > 1
            ? "A number from 0 to 1."
            : null,
      };
    },
    onDirtyChange,
  });
  latest.current = s.values;

  return (
    <SectionShell
      {...s.shell}
      lede="How each reply's intent label is decided. Low-confidence labels are flagged for you to check."
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field
          label="Engine"
          error={s.errors.engine}
          hint="decisions needs OPENROUTER_API_KEY; it falls back to llm."
        >
          <Select
            value={s.values.engine}
            onChange={(e) => s.set("engine", e.target.value as "llm" | "decisions")}
          >
            <option value="llm">llm: triage prompt (default)</option>
            <option value="decisions">decisions: typed decisions model</option>
          </Select>
        </Field>
        <Field label="Decisions model" error={s.errors.model} hint="An OpenRouter model id.">
          <Input
            value={s.values.model}
            onChange={(e) => s.set("model", e.target.value)}
            disabled={s.values.engine !== "decisions"}
            spellCheck={false}
          />
        </Field>
        <Field
          label="Review below"
          error={s.errors.minConfidence}
          hint="Confidence under this flags the label for review."
        >
          <Input
            value={s.values.minConfidence}
            onChange={(e) => s.set("minConfidence", e.target.value)}
            disabled={s.values.engine !== "decisions"}
            inputMode="decimal"
          />
        </Field>
      </div>
    </SectionShell>
  );
}
