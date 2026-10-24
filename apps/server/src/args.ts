// Command-line arguments for `oneshot-gtm-server`. The binary used to read
// only PORT and ignore argv, so `--port 3099` silently bound 3030.

export const SERVER_USAGE = `Usage: oneshot-gtm-server [--port <n>] [--no-browser]

  --port <n>     Port for the dashboard. Default: the PORT environment
                 variable, then the workspace's registered port, then 3030.
  --no-browser   Don't open the dashboard in a browser.
  -h, --help     Show this help.
`;

export type ServerArgs =
  | { kind: "run"; port: number; noBrowser: boolean }
  | { kind: "help" }
  | { kind: "error"; message: string };

function parsePort(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return n >= 1 && n <= 65535 ? n : null;
}

/**
 * Port precedence: `--port`, then PORT, then `registeredPort()` (the
 * workspace's port from the registry, called only when needed).
 */
export function parseServerArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  registeredPort: () => number,
): ServerArgs {
  let flagPort: number | null = null;
  let noBrowser = env["ONESHOT_GTM_NO_BROWSER"] === "1";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "--no-browser") {
      noBrowser = true;
      continue;
    }
    if (arg === "--port" || arg.startsWith("--port=")) {
      const raw = arg === "--port" ? argv[++i] : arg.slice("--port=".length);
      flagPort = parsePort(raw);
      if (flagPort === null) {
        return {
          kind: "error",
          message: `--port needs a number from 1 to 65535, got ${raw ?? "nothing"}`,
        };
      }
      continue;
    }
    return { kind: "error", message: `unknown argument: ${arg}` };
  }

  if (flagPort !== null) return { kind: "run", port: flagPort, noBrowser };
  const rawEnv = env["PORT"];
  if (rawEnv !== undefined && rawEnv !== "") {
    const envPort = parsePort(rawEnv);
    if (envPort === null) {
      return { kind: "error", message: `PORT needs a number from 1 to 65535, got ${rawEnv}` };
    }
    return { kind: "run", port: envPort, noBrowser };
  }
  return { kind: "run", port: registeredPort(), noBrowser };
}
