import { useMemo, useRef } from "react";
import { Checkbox, Field, Input } from "../primitives/Field.tsx";
import {
  hasPassLine,
  offerSectionErrors,
  offerSectionRequest,
  offerSectionValues,
} from "../../lib/offerSettings.ts";
import { SectionShell } from "./SectionShell.tsx";
import { useConfigSection } from "./useConfigSection.ts";
import type { SectionProps } from "./types.ts";

/**
 * How written offers are retried when they fail the relevance check: how many
 * rewrite rounds, an optional stronger model for them, and (with the decisions
 * check on) the probability an offer needs to pass.
 */
export function OffersSection({ cfg, onDirtyChange }: SectionProps) {
  const server = useMemo(() => offerSectionValues(cfg), [cfg]);
  // offerWriter and offerJudge are whole objects: build them from the latest
  // values (the hook hands toRequest only the dirty keys).
  const latest = useRef(server);
  const s = useConfigSection({
    id: "offers",
    server,
    toRequest: (sent) => offerSectionRequest(latest.current, sent, cfg),
    validate: offerSectionErrors,
    onDirtyChange,
  });
  latest.current = s.values;
  const noModel = !s.values.fallbackModel.trim();

  return (
    <SectionShell {...s.shell} lede="What the writer does when its offers fail the check.">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field
          label="Rewrite rounds"
          error={s.errors.rounds}
          hint="How many times the writer tries again when its offers fail the check."
        >
          <Input
            value={s.values.rounds}
            onChange={(e) => s.set("rounds", e.target.value)}
            inputMode="numeric"
          />
        </Field>
        <Field
          label="Fallback model"
          error={s.errors.fallbackModel}
          hint="Writes the rewrites when none of the first offers passed. Same provider as the model above."
        >
          <Input
            value={s.values.fallbackModel}
            onChange={(e) => s.set("fallbackModel", e.target.value)}
            placeholder="anthropic/claude-sonnet-5-5"
            spellCheck={false}
          />
        </Field>
        {hasPassLine(cfg) && (
          <Field
            label="Pass line"
            error={s.errors.minConfidence}
            hint="An offer passes when the check's probability that it is relevant is at least this."
          >
            <Input
              value={s.values.minConfidence}
              onChange={(e) => s.set("minConfidence", e.target.value)}
              inputMode="decimal"
            />
          </Field>
        )}
      </div>
      <Checkbox
        className="mt-4"
        label="Use the fallback when the first offers are weak"
        checked={s.values.fallbackOnWeak && !noModel}
        disabled={noModel}
        onChange={(e) => s.set("fallbackOnWeak", e.target.checked)}
      />
    </SectionShell>
  );
}
