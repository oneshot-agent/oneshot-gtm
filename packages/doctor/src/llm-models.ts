import { llmProxyOrigin, llmProxyOriginProblem } from "@oneshot-gtm/core";

/** Why a proxy's model list could not be read. */
export type LlmModelsFailure =
  | "unreachable"
  | "timeout"
  | "auth"
  | "status"
  | "bad-body"
  | "insecure";

export type LlmModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; failure: LlmModelsFailure; status?: number; message: string };

/**
 * GET `<origin>/v1/models` on a proxy the user runs and return the model ids,
 * sorted and deduped. The key goes in both auth headers proxies read; it is
 * never part of a returned message.
 */
export async function listLlmModels(
  baseUrl: string,
  key: string,
  timeoutMs: number,
): Promise<LlmModelsResult> {
  const base = llmProxyOrigin(baseUrl);
  const problem = llmProxyOriginProblem(base);
  if (problem) return { ok: false, failure: "insecure", message: `the proxy address ${problem}` };
  let res: Response;
  try {
    res = await fetch(`${base}/v1/models`, {
      headers: key ? { authorization: `Bearer ${key}`, "x-api-key": key } : {},
      signal: AbortSignal.timeout(timeoutMs),
      // Never follow a redirect with the key: x-api-key survives a cross-origin hop.
      redirect: "manual",
    });
  } catch (err) {
    const name = (err as Error).name;
    return name === "TimeoutError" || name === "AbortError"
      ? {
          ok: false,
          failure: "timeout",
          message: `the proxy at ${base} did not answer within ${timeoutMs / 1000}s`,
        }
      : { ok: false, failure: "unreachable", message: `the proxy at ${base} is unreachable` };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      failure: "auth",
      status: res.status,
      message: `the proxy at ${base} refused the key (${res.status})`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      failure: "status",
      status: res.status,
      message: `the proxy at ${base} answered ${res.status} for /v1/models`,
    };
  }
  let rows: unknown;
  try {
    rows = ((await res.json()) as { data?: unknown } | null)?.data;
  } catch {
    rows = undefined;
  }
  if (!Array.isArray(rows)) {
    return { ok: false, failure: "bad-body", message: `the proxy at ${base} sent no model list` };
  }
  const ids = rows
    .map((r) => (r && typeof r === "object" ? (r as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim());
  return { ok: true, models: [...new Set(ids)].toSorted() };
}
