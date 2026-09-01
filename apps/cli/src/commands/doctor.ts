import { runDoctor } from "@oneshot-gtm/doctor";
import { bail, c, emitJson, fail, header, human, ok, setJsonMode, warn } from "../output.ts";

export async function commandDoctor(opts: { json?: boolean } = {}): Promise<void> {
  setJsonMode(opts.json ?? false);
  header("oneshot-gtm doctor");
  const results = await runDoctor();
  let failed = 0;
  let warned = 0;
  for (const r of results) {
    const line = `${r.name.padEnd(22)} ${r.message}${r.hint ? c.dim(`  → ${r.hint}`) : ""}`;
    if (r.severity === "ok") ok(line);
    else if (r.severity === "warn") {
      warned++;
      warn(line);
    } else {
      failed++;
      fail(line);
    }
  }
  human("\n");

  // Emit before the bail below: a failing doctor still owes the caller its
  // document on stdout — the exit code is additive signal, not a substitute.
  if (opts.json) {
    await emitJson({
      command: "doctor",
      ok: failed === 0,
      failed,
      warned,
      checks: results.map((r) => {
        const check: Record<string, unknown> = {
          name: r.name,
          group: r.group,
          severity: r.severity,
          message: r.message,
        };
        if (r.hint) check["hint"] = r.hint;
        if (r.approvalRate !== undefined) check["approvalRate"] = r.approvalRate;
        if (r.approved !== undefined) check["approved"] = r.approved;
        if (r.reviewed !== undefined) check["reviewed"] = r.reviewed;
        if (r.threshold !== undefined) check["threshold"] = r.threshold;
        if (r.windowDays !== undefined) check["windowDays"] = r.windowDays;
        if (r.minSamples !== undefined) check["minSamples"] = r.minSamples;
        if (r.deprioritized !== undefined) check["deprioritized"] = r.deprioritized;
        return check;
      }),
    });
  }

  if (failed > 0) {
    bail(`${failed} blocking issue(s). Fix before running paid plays.`);
  }
  if (warned > 0) {
    warn(`${warned} warning(s). Plays will run but features may be missing.`);
    return;
  }
  ok("All systems go.");
}
