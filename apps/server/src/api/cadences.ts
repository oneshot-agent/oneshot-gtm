import { getLedger } from "@oneshot-gtm/core";
import type { CadenceView, CadenceStatus } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

function toView(
  row: ReturnType<ReturnType<typeof getLedger>["listAllCadences"]>[number],
): CadenceView {
  return {
    prospectId: row.prospect_id,
    prospectEmail: row.prospect_email,
    prospectName: row.prospect_name,
    prospectCompany: row.prospect_company,
    playName: row.play_name,
    status: row.status as CadenceStatus,
    currentStep: row.current_step,
    enrolledAt: row.enrolled_at,
    nextDueAt: row.next_due_at,
    lastPolledAt: row.last_polled_at,
  };
}

export function listCadences(req: Request): Response {
  const url = new URL(req.url);
  const all = url.searchParams.get("all") === "1";
  const ledger = getLedger();
  const rows = all ? ledger.listAllCadences() : ledger.listActiveCadences();
  return jsonResponse({ cadences: rows.map(toView) }, 200, req);
}

export function getCadence(req: Request, params: Record<string, string>): Response {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  const ledger = getLedger();
  const all = ledger.listAllCadences().filter((c) => c.prospect_id === id);
  if (all.length === 0) return jsonResponse({ error: "no cadences for prospect" }, 404, req);
  return jsonResponse({ cadences: all.map(toView) }, 200, req);
}

export function stopCadence(req: Request, params: Record<string, string>): Response {
  const id = Number.parseInt(params["id"] ?? "", 10);
  if (!Number.isFinite(id)) return jsonResponse({ error: "bad id" }, 400, req);
  const url = new URL(req.url);
  const playName = url.searchParams.get("play");
  const ledger = getLedger();
  const cadences = ledger.listAllCadences().filter((c) => {
    if (c.prospect_id !== id) return false;
    if (playName && c.play_name !== playName) return false;
    return c.status === "active";
  });
  for (const cad of cadences) {
    ledger.setCadenceStatus({
      prospectId: id,
      playName: cad.play_name,
      status: "completed",
    });
  }
  return jsonResponse({ stopped: cadences.length }, 200, req);
}
