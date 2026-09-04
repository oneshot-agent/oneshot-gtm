import { useMemo } from "react";
import { withXEngine, type TriggerView, type XEngine } from "@oneshot-gtm/shared-types";
import { api } from "../../api/client.ts";
import { Field, Select } from "../primitives/Field.tsx";
import { KeyStatusLine } from "./KeyStatusLine.tsx";
import { X_OAUTH_KEYS } from "./constants.ts";
import { SectionShell } from "./SectionShell.tsx";
import { useSectionDraft } from "./useSectionDraft.ts";
import { useSectionSave } from "./useSectionSave.ts";
import { useReportDirty, type SectionProps } from "./types.ts";

/** Engine choice as stored on the x-reposters trigger (not in config.json). */
export function storedXEngine(xTrigger: TriggerView | undefined): XEngine {
  return (
    (xTrigger?.config?.["engine"] as XEngine | undefined) ??
    (xTrigger?.defaultConfig?.["engine"] as XEngine | undefined) ??
    "xapi"
  );
}

/**
 * The one section whose save doesn't go to /api/setup: the engine rides the
 * x-reposters trigger config. withXEngine drops the maxSpendPerRun/knobs
 * overrides on an actual flip so the per-engine defaults re-apply.
 */
export function XSection({
  sources,
  xTrigger,
  onDirtyChange,
}: Pick<SectionProps, "sources" | "onDirtyChange"> & { xTrigger: TriggerView | undefined }) {
  const stored = storedXEngine(xTrigger);
  const server = useMemo(() => ({ engine: stored }), [stored]);
  const draft = useSectionDraft(server);
  const save = useSectionSave<{ engine: XEngine }>({
    save: async (sent) => {
      if (!xTrigger) throw new Error("x-reposters trigger not loaded yet");
      await api.setTriggerConfig(
        "x-reposters",
        withXEngine(xTrigger.config ?? xTrigger.defaultConfig, sent.engine),
      );
    },
    refetch: [["triggers"]],
    onCommitted: (sent) => draft.commit(sent),
  });
  useReportDirty("x", draft.dirty, onDirtyChange);

  return (
    <SectionShell
      id="x"
      lede="Data provider for the x-reposters finder. The engine choice lives on the trigger; the keys are in Credentials."
      dirtyCount={draft.dirtyKeys.length}
      savedAt={save.savedAt}
      saving={save.isPending}
      onSubmit={() => save.run({ engine: draft.values.engine })}
      saveDisabled={!xTrigger}
      saveTitle={!xTrigger ? "trigger list still loading" : undefined}
      footerNote="applies to the x-reposters trigger"
    >
      <div className="grid grid-cols-1 gap-4">
        <Field
          label="Data provider"
          hint="Both bill per record returned. Switching resets the trigger's spend ceiling and harvest knobs to the new engine's defaults; fine-tune in the /queue trigger editor."
        >
          <Select
            value={draft.values.engine}
            onChange={(e) => draft.set("engine", e.target.value as XEngine)}
          >
            <option value="twitterapiio">twitterapi.io — ~$0.25/run, third-party scraper</option>
            <option value="xapi">X API (first-party) — ~$5/run, licensed, OAuth1</option>
          </Select>
        </Field>
        <KeyStatusLine
          keys={stored === "xapi" ? X_OAUTH_KEYS : ["TWITTERAPI_IO_KEY"]}
          sources={sources}
          note={
            draft.values.engine !== stored
              ? "after saving, add this engine's keys in Credentials"
              : undefined
          }
        />
        {xTrigger && (
          <p className="font-mono text-[11px] text-ink-muted">
            x-reposters: {xTrigger.enabled ? "enabled" : "disabled"} ·{" "}
            {xTrigger.ready ? (
              <span className="text-ink-cream-2">ready</span>
            ) : (
              <span>not ready — {xTrigger.notReadyReason}</span>
            )}
            {draft.dirty && " · engine change applies on Save"}
          </p>
        )}
      </div>
    </SectionShell>
  );
}
