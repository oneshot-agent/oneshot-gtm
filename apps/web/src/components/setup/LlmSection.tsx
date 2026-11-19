import { useLayoutEffect, useMemo, useRef } from "react";
import type { LlmProvider, LlmReasoningEffort } from "@oneshot-gtm/shared-types";
import { Field, Input, Select } from "../primitives/Field.tsx";
import {
  LLM_PROVIDERS,
  LLM_REASONING_EFFORTS,
  llmSectionErrors,
  llmSectionRequest,
  llmSectionValues,
  takesReasoningEffort,
  usesProxy,
} from "../../lib/llmSettings.ts";
import { KeyStatusLine } from "./KeyStatusLine.tsx";
import { hintFor, LLM_DEFAULTS, LLM_KEY, LLM_PROVIDER_LABELS } from "./constants.ts";
import { ProxyModelField } from "./ProxyModelField.tsx";
import { SectionShell } from "./SectionShell.tsx";
import { useConfigSection } from "./useConfigSection.ts";
import type { SectionProps } from "./types.ts";

/**
 * Follow a provider change with its default model unless the founder typed
 * their own. A proxy's ids come from its list, so a switch to or from it
 * always resets.
 */
function nextModel(prev: LlmProvider | "", next: LlmProvider | "", model: string): string | null {
  const typed = model.trim();
  const keep =
    typed.length > 0 &&
    typed !== (prev ? LLM_DEFAULTS[prev] : "") &&
    prev !== "proxy" &&
    next !== "proxy";
  return keep ? null : next ? (LLM_DEFAULTS[next] ?? "") : "";
}

export function LlmSection({ cfg, sources, onDirtyChange }: SectionProps) {
  const server = useMemo(() => llmSectionValues(cfg), [cfg]);
  // `llmFallback` is one object on the server: build it from the latest values
  // (the hook hands toRequest only the dirty keys).
  const latest = useRef(server);
  const s = useConfigSection({
    id: "llm",
    server,
    toRequest: (sent) => llmSectionRequest(latest.current, sent),
    validate: llmSectionErrors,
    onDirtyChange,
  });
  useLayoutEffect(() => {
    latest.current = s.values;
  }, [s.values]);
  const v = s.values;

  const onProvider = (next: LlmProvider): void => {
    s.set("llmProvider", next);
    const model = nextModel(v.llmProvider, next, v.llmModel);
    if (model !== null) s.set("llmModel", model);
    // The fallback must be another provider: drop it rather than keep a pair the server refuses.
    if (v.fallbackProvider === next) {
      s.set("fallbackProvider", "");
      s.set("fallbackModel", "");
    }
  };
  const onFallback = (next: LlmProvider | ""): void => {
    s.set("fallbackProvider", next);
    const model = nextModel(v.fallbackProvider, next, v.fallbackModel);
    if (model !== null) s.set("fallbackModel", model);
  };

  const keys = [LLM_KEY[cfg.llmProvider]];
  if (cfg.llmFallback && cfg.llmFallback.provider !== cfg.llmProvider) {
    keys.push(LLM_KEY[cfg.llmFallback.provider]);
  }
  const changed = [v.llmProvider, v.fallbackProvider].filter(
    (p): p is LlmProvider =>
      p !== "" && p !== cfg.llmProvider && p !== (cfg.llmFallback?.provider ?? ""),
  );

  return (
    <SectionShell
      {...s.shell}
      lede="Bring your own key, or your own proxy. Swap providers freely; nothing is locked in."
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Provider" error={s.errors.llmProvider}>
          <Select value={v.llmProvider} onChange={(e) => onProvider(e.target.value as LlmProvider)}>
            <option value="openrouter">OpenRouter (recommended)</option>
            <option value="openai">{LLM_PROVIDER_LABELS.openai}</option>
            <option value="anthropic">{LLM_PROVIDER_LABELS.anthropic}</option>
            <option value="proxy">{LLM_PROVIDER_LABELS.proxy}</option>
          </Select>
        </Field>
        {v.llmProvider === "proxy" ? (
          <ProxyModelField
            value={v.llmModel}
            onChange={(next) => s.set("llmModel", next)}
            baseUrl={v.llmBaseUrl}
            apiKey={v.proxyKey}
            error={s.errors.llmModel}
          />
        ) : (
          <Field label="Model" error={s.errors.llmModel}>
            <Input
              value={v.llmModel}
              onChange={(e) => s.set("llmModel", e.target.value)}
              placeholder={LLM_DEFAULTS[v.llmProvider]}
              spellCheck={false}
            />
          </Field>
        )}
        {takesReasoningEffort(v) && (
          <Field
            label="Reasoning effort"
            hint="Default sends no effort setting, except for models that need one. Higher reasons longer and costs more."
          >
            <Select
              value={v.reasoningEffort}
              onChange={(e) => s.set("reasoningEffort", e.target.value as LlmReasoningEffort | "")}
            >
              <option value="">Default</option>
              {LLM_REASONING_EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {usesProxy(v) && (
          <>
            <Field
              label="Endpoint URL"
              error={s.errors.llmBaseUrl}
              hint="Where your proxy listens: https, or http on this machine."
            >
              <Input
                value={v.llmBaseUrl}
                onChange={(e) => s.set("llmBaseUrl", e.target.value)}
                placeholder="http://127.0.0.1:8317"
                spellCheck={false}
              />
            </Field>
            {/* The one secret outside Credentials: Load models needs it before the first save. */}
            <Field
              label="Proxy key"
              hint={`${hintFor(sources.LLM_PROXY_API_KEY)} The saved key only goes to the saved URL.`}
            >
              <Input
                type="password"
                value={v.proxyKey}
                onChange={(e) => s.set("proxyKey", e.target.value)}
                placeholder={
                  sources.LLM_PROXY_API_KEY ? "(unchanged)" : "from the proxy's api-keys"
                }
                autoComplete="new-password"
                spellCheck={false}
              />
            </Field>
          </>
        )}
        <Field
          label="If this provider is down, use…"
          error={s.errors.fallbackProvider}
          hint="Optional. Unreachable, rate-limited or refusing the key: the call goes here instead."
        >
          <Select
            value={v.fallbackProvider}
            onChange={(e) => onFallback(e.target.value as LlmProvider | "")}
          >
            <option value="">None</option>
            {LLM_PROVIDERS.filter((p) => p !== v.llmProvider).map((p) => (
              <option key={p} value={p}>
                {LLM_PROVIDER_LABELS[p]}
              </option>
            ))}
          </Select>
        </Field>
        {v.fallbackProvider === "proxy" ? (
          <ProxyModelField
            label="Fallback model"
            value={v.fallbackModel}
            onChange={(next) => s.set("fallbackModel", next)}
            baseUrl={v.llmBaseUrl}
            apiKey={v.proxyKey}
            error={s.errors.fallbackModel}
          />
        ) : (
          v.fallbackProvider && (
            <Field label="Fallback model" error={s.errors.fallbackModel}>
              <Input
                value={v.fallbackModel}
                onChange={(e) => s.set("fallbackModel", e.target.value)}
                placeholder={LLM_DEFAULTS[v.fallbackProvider]}
                spellCheck={false}
              />
            </Field>
          )
        )}
        <KeyStatusLine
          className="md:col-span-2"
          keys={keys}
          sources={sources}
          note={
            changed.length > 0
              ? `after saving, add the ${changed.join(" and ")} key in Credentials`
              : undefined
          }
        />
      </div>
    </SectionShell>
  );
}
