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
      checks: results.map((r) => ({
        name: r.name,
        group: r.group,
        severity: r.severity,
        message: r.message,
        ...(r.hint ? { hint: r.hint } : {}),
        ...(r.approvalRate !== undefined ? { approvalRate: r.approvalRate } : {}),
        ...(r.approved !== undefined ? { approved: r.approved } : {}),
        ...(r.reviewed !== undefined ? { reviewed: r.reviewed } : {}),
        ...(r.threshold !== undefined ? { threshold: r.threshold } : {}),
        ...(r.windowDays !== undefined ? { windowDays: r.windowDays } : {}),
        ...(r.minSamples !== undefined ? { minSamples: r.minSamples } : {}),
        ...(r.deprioritized !== undefined ? { deprioritized: r.deprioritized } : {}),
      })),
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
