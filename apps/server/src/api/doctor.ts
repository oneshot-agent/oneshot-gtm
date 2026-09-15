import { runDoctor } from "@oneshot-gtm/doctor";
import type { DoctorCheck } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

export async function doctor(req: Request): Promise<Response> {
  // `?refresh=1`: re-read the wallet balance instead of the day-old cached
  // value — the masthead pill's refresh button, for right after a top-up.
  const refreshBalance = new URL(req.url).searchParams.get("refresh") === "1";
  const results = await runDoctor({ refreshBalance });
  const checks: DoctorCheck[] = results.map((r) => {
    const out: DoctorCheck = {
      name: r.name,
      group: r.group,
      severity: r.severity,
      message: r.message,
    };
    if (r.hint) out.hint = r.hint;
    if (r.balanceUsd !== undefined) out.balanceUsd = r.balanceUsd;
    if (r.balanceCheckedAt !== undefined) out.balanceCheckedAt = r.balanceCheckedAt;
    return out;
  });
  return jsonResponse({ checks }, 200, req);
}
