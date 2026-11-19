import type { LlmProvider, SetupRequest } from "@oneshot-gtm/shared-types";
import type { SetupCfg } from "../components/setup/types.ts";
import { validateRequired } from "./setupValidation.ts";

export const LLM_PROVIDERS: readonly LlmProvider[] = ["openrouter", "openai", "anthropic", "proxy"];

/** The LLM section's draft, flattened to primitives. A blank fallback provider is "None". */
export type LlmSectionValues = {
  llmProvider: LlmProvider;
  llmModel: string;
  llmBaseUrl: string;
  fallbackProvider: LlmProvider | "";
  fallbackModel: string;
  /** LLM_PROXY_API_KEY, typed here so Load models can use it before it is saved. Never echoed. */
  proxyKey: string;
};

export function llmSectionValues(
  cfg: Pick<SetupCfg, "llmProvider" | "llmModel" | "llmBaseUrl" | "llmFallback">,
): LlmSectionValues {
  return {
    llmProvider: cfg.llmProvider,
    llmModel: cfg.llmModel,
    llmBaseUrl: cfg.llmBaseUrl ?? "",
    fallbackProvider: cfg.llmFallback?.provider ?? "",
    fallbackModel: cfg.llmFallback?.model ?? "",
    proxyKey: "",
  };
}

/** Whether either route goes through the proxy, and so reads `llmBaseUrl`. */
export function usesProxy(v: Pick<LlmSectionValues, "llmProvider" | "fallbackProvider">): boolean {
  return v.llmProvider === "proxy" || v.fallbackProvider === "proxy";
}

/**
 * `llmFallback` goes out whole whenever either of its fields changed, read from the latest values.
 * An endpoint edit is left out once neither route uses the proxy: the field is hidden then.
 */
export function llmSectionRequest(
  values: LlmSectionValues,
  sent: Partial<LlmSectionValues>,
): SetupRequest {
  const req: SetupRequest = {};
  if (sent.llmProvider !== undefined) req.llmProvider = sent.llmProvider;
  if (sent.llmModel !== undefined) req.llmModel = sent.llmModel.trim();
  if (sent.llmBaseUrl !== undefined && usesProxy(values))
    req.llmBaseUrl = sent.llmBaseUrl.trim() || null;
  if (sent.fallbackProvider !== undefined || sent.fallbackModel !== undefined) {
    req.llmFallback = values.fallbackProvider
      ? { provider: values.fallbackProvider, model: values.fallbackModel.trim() }
      : null;
  }
  if (sent.proxyKey?.trim()) req.secrets = { LLM_PROXY_API_KEY: sent.proxyKey.trim() };
  return req;
}

/** Picking the saved fallback's provider as the primary clears the fallback; another one stays. */
export function fallbackAfterPicking(
  provider: LlmProvider,
  fallback: SetupCfg["llmFallback"],
): Pick<SetupRequest, "llmFallback"> {
  return fallback?.provider === provider ? { llmFallback: null } : {};
}

function validateBaseUrl(raw: string): string | null {
  const v = raw.trim();
  if (v.length === 0) return "enter the proxy's URL";
  try {
    const url = new URL(v);
    if (url.protocol === "http:" || url.protocol === "https:") return null;
  } catch {
    // falls through to the error below
  }
  return "enter a URL like http://127.0.0.1:8317";
}

export function llmSectionErrors(
  v: LlmSectionValues,
): Partial<Record<keyof LlmSectionValues, string | null>> {
  const url = usesProxy(v) ? validateBaseUrl(v.llmBaseUrl) : null;
  const fallbackModel = v.fallbackProvider ? validateRequired(v.fallbackModel, "a model id") : null;
  // Errors show only on edited fields, so the provider pickers repeat what
  // their URL and model need: picking one must block Save on its own.
  return {
    llmProvider: v.llmProvider === "proxy" ? url : null,
    llmModel: validateRequired(v.llmModel, "a model id"),
    llmBaseUrl: url,
    fallbackProvider:
      v.fallbackProvider && v.fallbackProvider === v.llmProvider
        ? "pick a provider other than the one above"
        : ((v.fallbackProvider === "proxy" ? url : null) ??
          (fallbackModel ? "enter the fallback's model id" : null)),
    fallbackModel,
  };
}
