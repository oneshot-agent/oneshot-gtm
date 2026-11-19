import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client.ts";
import { Button } from "../primitives/Button.tsx";
import { Field, Input, Select } from "../primitives/Field.tsx";

export type ProxyModels = { models: string[] } | { error: string };

/**
 * Ask the proxy what it serves. A blank URL or key is left out, so the server
 * uses the saved one. An empty list counts as a failure: there is nothing to pick.
 */
export async function loadProxyModels(input: {
  baseUrl?: string;
  key?: string;
}): Promise<ProxyModels> {
  const baseUrl = input.baseUrl?.trim();
  const key = input.key?.trim();
  try {
    const res = await api.llmModels({
      ...(baseUrl ? { baseUrl } : {}),
      ...(key ? { key } : {}),
    });
    const models = [...new Set(res.models)];
    return models.length > 0 ? { models } : { error: "the proxy lists no models" };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * The model id for a proxy: a dropdown once its list has loaded, free text
 * until then or when loading failed. A saved id the list lacks stays selectable.
 */
export function ProxyModelPicker({
  value,
  onChange,
  loaded,
  loading,
  canLoad,
  onLoad,
  label = "Model",
  error,
  hint,
}: {
  value: string;
  onChange: (next: string) => void;
  loaded: ProxyModels | null;
  loading: boolean;
  canLoad: boolean;
  onLoad: () => void;
  label?: string;
  error?: string | null;
  hint?: string;
}) {
  const models = loaded && "models" in loaded ? loaded.models : null;
  const loadError = loaded && "error" in loaded ? loaded.error : null;
  const options = models && value && !models.includes(value) ? [value, ...models] : models;
  return (
    <Field
      label={label}
      error={error ?? (loadError ? `couldn't load models · ${loadError}` : null)}
      hint={hint}
    >
      <div className="flex gap-2">
        {options ? (
          <Select value={value} onChange={(e) => onChange(e.target.value)}>
            {!value && <option value="">Pick a model</option>}
            {options.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="claude-sonnet-5-5"
            spellCheck={false}
          />
        )}
        <Button
          type="button"
          variant="secondary"
          disabled={!canLoad || loading}
          onClick={onLoad}
          className="shrink-0"
        >
          {loading ? "Loading…" : models ? "Reload" : "Load models"}
        </Button>
      </div>
    </Field>
  );
}

/** ProxyModelPicker with its own load state. */
export function ProxyModelField({
  baseUrl,
  apiKey,
  ...rest
}: Omit<Parameters<typeof ProxyModelPicker>[0], "loaded" | "loading" | "canLoad" | "onLoad"> & {
  baseUrl: string;
  /** A key typed but not saved yet; blank uses the saved one. */
  apiKey?: string;
}) {
  const [loaded, setLoaded] = useState<ProxyModels | null>(null);
  const load = useMutation({
    mutationFn: () => loadProxyModels({ baseUrl, key: apiKey }),
    onSuccess: setLoaded,
  });
  return (
    <ProxyModelPicker
      {...rest}
      loaded={loaded}
      loading={load.isPending}
      canLoad={baseUrl.trim().length > 0}
      onLoad={() => load.mutate()}
    />
  );
}
