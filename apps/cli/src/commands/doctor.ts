import { runDoctor } from "@oneshot-gtm/doctor";
import { bail, c, fail, header, ok, warn } from "../output.ts";

export async function commandDoctor(): Promise<void> {
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
  process.stdout.write("\n");
  if (failed > 0) {
    bail(`${failed} blocking issue(s). Fix before running paid plays.`);
  }
  if (warned > 0) {
    warn(`${warned} warning(s). Plays will run but features may be missing.`);
    return;
  }
  ok("All systems go.");
}
