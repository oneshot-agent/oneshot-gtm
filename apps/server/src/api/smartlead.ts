import {
  listSmartleadAccounts,
  loadConfig,
  resolveIdentities,
  smartleadApiKey,
} from "@oneshot-gtm/core";
import type { SmartleadAccountView } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

/**
 * POST /api/smartlead/accounts — list the Smartlead workspace's connected
 * mailboxes so /setup can offer them as identities. POST (not GET) on
 * purpose: the body may carry a just-pasted, not-yet-saved API key, and a key
 * must never ride a URL (server logs, proxies, history). Doubles as key
 * validation — a bad key surfaces here before anything is persisted.
 * Responses are sanitized in core (no passwords) and error messages never
 * contain the key.
 */
export async function smartleadAccountsRoute(req: Request): Promise<Response> {
  let pastedKey: string | undefined;
  try {
    const body = (await req.json()) as { apiKey?: string };
    pastedKey = typeof body.apiKey === "string" ? body.apiKey : undefined;
  } catch {
    // empty body is fine — fall back to the stored key
  }
  const key = pastedKey?.trim() || smartleadApiKey();
  if (!key) {
    return jsonResponse(
      { error: "no Smartlead API key — paste one, or save SMARTLEAD_API_KEY on /setup" },
      400,
      req,
    );
  }
  let accounts;
  try {
    accounts = await listSmartleadAccounts(key);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: message }, 502, req);
  }
  const registered = new Set(
    resolveIdentities(loadConfig())
      .filter((i) => i.provider === "smartlead")
      .map((i) => i.address?.trim().toLowerCase())
      .filter(Boolean),
  );
  const views: SmartleadAccountView[] = accounts.map((a) => {
    const view: SmartleadAccountView = Object.assign({}, a, {
      alreadyRegistered: registered.has(a.fromEmail),
    });
    return view;
  });
  return jsonResponse({ accounts: views }, 200, req);
}
