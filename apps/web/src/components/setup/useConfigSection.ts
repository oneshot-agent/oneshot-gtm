import type { SetupRequest } from "@oneshot-gtm/shared-types";
import { api } from "../../api/client.ts";
import type { SectionId } from "./constants.ts";
import { useSectionDraft, type SectionDraft } from "./useSectionDraft.ts";
import { useSectionSave } from "./useSectionSave.ts";
import { useReportDirty, type DirtyReporter } from "./types.ts";

type Primitive = string | number | boolean;

/**
 * Draft + validation + save for a section whose fields live in config.json
 * and go out through `POST /api/setup`. Errors are only reported for dirty
 * keys — a value the server already holds isn't the founder's to fix until
 * they touch it, and Save is inert while nothing is dirty anyway.
 */
export function useConfigSection<T extends Record<string, Primitive>>(opts: {
  id: SectionId;
  server: T;
  initialDraft?: Partial<T>;
  /** Map the dirty keys onto the sparse request. Omitted keys stay untouched. */
  toRequest: (sent: Partial<T>) => SetupRequest;
  validate?: (values: T) => Partial<Record<keyof T, string | null>>;
  onDirtyChange: DirtyReporter;
}): SectionDraft<T> & {
  errors: Partial<Record<keyof T, string>>;
  errorCount: number;
  submit: () => void;
  saving: boolean;
  savedAt: number | null;
  /** Spread into `<SectionShell>`; add `saveDisabled`/`saveTitle` per section. */
  shell: {
    id: SectionId;
    dirtyCount: number;
    errorCount: number;
    savedAt: number | null;
    saving: boolean;
    onSubmit: () => void;
  };
} {
  const draft = useSectionDraft(opts.server, opts.initialDraft);
  const all: Partial<Record<keyof T, string | null>> = opts.validate?.(draft.values) ?? {};
  const errors: Partial<Record<keyof T, string>> = {};
  for (const k of draft.dirtyKeys) {
    const e = all[k];
    if (e) errors[k] = e;
  }
  const errorCount = Object.keys(errors).length;

  const save = useSectionSave<Partial<T>>({
    save: async (sent) => {
      await api.setup(opts.toRequest(sent));
    },
    refetch: [["setup"]],
    alsoInvalidate: [["doctor"], ["home"]],
    onCommitted: (sent) => draft.commit(sent),
  });
  useReportDirty(opts.id, draft.dirty, opts.onDirtyChange);

  const submit = (): void => {
    if (errorCount > 0 || !draft.dirty || save.isPending) return;
    save.run(draft.snapshot);
  };

  return {
    ...draft,
    errors,
    errorCount,
    submit,
    saving: save.isPending,
    savedAt: save.savedAt,
    shell: {
      id: opts.id,
      dirtyCount: draft.dirtyKeys.length,
      errorCount,
      savedAt: save.savedAt,
      saving: save.isPending,
      onSubmit: submit,
    },
  };
}
