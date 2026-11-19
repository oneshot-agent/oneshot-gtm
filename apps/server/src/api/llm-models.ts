import { demoMode, loadConfig } from "@oneshot-gtm/core";
import { listLlmModels } from "@oneshot-gtm/doctor";
import { proxyBaseUrl } from "@oneshot-gtm/intel";
import type { LlmModelsResponse } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";
import { SetupValidationError, validateLlmBaseUrl } from "./setup.ts";

const MODELS_TIMEOUT_MS = 10_000;

function reply(out: LlmModelsResponse, status: number, req: Request): Response {
  return jsonResponse(out, status, req);
}

/**
 * POST /api/setup/llm-models, body `{ baseUrl?, key? }`. Lists the models a
 * proxy serves, for the /setup model picker. A value left out falls back to
 * the saved base URL and LLM_PROXY_API_KEY. The key is never logged or echoed.
 */
export async function llmModelsRoute(req: Request): Promise<Response> {
  if (demoMode()) return reply({ error: "The demo is read-only." }, 403, req);
  let b: Record<string, unknown> = {};
  try {
    const parsed: unknown = await req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      b = parsed as Record<string, unknown>;
  } catch {
    // no body: use the saved values
  }
  const saved = loadConfig().llmBaseUrl?.trim() ?? "";
  let raw: string;
  try {
    raw = typeof b.baseUrl === "string" && b.baseUrl.trim() ? validateLlmBaseUrl(b.baseUrl) : saved;
  } catch (err) {
    if (err instanceof SetupValidationError) return reply({ error: err.message }, 400, req);
    throw err;
  }
  if (!raw) return reply({ error: "Enter the proxy's address first." }, 400, req);
  const base = proxyBaseUrl(raw);
  // The saved key goes only to the saved proxy, so a request cannot send it elsewhere.
  const savedKey = saved && proxyBaseUrl(saved) === base ? process.env.LLM_PROXY_API_KEY : "";
  const key = (typeof b.key === "string" && b.key.trim()) || savedKey?.trim() || "";

  const out = await listLlmModels(base, key, MODELS_TIMEOUT_MS);
  if (out.ok) return reply({ models: out.models }, 200, req);
  const error = `${out.message.charAt(0).toUpperCase()}${out.message.slice(1)}.`;
  return reply({ error }, out.failure === "auth" ? out.status! : 502, req);
}
