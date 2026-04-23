import open from "open";
import { startServer } from "./server.ts";

// Runtime guard: this binary depends on Bun (bun:sqlite, Bun.serve, Bun.stdin).
// If invoked under plain node, fail loudly with an install hint.
if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  process.stderr.write(
    "oneshot-gtm-server requires the Bun runtime.\n" +
      "Install:  curl -fsSL https://bun.sh/install | bash\n" +
      "Re-run:   bunx oneshot-gtm-server\n",
  );
  process.exit(1);
}

const port = Number.parseInt(process.env["PORT"] ?? "3030", 10);
const noBrowser = process.env["ONESHOT_GTM_NO_BROWSER"] === "1";

const { url, server } = await startServer({ port });

process.stdout.write(`\n  oneshot-gtm dashboard: ${url}\n\n`);

if (!noBrowser) {
  try {
    await open(url);
  } catch {
    // ignore — terminal output already shows the URL.
  }
}

const shutdown = (): void => {
  process.stdout.write("\n  shutting down...\n");
  server.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
