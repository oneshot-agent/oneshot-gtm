import { runDoctor } from "@oneshot-gtm/doctor";
import type { DoctorCheck } from "@oneshot-gtm/shared-types";
import { jsonResponse } from "../server.ts";

export async function doctor(req: Request): Promise<Response> {
  const results = await runDoctor();
  const checks: DoctorCheck[] = results.map((r) => {
    const out: DoctorCheck = { name: r.name, severity: r.severity, message: r.message };
    if (r.hint) out.hint = r.hint;
    return out;
  });
  return jsonResponse({ checks }, 200, req);
}
