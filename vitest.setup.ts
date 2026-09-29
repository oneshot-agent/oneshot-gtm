// Isolate each test file before config.ts resolves workspace paths.
// Import only Node built-ins here so config cannot load before the env is set.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "oneshot-gtm-test-"));
process.env["ONESHOT_GTM_HOME"] = dir;
// The shared DB lives outside the workspace home and needs its own redirect.
process.env["ONESHOT_GTM_SHARED"] = join(dir, "shared");

// Prevent tests from posting telemetry to production. Telemetry tests override this.
process.env["ONESHOT_GTM_TELEMETRY"] = "0";

process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort.
  }
});
