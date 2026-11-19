import { useMutation } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { api } from "../../api/client.ts";
import { Button } from "../primitives/Button.tsx";
import { Field, Input, Select } from "../primitives/Field.tsx";

export type ProxyModels = { models: string[] } | { error: string };

/** The endpoint and key a list was loaded with, trimmed as they are sent. */
export type ProxyModelsRequest = { baseUrl: string; key: string };
export type LoadedProxyModels = { request: ProxyModelsRequest; result: ProxyModels };

export function proxyModelsRequest(baseUrl: string, key = ""): ProxyModelsRequest {
  return { baseUrl: baseUrl.trim(), key: key.trim() };
}

function sameRequest(a: ProxyModelsRequest | undefined, b: ProxyModelsRequest): boolean {
  return a?.baseUrl === b.baseUrl && a.key === b.key;
}

/** A list shows only while the endpoint and key it came from are still the ones typed. */
export function loadedFor(
  loaded: LoadedProxyModels | null,
  current: ProxyModelsRequest,
): ProxyModels | null {
  return loaded && sameRequest(loaded.request, current) ? loaded.result : null;
}

const CUSTOM_MODEL = "\u0000custom";

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
 * until then, when loading failed, or after "Custom model…". A saved id the
 * list lacks stays selectable.
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
  const [custom, setCustom] = useState(false);
  const models = loaded && "models" in loaded ? loaded.models : null;
  const loadError = loaded && "error" in loaded ? loaded.error : null;
  const options =
    models && !custom && value && !models.includes(value) ? [value, ...models] : models;
  return (
    <Field
      label={label}
      error={error ?? (loadError ? `couldn't load models · ${loadError}` : null)}
      hint={hint}
    >
      <div className="flex gap-2">
        {options && !custom ? (
          <Select
            value={value}
            onChange={(e) =>
              e.target.value === CUSTOM_MODEL ? setCustom(true) : onChange(e.target.value)
            }
          >
            {!value && <option value="">Pick a model</option>}
            {options.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            <option value={CUSTOM_MODEL}>Custom model…</option>
          </Select>
        ) : (
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="claude-sonnet-5-5"
            spellCheck={false}
          />
        )}
        {models && custom ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setCustom(false)}
            className="shrink-0"
          >
            Show list
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            disabled={!canLoad || loading}
            onClick={onLoad}
            className="shrink-0"
          >
            {loading ? "Loading…" : models ? "Reload" : "Load models"}
          </Button>
        )}
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
  const [loaded, setLoaded] = useState<LoadedProxyModels | null>(null);
  const current = proxyModelsRequest(baseUrl, apiKey);
  const latest = useRef(current);
  useLayoutEffect(() => {
    latest.current = { baseUrl: current.baseUrl, key: current.key };
  }, [current.baseUrl, current.key]);
  // An edited endpoint or key drops the list; a reply for the old pair is dropped too.
  if (loaded && !sameRequest(loaded.request, current)) setLoaded(null);
  const load = useMutation({
    mutationFn: (request: ProxyModelsRequest) => loadProxyModels(request),
    onSuccess: (result, request) => {
      if (sameRequest(request, latest.current)) setLoaded({ request, result });
    },
  });
  return (
    <ProxyModelPicker
      {...rest}
      loaded={loadedFor(loaded, current)}
      loading={load.isPending && sameRequest(load.variables, current)}
      canLoad={current.baseUrl.length > 0}
      onLoad={() => load.mutate(current)}
    />
  );
}
